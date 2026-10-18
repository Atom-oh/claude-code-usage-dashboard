# Cross-region invocation needs both the underlying model and the selected profile.
# Model regions retain the existing wildcard; model and profile IDs remain scoped.
locals {
  chat_model_routing_pattern = "/^(global|us|eu|apac|jp|au|in)\\./"
  chat_foundation_model      = replace(var.chat_model_id, local.chat_model_routing_pattern, "")
}

resource "aws_iam_role_policy" "dashboard_bedrock" {
  name = "bedrock-invoke"
  role = aws_iam_role.dashboard_bedrock.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
      Resource = [
        "arn:aws:bedrock:*::foundation-model/${local.chat_foundation_model}",
        "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/${var.chat_model_id}"
      ]
    }]
  })
}
