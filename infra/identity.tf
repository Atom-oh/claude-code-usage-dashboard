variable "auth_mode" {
  description = "Authentication mode. Dedicated commercial installations should use organization OIDC."
  type        = string
  default     = "basic"
  validation {
    condition     = contains(["basic", "oidc"], var.auth_mode)
    error_message = "auth_mode must be basic or oidc."
  }
}

variable "oidc_issuer" {
  description = "Exact HTTPS issuer identifier, including any trailing path/slash."
  type        = string
  default     = null
  validation {
    condition = var.auth_mode != "oidc" ? true : (
      var.oidc_issuer == null ? false : can(regex("^https://[^/?#@\\s]+(/[^?#]*)?$", var.oidc_issuer))
    )
    error_message = "OIDC requires an HTTPS oidc_issuer without credentials, query or fragment."
  }
}

variable "oidc_client_id" {
  description = "Registered confidential OIDC client identifier."
  type        = string
  default     = null
  validation {
    condition     = var.auth_mode != "oidc" ? true : (var.oidc_client_id == null ? false : length(trimspace(var.oidc_client_id)) > 0)
    error_message = "OIDC requires oidc_client_id."
  }
}

variable "oidc_secret_name" {
  description = "Existing Kubernetes Secret in the installation namespace with OIDC_CLIENT_SECRET and SESSION_SECRET; Terraform never reads its values."
  type        = string
  default     = null
  validation {
    condition = var.auth_mode != "oidc" ? true : (
      var.oidc_secret_name == null ? false : (
        length(var.oidc_secret_name) <= 253 && can(regex("^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$", var.oidc_secret_name))
      )
    )
    error_message = "OIDC requires a valid existing Kubernetes oidc_secret_name."
  }
}

variable "oidc_scopes" {
  description = "Space-delimited authorization scopes including openid; add customer-required group/offline scopes."
  type        = string
  default     = "openid profile"
  nullable    = false
  validation {
    condition = length(var.oidc_scopes) <= 512 && contains(split(" ", var.oidc_scopes), "openid") && (
      can(regex("^[\\x21\\x23-\\x5B\\x5D-\\x7E]+( [\\x21\\x23-\\x5B\\x5D-\\x7E]+)*$", var.oidc_scopes))
    )
    error_message = "oidc_scopes must contain space-delimited OAuth scope tokens including openid, at most 512 characters."
  }
}

variable "oidc_groups_claim" {
  description = "Top-level signed ID-token group claim; use cognito:groups for Cognito."
  type        = string
  default     = "groups"
  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9:_-]{0,127}$", var.oidc_groups_claim))
    error_message = "oidc_groups_claim must name a top-level claim."
  }
}

variable "oidc_role_groups" {
  description = "Explicit group identifiers mapped to viewer, analyst or admin. Unmapped identities are denied."
  type        = map(list(string))
  default     = {}
  validation {
    condition = var.auth_mode != "oidc" ? true : (
      length(var.oidc_role_groups) > 0 &&
      alltrue([for role, groups in var.oidc_role_groups :
        contains(["viewer", "analyst", "admin"], role) && length(groups) > 0 && length(groups) <= 64 &&
        alltrue([for group in groups : length(trimspace(group)) > 0 && length(group) <= 128])
      ])
    )
    error_message = "OIDC requires explicit nonempty viewer/analyst/admin group arrays."
  }
}

variable "session_max_age_seconds" {
  description = "OIDC session lifetime, also capped by ID-token expiry."
  type        = number
  default     = 900
  validation {
    condition     = floor(var.session_max_age_seconds) == var.session_max_age_seconds && var.session_max_age_seconds >= 300 && var.session_max_age_seconds <= 3600
    error_message = "session_max_age_seconds must be an integer from 300 to 3600."
  }
}

variable "session_refresh_max_age_seconds" {
  description = "Absolute login lifetime with non-rotating, revocable OIDC refresh tokens; 0 disables persistence."
  type        = number
  default     = 0
  validation {
    condition = floor(var.session_refresh_max_age_seconds) == var.session_refresh_max_age_seconds && (
      var.session_refresh_max_age_seconds == 0 ||
      (var.session_refresh_max_age_seconds >= 3600 && var.session_refresh_max_age_seconds <= 2592000)
    )
    error_message = "session_refresh_max_age_seconds must be 0 or an integer from 3600 to 2592000."
  }
}

locals {
  oidc_environment = var.auth_mode == "oidc" ? {
    AUTH_MODE                       = "oidc"
    APP_PUBLIC_URL                  = "https://${var.dashboard_hostname}"
    OIDC_ISSUER                     = var.oidc_issuer
    OIDC_CLIENT_ID                  = var.oidc_client_id
    OIDC_SCOPES                     = var.oidc_scopes
    OIDC_GROUPS_CLAIM               = var.oidc_groups_claim
    OIDC_ROLE_GROUPS                = jsonencode(var.oidc_role_groups)
    SESSION_MAX_AGE_SECONDS         = tostring(var.session_max_age_seconds)
    SESSION_REFRESH_MAX_AGE_SECONDS = tostring(var.session_refresh_max_age_seconds)
  } : {}
}
