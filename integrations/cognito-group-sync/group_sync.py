"""Optional Cognito administration integration, separate from application auth."""

import json
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from types import MappingProxyType

_GROUP = re.compile(r"[A-Za-z0-9][A-Za-z0-9_+=,.@-]{0,127}\Z")
_DOMAIN_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
_LOCAL = re.compile(r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}\Z")


@dataclass(frozen=True)
class Policy:
    managed_groups: frozenset
    email_groups: object
    domain_groups: object


def _domain(value):
    if not isinstance(value, str) or len(value) > 253:
        raise ValueError("invalid policy domain")
    result = value.lower()
    parts = result.split(".")
    if len(parts) < 2 or any(not _DOMAIN_LABEL.fullmatch(part) for part in parts):
        raise ValueError("invalid policy domain")
    return result


def _email(value):
    if not isinstance(value, str) or len(value) > 254 or value.count("@") != 1:
        raise ValueError("invalid policy email")
    local, domain = value.split("@")
    if not _LOCAL.fullmatch(local) or local.startswith(".") or local.endswith(".") or ".." in local:
        raise ValueError("invalid policy email")
    return local.lower() + "@" + _domain(domain)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate policy key")
        result[key] = value
    return result


def parse_policy(value):
    """Validate strict, fail-closed policy; do not include input values in errors."""
    if isinstance(value, str):
        if len(value.encode("utf-8")) > 4096:
            raise ValueError("policy exceeds standard parameter size")
        try:
            value = json.loads(value, object_pairs_hook=_unique_object)
        except (ValueError, TypeError):
            raise ValueError("invalid policy JSON") from None
    fields = {"managedGroups", "emailGroups", "domainGroups", "requireVerifiedEmail",
              "requireEnabledUser", "exactEmailOverridesDomain"}
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError("invalid policy fields")
    for flag in ("requireVerifiedEmail", "requireEnabledUser", "exactEmailOverridesDomain"):
        if value[flag] is not True:
            raise ValueError("policy safety flags must be true")
    groups = value["managedGroups"]
    if (not isinstance(groups, list) or not 1 <= len(groups) <= 16
            or any(not isinstance(g, str) or not _GROUP.fullmatch(g) for g in groups)
            or len(set(groups)) != len(groups)):
        raise ValueError("invalid managed groups")
    managed = frozenset(groups)

    def assignments(mapping, canonical):
        if not isinstance(mapping, dict):
            raise ValueError("invalid policy assignments")
        result = {}
        for key, targets in mapping.items():
            normalized = canonical(key)
            if normalized in result:
                raise ValueError("duplicate normalized policy assignment")
            if (not isinstance(targets, list) or any(not isinstance(g, str) for g in targets)
                    or len(set(targets)) != len(targets) or not set(targets) <= managed):
                raise ValueError("invalid assignment groups")
            result[normalized] = frozenset(targets)
        return MappingProxyType(result)

    return Policy(managed, assignments(value["emailGroups"], _email),
                  assignments(value["domainGroups"], _domain))


def _attributes(user):
    attributes = user.get("UserAttributes", user.get("Attributes", []))
    if not isinstance(attributes, list):
        return {}
    result = {}
    for attribute in attributes:
        if not isinstance(attribute, dict):
            return {}
        name = attribute.get("Name")
        if not isinstance(name, str) or name in result:
            return {}
        result[name] = attribute.get("Value")
    return result


def desired_groups(user, policy):
    """Return managed grants for an enabled user with one verified ASCII email."""
    if user.get("Enabled") is not True:
        return set()
    attributes = _attributes(user)
    if attributes.get("email_verified") != "true":
        return set()
    try:
        email = _email(attributes.get("email"))
    except ValueError:
        return set()
    if email in policy.email_groups:
        return set(policy.email_groups[email])
    return set(policy.domain_groups.get(email.split("@")[1], ()))


class SyncError(RuntimeError):
    """Sanitized operational failure."""


def _pages(call, key, token_key, **kwargs):
    """Explicit pagination lets incomplete or unexpectedly large reads fail closed."""
    token = None
    seen = set()
    items = []
    for _ in range(100):
        request = dict(kwargs)
        if token is not None:
            request[token_key] = token
        response = call(**request)
        if not isinstance(response, dict) or not isinstance(response.get(key), list):
            raise SyncError("invalid_snapshot")
        items.extend(response[key])
        if len(items) > 5000:
            raise SyncError("snapshot_limit")
        token = response.get(token_key)
        if token is None:
            return items
        if not isinstance(token, str) or not token or token in seen:
            raise SyncError("invalid_pagination")
        seen.add(token)
    raise SyncError("pagination_limit")


def _username(user):
    name = user.get("Username") if isinstance(user, dict) else None
    if not isinstance(name, str) or not name:
        raise SyncError("invalid_user_snapshot")
    return name


def _safe_group(client, pool_id, group):
    response = client.get_group(UserPoolId=pool_id, GroupName=group)
    metadata = response.get("Group", {})
    if metadata.get("GroupName") != group or metadata.get("RoleArn"):
        raise SyncError("managed_group_must_not_have_iam_role")


def _fresh_user(client, pool_id, name):
    try:
        result = client.admin_get_user(UserPoolId=pool_id, Username=name)
    except Exception as error:
        # ClientError.response is structured; never include its raw message in output.
        if getattr(error, "response", {}).get("Error", {}).get("Code") == "UserNotFoundException":
            return None
        raise
    if _username(result) != name:
        raise SyncError("user_identity_mismatch")
    return result


