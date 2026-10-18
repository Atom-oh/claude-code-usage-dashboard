mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "000000000000" }
  }
}

variables {
  eks_cluster_name              = "fixture-cluster"
  domain                        = "example.invalid"
  dashboard_hostname            = "dashboard.example.invalid"
  ch_ingest_hostname            = "ingest.example.invalid"
  clickhouse_writer_password    = "YOUR_SYNTHETIC_WRITER_PASSWORD"
  clickhouse_reader_password    = "YOUR_SYNTHETIC_READER_PASSWORD"
  clickhouse_ingest_password    = "YOUR_SYNTHETIC_INGEST_PASSWORD"
  dashboard_basic_auth_password = "YOUR_SYNTHETIC_BASIC_PASSWORD"
}

run "india_model_and_profile_arns_remain_exact" {
  command = plan
  variables {
    chat_model_id = "in.anthropic.claude-opus-5"
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.dashboard_bedrock.policy).Statement[0].Resource == [
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-5",
      "arn:aws:bedrock:*:000000000000:inference-profile/in.anthropic.claude-opus-5"
    ]
    error_message = "Strip the routing prefix only from the foundation-model ARN; preserve the configured profile."
  }
  assert {
    condition = alltrue([
      for prefix in ["us.", "eu.", "apac.", "jp.", "au.", "in.", "global."] :
      replace("${prefix}anthropic.claude-opus-5", local.chat_model_routing_pattern, "") == "anthropic.claude-opus-5"
    ])
    error_message = "Every supported commercial geography prefix must normalize using the actual policy pattern."
  }
  assert {
    condition = alltrue([
      for model in ["anthropic.claude-opus-5", "india.anthropic.claude-opus-5", "us-gov.anthropic.claude-opus-5"] :
      replace(model, local.chat_model_routing_pattern, "") == model
    ])
    error_message = "Bare IDs and unsupported geography prefixes must not be rewritten."
  }
}

run "global_profile_keeps_existing_policy_scope" {
  command = plan
  variables {
    chat_model_id = "global.anthropic.claude-opus-5"
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.dashboard_bedrock.policy).Statement[0].Resource == [
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-5",
      "arn:aws:bedrock:*:000000000000:inference-profile/global.anthropic.claude-opus-5"
    ]
    error_message = "The existing global profile must retain the same model and profile resource scope."
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.dashboard_bedrock.policy).Statement[0].Action == [
      "bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"
    ]
    error_message = "Routing normalization must not add IAM actions."
  }
}
