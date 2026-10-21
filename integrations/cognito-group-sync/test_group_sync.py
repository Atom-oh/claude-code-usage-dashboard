"""Offline behavior tests; no AWS credentials, SDK installation or network needed."""

import copy
import io
import json
import os
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import group_sync
from group_sync import SyncError, desired_groups, lambda_handler, parse_policy, reconcile


def policy_document():
    return {
        "managedGroups": ["portal-demo", "portal-admin", "portal-editor"],
        "emailGroups": {
            "guest@example.net": ["portal-demo"],
            "owner@example.org": ["portal-admin"],
            "excluded@example.org": [],
        },
        "domainGroups": {"example.org": ["portal-editor"]},
        "requireVerifiedEmail": True,
        "requireEnabledUser": True,
        "exactEmailOverridesDomain": True,
    }


def user(name, email, *, enabled=True, verified="true"):
    return {
        "Username": name,
        "Enabled": enabled,
        "UserStatus": "CONFIRMED",
        "Attributes": [
            {"Name": "sub", "Value": "sub-" + name},
            {"Name": "email", "Value": email},
            {"Name": "email_verified", "Value": verified},
        ],
    }


class PolicyTests(unittest.TestCase):
    def test_exact_email_overrides_domain_including_explicit_exclusion(self):
        policy = parse_policy(policy_document())
        self.assertEqual(desired_groups(user("owner", "owner@example.org"), policy), {"portal-admin"})
        self.assertEqual(desired_groups(user("excluded", "excluded@example.org"), policy), set())
        self.assertEqual(desired_groups(user("staff", "staff@example.org"), policy), {"portal-editor"})
        self.assertEqual(desired_groups(user("guest", "guest@example.net"), policy), {"portal-demo"})

    def test_domain_is_complete_case_insensitive_ascii_match(self):
        policy = parse_policy(policy_document())
        self.assertEqual(desired_groups(user("staff", "STAFF@EXAMPLE.ORG"), policy), {"portal-editor"})
        for address in ("staff@sub.example.org", "staff@example.org.evil.test", "staff@evil-example.org",
                        "staff@exаmple.org", " staff@example.org", "staff@@example.org"):
            with self.subTest(address=address):
                self.assertEqual(desired_groups(user("staff", address), policy), set())

    def test_disabled_unverified_missing_or_ambiguous_email_cannot_qualify(self):
        policy = parse_policy(policy_document())
        for kwargs in ({"enabled": False}, {"enabled": "true"}, {"verified": "false"}, {"verified": True}):
            self.assertEqual(desired_groups(user("owner", "owner@example.org", **kwargs), policy), set())
        missing = user("owner", "owner@example.org")
        missing["Attributes"] = []
        self.assertEqual(desired_groups(missing, policy), set())
        duplicate = user("owner", "owner@example.org")
        duplicate["Attributes"].append({"Name": "email", "Value": "another@example.org"})
        self.assertEqual(desired_groups(duplicate, policy), set())

    def test_invalid_policy_is_rejected_before_use(self):
        mutations = [
            lambda p: p.update(managedGroups=[]),
            lambda p: p.update(managedGroups=["portal-admin", "portal-admin"]),
            lambda p: p.update(managedGroups=["not a group"]),
            lambda p: p["emailGroups"].update({"owner@example.org": ["unmanaged"]}),
            lambda p: p["emailGroups"].update({"OWNER@EXAMPLE.ORG": ["portal-demo"]}),
            lambda p: p["emailGroups"].update({"not-an-email": []}),
            lambda p: p["domainGroups"].update({"*.example.org": ["portal-editor"]}),
            lambda p: p["domainGroups"].update({"example.org.evil.test/": ["portal-editor"]}),
            lambda p: p.update(requireVerifiedEmail=False),
            lambda p: p.update(requireEnabledUser=False),
            lambda p: p.update(exactEmailOverridesDomain=False),
            lambda p: p.update(requireEnabledUser=1),
            lambda p: p.update(unknownOption=True),
            lambda p: p.pop("requireVerifiedEmail"),
        ]
        for mutate in mutations:
            document = copy.deepcopy(policy_document())
            mutate(document)
            with self.subTest(document=document):
                with self.assertRaises(ValueError):
                    parse_policy(document)

    def test_json_duplicate_keys_are_rejected(self):
        with self.assertRaises(ValueError):
            parse_policy('{"managedGroups":[],"managedGroups":["portal-admin"]}')