def _memberships(client, pool_id, name, policy):
    records = _pages(client.admin_list_groups_for_user, "Groups", "NextToken",
                     UserPoolId=pool_id, Username=name, Limit=60)
    groups = set()
    for record in records:
        group = record.get("GroupName") if isinstance(record, dict) else None
        if not isinstance(group, str) or not group or group in groups:
            raise SyncError("invalid_membership_snapshot")
        groups.add(group)
    return groups & policy.managed_groups


def reconcile(client, pool_id, policy, dry_run=True):
    """Reconcile designated groups; all initial and preflight reads precede writes."""
    if not isinstance(policy, Policy) or not isinstance(dry_run, bool):
        raise ValueError("validated policy and boolean dry_run required")
    counts = {"usersScanned": 0, "usersChanged": 0, "additionsPlanned": 0,
              "removalsPlanned": 0, "membershipsAdded": 0, "membershipsRemoved": 0}
    stage = "snapshot_failed"
    try:
        users = {}
        for item in _pages(client.list_users, "Users", "PaginationToken",
                           UserPoolId=pool_id, Limit=60):
            name = _username(item)
            if name in users:
                raise SyncError("duplicate_user_snapshot")
            users[name] = item
        current = {}
        for group in sorted(policy.managed_groups):
            _safe_group(client, pool_id, group)
            for item in _pages(client.list_users_in_group, "Users", "NextToken",
                               UserPoolId=pool_id, GroupName=group, Limit=60):
                name = _username(item)
                # ListUsers can lag group membership; include these users in preflight.
                users.setdefault(name, item)
                memberships = current.setdefault(name, set())
                if group in memberships:
                    raise SyncError("duplicate_membership_snapshot")
                memberships.add(group)
        if len(users) > 5000:
            raise SyncError("snapshot_limit")
        counts["usersScanned"] = len(users)
        candidates = [name for name, item in users.items()
                      if desired_groups(item, policy) != current.get(name, set())]
        plans = []
        # Finish every candidate's fresh paginated snapshot before the first mutation.
        for name in sorted(candidates):
            item = _fresh_user(client, pool_id, name)
            if item is None:
                continue
            memberships = _memberships(client, pool_id, name, policy)
            desired = desired_groups(item, policy)
            if desired != memberships:
                plans.append(name)
                counts["additionsPlanned"] += len(desired - memberships)
                counts["removalsPlanned"] += len(memberships - desired)
        counts["usersChanged"] = len(plans)
        if dry_run:
            return counts

        stage = "reconciliation_failed"
        for name in plans:
            item = _fresh_user(client, pool_id, name)
            if item is None:
                continue
            memberships = _memberships(client, pool_id, name, policy)
            desired = desired_groups(item, policy)

            def remove_obsolete(actual, wanted):
                for group in sorted(actual - wanted):
                    client.admin_remove_user_from_group(UserPoolId=pool_id, Username=name, GroupName=group)
                    counts["membershipsRemoved"] += 1

            remove_obsolete(memberships, desired)
            for group in sorted(desired - memberships):
                _safe_group(client, pool_id, group)
                # Recheck each grant, including changes after removals or another grant.
                item = _fresh_user(client, pool_id, name)
                if item is None:
                    break
                fresh_desired = desired_groups(item, policy)
                fresh_memberships = _memberships(client, pool_id, name, policy)
                remove_obsolete(fresh_memberships, fresh_desired)
                if group in fresh_desired and group not in fresh_memberships:
                    client.admin_add_user_to_group(UserPoolId=pool_id, Username=name, GroupName=group)
                    counts["membershipsAdded"] += 1
        return counts
    except Exception as error:
        failure = SyncError(str(error) if isinstance(error, SyncError) else stage)
        failure.counts = counts
        raise failure from None


@lru_cache(maxsize=1)
def _clients():
    # AWS Lambda Python runtime supplies these; pure policy tests need neither.
    import boto3
    from botocore.config import Config

    config = Config(connect_timeout=2, read_timeout=3,
                    retries={"total_max_attempts": 2, "mode": "standard"})
    return (boto3.client("cognito-idp", config=config), boto3.client("ssm", config=config))


class _BudgetClient:
    def __init__(self, client, context):
        self.client = client
        self.context = context
        self.calls = 0

    def __getattr__(self, name):
        operation = getattr(self.client, name)

        def call(**kwargs):
            # Allow the bounded SDK attempts to finish before Lambda's hard timeout.
            if self.context.get_remaining_time_in_millis() < 15000 or self.calls >= 2000:
                raise SyncError("execution_budget_exhausted")
            self.calls += 1
            return operation(**kwargs)

        return call


def lambda_handler(event, context):
    """Read encrypted deployment policy; never log provider bodies or identities."""
    try:
        pool_id = os.environ["USER_POOL_ID"]
        parameter_name = os.environ["POLICY_PARAMETER_NAME"]
        dry_run_value = os.environ.get("DRY_RUN", "true")
        if dry_run_value not in ("true", "false") or not pool_id or not parameter_name:
            raise ValueError("invalid integration configuration")
        dry_run = dry_run_value == "true"
        client, ssm = _clients()
        parameter = _BudgetClient(ssm, context).get_parameter(
            Name=parameter_name, WithDecryption=True)["Parameter"]
        if parameter.get("Type") != "SecureString":
            raise ValueError("policy parameter must be encrypted")
        policy = parse_policy(parameter["Value"])
        counts = reconcile(_BudgetClient(client, context), pool_id, policy, dry_run=dry_run)
        print(json.dumps({"event": "group_sync_complete", "dryRun": dry_run, **counts}))
        return counts
    except Exception as error:
        reason = str(error) if isinstance(error, SyncError) else "configuration_or_provider_failure"
        print(json.dumps({"event": "group_sync_failed", "reason": reason,
                          **getattr(error, "counts", {})}))
        raise SyncError(reason) from None
