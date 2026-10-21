data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  pool_arn = "arn:${data.aws_partition.current.partition}:cognito-idp:${var.aws_region}:${data.aws_caller_identity.current.account_id}:userpool/${var.user_pool_id}"
}

resource "aws_ssm_parameter" "policy" {
  name        = var.policy_parameter_name
  description = "Private rules for explicitly managed Cognito authorization groups"
  type        = "SecureString"
  tier        = "Standard"
  key_id      = coalesce(var.policy_kms_key_arn, "alias/aws/ssm")
  value       = var.policy_json
}

# Read after parameter creation: a first SecureString creates the AWS managed key.
data "aws_kms_key" "policy" {
  key_id     = aws_ssm_parameter.policy.key_id
  depends_on = [aws_ssm_parameter.policy]
}

resource "aws_cloudwatch_log_group" "sync" {
  name              = "/aws/lambda/${var.name}"
  retention_in_days = 14
}

resource "aws_iam_role" "sync" {
  name = var.name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "sync" {
  name = var.name
  role = aws_iam_role.sync.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "cognito-idp:ListUsers",
          "cognito-idp:ListUsersInGroup",
          "cognito-idp:GetGroup",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminListGroupsForUser",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminRemoveUserFromGroup"
        ]
        Resource = local.pool_arn
      },
      {
        Effect   = "Allow"
        Action   = "ssm:GetParameter"
        Resource = aws_ssm_parameter.policy.arn
      },
      {
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = data.aws_kms_key.policy.arn
        Condition = {
          StringEquals = {
            "kms:ViaService"                      = "ssm.${var.aws_region}.${data.aws_partition.current.dns_suffix}"
            "kms:EncryptionContext:PARAMETER_ARN" = aws_ssm_parameter.policy.arn
          }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.sync.arn}:*"
      }
    ]
  })
}

data "archive_file" "sync" {
  type        = "zip"
  source_file = "${path.module}/../group_sync.py"
  output_path = "${path.module}/group-sync.zip"
}

resource "aws_lambda_function" "sync" {
  function_name                  = var.name
  role                           = aws_iam_role.sync.arn
  runtime                        = "python3.13"
  handler                        = "group_sync.lambda_handler"
  architectures                  = ["arm64"]
  memory_size                    = 128
  timeout                        = 45
  reserved_concurrent_executions = 1
  filename                       = data.archive_file.sync.output_path
  source_code_hash               = data.archive_file.sync.output_base64sha256
  publish                        = true

  environment {
    variables = {
      USER_POOL_ID          = var.user_pool_id
      POLICY_PARAMETER_NAME = aws_ssm_parameter.policy.name
      DRY_RUN               = tostring(var.dry_run)
    }
  }

  lifecycle {
    precondition {
      condition     = startswith(var.user_pool_id, "${var.aws_region}_")
      error_message = "The selected user pool and provider region must match."
    }
  }

  depends_on = [aws_iam_role_policy.sync, aws_cloudwatch_log_group.sync]
}

resource "aws_lambda_function_event_invoke_config" "sync" {
  function_name                = aws_lambda_function.sync.function_name
  maximum_event_age_in_seconds = 60
  maximum_retry_attempts       = 0
}

resource "aws_cloudwatch_event_rule" "sync" {
  name                = var.name
  description         = "Reconcile only explicitly managed Cognito authorization groups"
  schedule_expression = "rate(1 minute)"
  state               = var.schedule_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "sync" {
  rule = aws_cloudwatch_event_rule.sync.name
  arn  = aws_lambda_function.sync.arn

  retry_policy {
    maximum_event_age_in_seconds = 60
    maximum_retry_attempts       = 0
  }
}

resource "aws_lambda_permission" "schedule" {
  statement_id   = "AllowDedicatedSchedule"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.sync.function_name
  principal      = "events.amazonaws.com"
  source_arn     = aws_cloudwatch_event_rule.sync.arn
  source_account = data.aws_caller_identity.current.account_id
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "${var.name}-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = aws_lambda_function.sync.function_name }
  alarm_actions       = var.alarm_action_arns
}

resource "aws_cloudwatch_metric_alarm" "missing_runs" {
  count               = var.schedule_enabled ? 1 : 0
  alarm_name          = "${var.name}-missing-runs"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Invocations"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "breaching"
  dimensions          = { FunctionName = aws_lambda_function.sync.function_name }
  alarm_actions       = var.alarm_action_arns
}

resource "aws_cloudwatch_metric_alarm" "delivery_errors" {
  alarm_name          = "${var.name}-delivery-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FailedInvocations"
  namespace           = "AWS/Events"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  dimensions          = { RuleName = aws_cloudwatch_event_rule.sync.name }
  alarm_actions       = var.alarm_action_arns
}