class FakeApiError(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}
        super().__init__("sensitive upstream message must not escape")


class FakeCognito:
    """Cognito API boundary fake with paginated reads and real membership state."""

    def __init__(self, users, memberships=None):
        self.users = {item["Username"]: copy.deepcopy(item) for item in users}
        self.memberships = {name: set(groups) for name, groups in (memberships or {}).items()}
        self.roles = {}
        self.events = []
        self.read_counts = {}
        self.before_call = None

    def _call(self, operation, args):
        assert args["UserPoolId"] == "test_pool"
        self.events.append((operation, copy.deepcopy(args)))
        self.read_counts[operation] = self.read_counts.get(operation, 0) + 1
        if self.before_call:
            self.before_call(operation, args, self.read_counts[operation])

    def _page(self, items, key, args, token_key):
        index = int(args.get(token_key, 0))
        result = {key: copy.deepcopy(items[index:index + 1])}
        if index + 1 < len(items):
            result[token_key] = str(index + 1)
        return result

    def list_users(self, **args):
        self._call("list_users", args)
        return self._page(list(self.users.values()), "Users", args, "PaginationToken")

    def get_group(self, **args):
        self._call("get_group", args)
        group = {"GroupName": args["GroupName"]}
        if self.roles.get(args["GroupName"]):
            group["RoleArn"] = self.roles[args["GroupName"]]
        return {"Group": group}

    def list_users_in_group(self, **args):
        self._call("list_users_in_group", args)
        users = [self.users[name] for name, groups in self.memberships.items()
                 if args["GroupName"] in groups and name in self.users]
        return self._page(users, "Users", args, "NextToken")

    def admin_get_user(self, **args):
        self._call("admin_get_user", args)
        if args["Username"] not in self.users:
            raise FakeApiError("UserNotFoundException")
        result = copy.deepcopy(self.users[args["Username"]])
        result["UserAttributes"] = result.pop("Attributes")
        return result

    def admin_list_groups_for_user(self, **args):
        self._call("admin_list_groups_for_user", args)
        groups = [{"GroupName": group} for group in sorted(self.memberships.get(args["Username"], set()))]
        return self._page(groups, "Groups", args, "NextToken")

    def admin_remove_user_from_group(self, **args):
        self._call("remove", args)
        self.memberships.setdefault(args["Username"], set()).discard(args["GroupName"])
        return {}

    def admin_add_user_to_group(self, **args):
        self._call("add", args)
        self.memberships.setdefault(args["Username"], set()).add(args["GroupName"])
        return {}

    @property
    def writes(self):
        return [(operation, args) for operation, args in self.events if operation in ("add", "remove")]


