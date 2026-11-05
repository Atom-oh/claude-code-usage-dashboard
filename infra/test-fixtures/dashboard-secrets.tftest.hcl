mock_provider "aws" {}
mock_provider "kubernetes" {}

run "basic_files_replace_environment_secrets" {
  command = plan
  variables {
    alert_webhook_url = "https://example.invalid/fixture"
  }
  assert {
    condition = (
      toset([for e in kubernetes_deployment_v1.dashboard.spec[0].template[0].spec[0].container[0].env : e.name if endswith(e.name, "_FILE")]) == toset(["CH_PASSWORD_FILE", "BASIC_AUTH_USER_FILE", "BASIC_AUTH_PASSWORD_FILE", "ALERT_WEBHOOK_URL_FILE"]) &&
      one([for e in kubernetes_deployment_v1.dashboard.spec[0].template[0].spec[0].container[0].env : e.value if e.name == "CH_PASSWORD_FILE"]) == "/var/run/ccdash-secrets/reader/CH_PASSWORD" &&
      length([for e in kubernetes_deployment_v1.dashboard.spec[0].template[0].spec[0].container[0].env : e if e.name == "CH_PASSWORD"]) == 0 &&
      length(kubernetes_deployment_v1.dashboard.spec[0].template[0].spec[0].container[0].env_from) == 0 &&
      kubernetes_deployment_v1.dashboard.spec[0].template[0].spec[0].security_context[0].fs_group == "1000" &&
      alltrue([for m in kubernetes_deployment_v1.dashboard.spec[0].template[0].spec[0].container[0].volume_mount : m.read_only]) &&
      alltrue([for v in kubernetes_deployment_v1.dashboard.spec[0].template[0].spec[0].volume : v.secret[0].default_mode == "0440"]) &&
      length(kubernetes_deployment_v1.dashboard.spec[0].template[0].spec[0].volume) == 3
    )
    error_message = "File migration must mount only read-only secrets and remove their environment values."
  }
}

run "oidc_files_reference_the_external_secret" {
  command = plan
  variables {
    auth_mode = "oidc"
  }
  assert {
    condition = (
      toset([for e in kubernetes_deployment_v1.dashboard.spec[0].template[0].spec[0].container[0].env : e.name if endswith(e.name, "_FILE")]) == toset(["CH_PASSWORD_FILE", "OIDC_CLIENT_SECRET_FILE", "SESSION_SECRET_FILE"]) &&
      one([for v in kubernetes_deployment_v1.dashboard.spec[0].template[0].spec[0].volume : v.secret[0].secret_name if v.name == "dashboard-secret-auth"]) == "fixture-oidc" &&
      toset(one([for v in kubernetes_deployment_v1.dashboard.spec[0].template[0].spec[0].volume : [for i in v.secret[0].items : i.key] if v.name == "dashboard-secret-auth"])) == toset(["OIDC_CLIENT_SECRET", "SESSION_SECRET"])
    )
    error_message = "OIDC must mount only the required keys from its external secret."
  }
}
