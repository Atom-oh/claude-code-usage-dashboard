variables {
  eks_cluster_name           = "fixture-cluster"
  domain                     = "example.invalid"
  dashboard_hostname         = "dashboard.example.invalid"
  ch_ingest_hostname         = "ingest.example.invalid"
  clickhouse_writer_password = "YOUR_SYNTHETIC_WRITER_PASSWORD"
  clickhouse_reader_password = "YOUR_SYNTHETIC_READER_PASSWORD"
  clickhouse_ingest_password = "YOUR_SYNTHETIC_INGEST_PASSWORD"
  auth_mode                  = "oidc"
  oidc_issuer                = "https://identity.example.invalid/"
  oidc_client_id             = "fixture-client"
  oidc_secret_name           = "dashboard-oidc-auth"
  oidc_groups_claim          = "cognito:groups"
  oidc_role_groups           = { viewer = ["fixture-viewers"], admin = ["fixture-admins"] }
}

run "oidc_uses_only_external_secret_reference" {
  command = plan
  assert {
    condition     = output.oidc_environment.AUTH_MODE == "oidc" && output.oidc_environment.APP_PUBLIC_URL == "https://dashboard.example.invalid"
    error_message = "OIDC must fix its public origin from the installation hostname."
  }
  assert {
    condition     = !contains(keys(output.oidc_environment), "SESSION_SECRET") && !contains(keys(output.oidc_environment), "OIDC_CLIENT_SECRET")
    error_message = "Secret values must not be inline OIDC environment configuration."
  }
  assert {
    condition     = output.oidc_secret_name == "dashboard-oidc-auth" && output.oidc_environment.OIDC_GROUPS_CLAIM == "cognito:groups"
    error_message = "The configured external secret and signed group claim must be retained."
  }
}

run "basic_preserves_legacy_configuration" {
  command = plan
  variables {
    auth_mode                     = "basic"
    dashboard_basic_auth_password = "YOUR_SYNTHETIC_BASIC_PASSWORD"
  }
  assert {
    condition     = output.auth_mode == "basic" && length(output.oidc_environment) == 0
    error_message = "Basic upgrades must not inject OIDC settings."
  }
}

run "basic_requires_password" {
  command = plan
  variables {
    auth_mode = "basic"
  }
  expect_failures = [var.dashboard_basic_auth_password]
}

run "missing_issuer" {
  command = plan
  variables {
    oidc_issuer = null
  }
  expect_failures = [var.oidc_issuer]
}

run "insecure_issuer" {
  command = plan
  variables {
    oidc_issuer = "http://identity.example.invalid"
  }
  expect_failures = [var.oidc_issuer]
}

run "missing_client" {
  command = plan
  variables {
    oidc_client_id = null
  }
  expect_failures = [var.oidc_client_id]
}

run "missing_secret_reference" {
  command = plan
  variables {
    oidc_secret_name = null
  }
  expect_failures = [var.oidc_secret_name]
}

run "invalid_secret_reference" {
  command = plan
  variables {
    oidc_secret_name = "invalid..secret"
  }
  expect_failures = [var.oidc_secret_name]
}

run "no_implicit_viewer_access" {
  command = plan
  variables {
    oidc_role_groups = {}
  }
  expect_failures = [var.oidc_role_groups]
}

run "unknown_role" {
  command = plan
  variables {
    oidc_role_groups = { owner = ["fixture-owners"] }
  }
  expect_failures = [var.oidc_role_groups]
}

run "invalid_duration" {
  command = plan
  variables {
    session_max_age_seconds = 86400
  }
  expect_failures = [var.session_max_age_seconds]
}
