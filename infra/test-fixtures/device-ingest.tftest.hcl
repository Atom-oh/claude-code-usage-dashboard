mock_provider "aws" {}
mock_provider "kubernetes" {}

run "disabled_by_default" {
  command = plan
  assert {
    condition     = length(aws_dynamodb_table.device_tokens) == 0 && length(kubernetes_deployment_v1.device_receiver) == 0 && length(local.device_ingest_environment) == 0
    error_message = "Existing installations must not acquire device ingestion without opting in."
  }
}

run "enabled_is_private_and_scoped" {
  command = apply
  variables {
    device_ingest_enabled     = true
    device_ingest_secret_name = "fixture-gateway-secret"
  }
  assert {
    condition = (
      aws_dynamodb_table.device_tokens[0].hash_key == "owner" && aws_dynamodb_table.device_tokens[0].range_key == "id" &&
      aws_dynamodb_table.device_tokens[0].server_side_encryption[0].enabled && aws_dynamodb_table.device_tokens[0].ttl[0].attribute_name == "purgeAt" &&
      aws_dynamodb_table.device_tokens[0].deletion_protection_enabled
    )
    error_message = "Token metadata requires owner-scoped keys, KMS encryption, TTL and deletion protection."
  }
  assert {
    condition = (
      jsondecode(aws_iam_role_policy.device_tokens[0].policy).Statement[0].Resource == aws_dynamodb_table.device_tokens[0].arn &&
      length(jsondecode(aws_iam_role_policy.device_tokens[0].policy).Statement[0].Action) == 4
    )
    error_message = "Dashboard token IAM must be limited to four item/query operations on the exact table."
  }
  assert {
    condition = (
      kubernetes_service.device_receiver[0].spec[0].type == "ClusterIP" &&
      tonumber(kubernetes_deployment_v1.device_receiver[0].spec[0].replicas) == 2 &&
      kubernetes_deployment_v1.device_receiver[0].spec[0].template[0].spec[0].automount_service_account_token == false &&
      kubernetes_deployment_v1.device_receiver[0].spec[0].template[0].spec[0].container[0].security_context[0].read_only_root_filesystem
    )
    error_message = "Receivers must be private, redundant and hardened without Kubernetes credentials."
  }
  assert {
    condition = (
      local.device_ingest_environment.INGEST_UPSTREAM_TOKEN_FILE == "/var/run/ccdash-ingest/token" &&
      contains(keys(local.device_receiver_config.service.pipelines), "logs/claude") && contains(keys(local.device_receiver_config.service.pipelines), "logs/codex")
    )
    error_message = "The gateway must read a mounted token and both enabled clients must retain pipelines."
  }
}

run "disabled_client_not_collected" {
  command = plan
  variables {
    device_ingest_enabled     = true
    device_ingest_secret_name = "fixture-gateway-secret"
    claude_enabled            = false
  }
  assert {
    condition     = length(local.device_receiver_config.service.pipelines) == 3 && alltrue([for key in keys(local.device_receiver_config.service.pipelines) : endswith(key, "/codex")])
    error_message = "Disabling Claude must remove its central collection pipelines."
  }
}

run "basic_auth_rejected" {
  command = plan
  variables {
    device_ingest_enabled     = true
    device_ingest_secret_name = "fixture-gateway-secret"
    auth_mode                 = "basic"
  }
  expect_failures = [var.device_ingest_enabled]
}

run "missing_internal_secret_rejected" {
  command = plan
  variables { device_ingest_enabled = true }
  expect_failures = [var.device_ingest_secret_name]
}
