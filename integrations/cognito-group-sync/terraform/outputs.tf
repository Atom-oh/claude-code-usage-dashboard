output "function_name" {
  value       = aws_lambda_function.sync.function_name
  description = "Function to invoke for a controlled dry-run."
}

output "policy_parameter_arn" {
  value       = aws_ssm_parameter.policy.arn
  description = "Private policy location; no parameter value is exposed."
}

output "schedule_name" {
  value = aws_cloudwatch_event_rule.sync.name
}