class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.policy = parse_policy(policy_document())

    def test_complete_pagination_changes_only_managed_groups_remove_before_add(self):
        client = FakeCognito(
            [user("owner", "owner@example.org"), user("staff", "staff@example.org")],
            {"owner": {"other-application", "portal-editor"}, "staff": {"other-application"}},
        )
        counts = reconcile(client, "test_pool", self.policy, dry_run=False)
        self.assertEqual(client.memberships["owner"], {"portal-admin", "other-application"})
        self.assertEqual(client.memberships["staff"], {"portal-editor", "other-application"})
        owner_writes = [(op, args["GroupName"]) for op, args in client.writes if args["Username"] == "owner"]
        self.assertEqual(owner_writes, [("remove", "portal-editor"), ("add", "portal-admin")])
        self.assertEqual(counts["usersScanned"], 2)
        self.assertEqual(counts["membershipsAdded"], 2)
        self.assertEqual(counts["membershipsRemoved"], 1)
        self.assertTrue(all(isinstance(value, int) for value in counts.values()))

    def test_second_run_is_idempotent_and_does_not_read_each_unchanged_user(self):
        client = FakeCognito([user("staff", "staff@example.org")])
        reconcile(client, "test_pool", self.policy, dry_run=False)
        client.events.clear()
        counts = reconcile(client, "test_pool", self.policy, dry_run=False)
        self.assertEqual(client.writes, [])
        self.assertEqual(counts.get("usersChanged"), 0)
        self.assertNotIn("admin_get_user", [op for op, _ in client.events])

    def test_dry_run_is_default_and_reports_planned_changes(self):
        client = FakeCognito([user("owner", "owner@example.org")], {"owner": {"portal-editor"}})
        counts = reconcile(client, "test_pool", self.policy)
        self.assertEqual(client.writes, [])
        self.assertEqual(counts.get("additionsPlanned"), 1)
        self.assertEqual(counts.get("removalsPlanned"), 1)
        self.assertEqual(counts.get("membershipsAdded"), 0)

    def test_any_initial_or_preflight_pagination_failure_prevents_all_writes(self):
        for failing_operation in ("list_users", "list_users_in_group", "admin_list_groups_for_user"):
            with self.subTest(operation=failing_operation):
                client = FakeCognito(
                    [user("a", "owner@example.org"), user("b", "staff@example.org")],
                    {"a": {"portal-editor", "other-application"}, "b": {"portal-editor"}},
                )
                def fail_page(operation, args, count):
                    if operation == failing_operation and (
                            args.get("PaginationToken") or args.get("NextToken")):
                        raise FakeApiError("ThrottlingException")
                client.before_call = fail_page
                with self.assertRaises(SyncError) as caught:
                    reconcile(client, "test_pool", self.policy, dry_run=False)
                self.assertNotIn("sensitive", str(caught.exception))
                self.assertEqual(client.writes, [])

    def test_stale_list_eligibility_is_reread_before_grants(self):
        for changed in ("disabled", "unverified", "renamed", "deleted"):
            with self.subTest(changed=changed):
                client = FakeCognito([user("owner", "owner@example.org")])
                def change_user(operation, args, count):
                    if operation != "admin_get_user" or count != 1:
                        return
                    if changed == "deleted":
                        del client.users["owner"]
                    elif changed == "disabled":
                        client.users["owner"]["Enabled"] = False
                    else:
                        name, value = ("email_verified", "false") if changed == "unverified" else ("email", "owner@unrelated.test")
                        for attribute in client.users["owner"]["Attributes"]:
                            if attribute["Name"] == name:
                                attribute["Value"] = value
                client.before_call = change_user
                reconcile(client, "test_pool", self.policy, dry_run=False)
                self.assertEqual(client.writes, [])

    def test_grant_rechecks_eligibility_after_preflight(self):
        client = FakeCognito([user("owner", "owner@example.org")])
        def revoke_after_preflight(operation, args, count):
            if operation == "admin_get_user" and count == 2:
                client.users["owner"]["Enabled"] = False
        client.before_call = revoke_after_preflight
        reconcile(client, "test_pool", self.policy, dry_run=False)
        self.assertEqual(client.writes, [])

    def test_current_memberships_are_reread_before_changes(self):
        client = FakeCognito([user("owner", "owner@example.org")])
        def move_group(operation, args, count):
            if operation == "admin_get_user" and count == 2:
                client.memberships["owner"] = {"portal-demo", "other-application"}
        client.before_call = move_group
        reconcile(client, "test_pool", self.policy, dry_run=False)
        self.assertEqual(client.memberships.get("owner", set()), {"portal-admin", "other-application"})
        self.assertEqual([(op, args["GroupName"]) for op, args in client.writes],
                         [("remove", "portal-demo"), ("add", "portal-admin")])

    def test_disabled_or_unverified_users_lose_only_managed_membership(self):
        client = FakeCognito(
            [user("a", "owner@example.org", enabled=False), user("b", "staff@example.org", verified="false")],
            {"a": {"portal-admin", "other-application"}, "b": {"portal-editor"}},
        )
        reconcile(client, "test_pool", self.policy, dry_run=False)
        self.assertEqual(client.memberships, {"a": {"other-application"}, "b": set()})

    def test_managed_group_with_iam_role_is_rejected_before_writes(self):
        client = FakeCognito([user("staff", "staff@example.org")])
        client.roles["portal-editor"] = "arn:aws:iam::000000000000:role/fixture"
        with self.assertRaises(SyncError):
            reconcile(client, "test_pool", self.policy, dry_run=False)
        self.assertEqual(client.writes, [])

    def test_repeated_pagination_token_is_rejected(self):
        client = FakeCognito([user("staff", "staff@example.org")])
        client.list_users = lambda **args: {"Users": [], "PaginationToken": "repeat"}
        with self.assertRaises(SyncError):
            reconcile(client, "test_pool", self.policy, dry_run=False)
        self.assertEqual(client.writes, [])

    def test_missing_users_list_is_not_interpreted_as_empty_pool(self):
        client = FakeCognito([user("staff", "staff@example.org")], {"staff": {"portal-editor"}})
        client.list_users = lambda **args: {}
        with self.assertRaises(SyncError):
            reconcile(client, "test_pool", self.policy, dry_run=False)
        self.assertEqual(client.writes, [])

    def test_grant_rereads_after_removal(self):
        client = FakeCognito([user("owner", "owner@example.org")], {"owner": {"portal-editor"}})
        def disable_after_removal(operation, args, count):
            if operation == "remove":
                client.users["owner"]["Enabled"] = False
        client.before_call = disable_after_removal
        reconcile(client, "test_pool", self.policy, dry_run=False)
        self.assertEqual(client.memberships["owner"], set())
        self.assertEqual([op for op, _ in client.writes], ["remove"])

    def test_metadata_is_rechecked_before_grant(self):
        client = FakeCognito([user("owner", "owner@example.org")])
        def change_role(operation, args, count):
            if operation == "admin_get_user" and count == 2:
                client.roles["portal-admin"] = "arn:aws:iam::000000000000:role/fixture"
        client.before_call = change_role
        with self.assertRaises(SyncError):
            reconcile(client, "test_pool", self.policy, dry_run=False)
        self.assertEqual(client.writes, [])


