variable "aws_region" {
  type        = string
  description = "Region containing the existing user pool."
}

variable "user_pool_id" {
  type        = string
  description = "Existing shared pool. This module never owns or changes the pool."
  validation {
    condition     = can(regex("^[a-z0-9-]+_[A-Za-z0-9]+$", var.user_pool_id))
    error_message = "Specify an existing Cognito user pool ID."
  }
}

variable "name" {
  type        = string
  default     = "oidc-group-sync"
  description = "Unique prefix for this optional integration's resources."
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$", var.name))
    error_message = "Name must contain 1-40 letters, numbers, underscores or hyphens."
  }
}

variable "policy_parameter_name" {
  type        = string
  description = "New private SSM parameter path owned by this module."
  validation {
    condition     = can(regex("^/[A-Za-z0-9_./-]+$", var.policy_parameter_name))
    error_message = "Specify an absolute SSM parameter path."
  }
}

variable "policy_json" {
  type        = string
  sensitive   = true
  description = "Private policy JSON. SecureString encryption does not hide it in Terraform state or saved plans."
  validation {
    condition = can(jsondecode(var.policy_json)) && try(
      jsondecode(var.policy_json).requireVerifiedEmail == true &&
      jsondecode(var.policy_json).requireEnabledUser == true &&
      jsondecode(var.policy_json).exactEmailOverridesDomain == true,
      false
    )
    error_message = "Policy must be JSON with all three safety flags set to true."
  }
}

variable "policy_kms_key_arn" {
  type        = string
  default     = null
  description = "Optional existing KMS key ARN; null uses the AWS managed SSM key."
  validation {
    condition     = var.policy_kms_key_arn == null || can(regex("^arn:[a-z-]+:kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$", var.policy_kms_key_arn))
    error_message = "Use a KMS key ARN, not an alias or wildcard."
  }
}

variable "dry_run" {
  type        = bool
  default     = true
  description = "Keep true until a reviewed dry-run and the group ownership checks are complete."
}

variable "schedule_enabled" {
  type        = bool
  default     = true
  description = "Disable for maintenance or to stop all scheduled reconciliation."
}

variable "alarm_action_arns" {
  type        = list(string)
  default     = []
  description = "Existing alarm destinations. Empty means alarms have no notifications."
}
