# Optional daily AI insights (dashboard/server/insights.js): one DynamoDB table and scoped
# permissions on the existing dashboard IRSA role. Disabled by default.
variable "insights_enabled" {
  description = "Generate one daily insight from aggregate telemetry with Bedrock and store it in DynamoDB."
  type        = bool
  default     = false
}

variable "insights_model_id" {
  description = "Bedrock foundation model or cross-region inference profile ID for daily insights."
  type        = string
  default     = "global.anthropic.claude-haiku-5-5"
  validation {
    condition     = can(regex("^[A-Za-z0-9._:-]{1,128}$", var.insights_model_id))
    error_message = "insights_model_id must be a Bedrock model or inference profile ID."
  }
}

locals {
  # Same routing-prefix rule as the chat policy in bedrock.tf.
  insights_foundation_model = replace(var.insights_model_id, local.chat_model_routing_pattern, "")
  insights_environment = var.insights_enabled ? {
    INSIGHTS_ENABLED  = "1"
    INSIGHTS_TABLE    = aws_dynamodb_table.insights[0].name
    INSIGHTS_MODEL_ID = var.insights_model_id
  } : {}
}

resource "aws_dynamodb_table" "insights" {
  count                       = var.insights_enabled ? 1 : 0
  name                        = "${var.k8s_namespace}-ccdash-insights"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  deletion_protection_enabled = true
  attribute {
    name = "pk"
    type = "S"
  }
  ttl {
    attribute_name = "purgeAt"
    enabled        = true
  }
  # AWS-managed DynamoDB KMS key. Items hold aggregates and the pseudonym-to-email map.
  server_side_encryption { enabled = true }
}

resource "aws_iam_role_policy" "insights" {
  count = var.insights_enabled ? 1 : 0
  name  = "ccdash-insights"
  role  = aws_iam_role.dashboard_bedrock.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem"]
        Resource = aws_dynamodb_table.insights[0].arn
      },
      {
        Effect = "Allow"
        Action = ["bedrock:InvokeModel"]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/${local.insights_foundation_model}",
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/${var.insights_model_id}"
        ]
      }
    ]
  })
}