class FakeParameterStore:
    def __init__(self, value=None, kind="SecureString"):
        self.value = json.dumps(policy_document()) if value is None else value
        self.kind = kind
        self.requests = []

    def get_parameter(self, **kwargs):
        self.requests.append(kwargs)
        return {"Parameter": {"Value": self.value, "Type": self.kind}}


class Context:
    def __init__(self, remaining=45000):
        self.remaining = remaining

    def get_remaining_time_in_millis(self):
        return self.remaining


class HandlerTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeCognito([user("staff", "staff@example.org")])
        self.ssm = FakeParameterStore()
        self.env = patch.dict(os.environ, {"USER_POOL_ID": "test_pool",
                                          "POLICY_PARAMETER_NAME": "/test/group-policy"}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def invoke(self, context=None):
        output = io.StringIO()
        with patch.object(group_sync, "_clients", return_value=(self.client, self.ssm), create=True):
            with redirect_stdout(output):
                result = lambda_handler({}, context or Context())
        return result, output.getvalue()

    def test_default_dry_run_decrypts_policy_and_logs_only_aggregate_counts(self):
        result, output = self.invoke()
        self.assertEqual(self.client.writes, [])
        self.assertEqual(result.get("additionsPlanned"), 1)
        self.assertEqual(self.ssm.requests, [{"Name": "/test/group-policy", "WithDecryption": True}])
        self.assertNotIn("staff", output)
        self.assertNotIn("example.org", output)
        self.assertNotIn("portal-editor", output)
        self.assertIn('"dryRun": true', output)

    def test_explicit_false_enables_writes(self):
        os.environ["DRY_RUN"] = "false"
        result, _ = self.invoke()
        self.assertEqual(result.get("membershipsAdded"), 1)
        self.assertEqual(self.client.memberships.get("staff"), {"portal-editor"})

    def test_unencrypted_policy_invalid_json_and_unknown_dry_run_fail_before_reads(self):
        cases = ("unencrypted", "malformed", "invalid-dry-run")
        for case in cases:
            with self.subTest(case=case):
                self.ssm = FakeParameterStore(kind="String" if case == "unencrypted" else "SecureString",
                                              value="private-invalid-json" if case == "malformed" else None)
                if case == "invalid-dry-run":
                    os.environ["DRY_RUN"] = "no"
                with self.assertRaises(SyncError) as caught:
                    self.invoke()
                self.assertNotIn("private-invalid-json", str(caught.exception))
                self.assertEqual(self.client.events, [])
                self.assertEqual(self.client.writes, [])

    def test_deadline_prevents_network_reads_and_writes(self):
        with self.assertRaises(SyncError):
            self.invoke(Context(5000))
        self.assertEqual(self.client.events, [])
        self.assertEqual(self.ssm.requests, [])


if __name__ == "__main__":
    unittest.main()
