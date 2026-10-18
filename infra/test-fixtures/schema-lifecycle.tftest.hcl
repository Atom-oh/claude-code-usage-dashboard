mock_provider "kubernetes" {}
mock_provider "kubectl" {}

run "schema_inputs_and_job_are_pinned" {
  command = plan
  assert {
    condition = (
      kubernetes_config_map.schema.immutable &&
      kubernetes_config_map.schema.metadata[0].name == "clickhouse-schema-${substr(local.schema_lifecycle_hash, 0, 12)}" &&
      kubernetes_config_map.schema.data == tomap(local.schema_lifecycle_files)
    )
    error_message = "The schema Job must use immutable inputs bound to all lifecycle files."
  }
  assert {
    condition = (
      kubernetes_job_v1.schema_init.metadata[0].name == "clickhouse-schema-init-${substr(local.schema_lifecycle_hash, 0, 12)}" &&
      kubernetes_job_v1.schema_init.spec[0].backoff_limit == 0 &&
      kubernetes_job_v1.schema_init.spec[0].active_deadline_seconds == 1500 &&
      kubernetes_job_v1.schema_init.spec[0].template[0].spec[0].restart_policy == "Never" &&
      kubernetes_job_v1.schema_init.wait_for_completion
    )
    error_message = "The initializer must surface failure and never restart a partial bootstrap."
  }
  assert {
    condition = (
      kubernetes_job_v1.schema_init.spec[0].template[0].spec[0].container[0].command == tolist(["sh", "/sql/clickhouse-schema-init.sh"]) &&
      kubernetes_job_v1.schema_init.spec[0].template[0].spec[0].container[0].volume_mount[0].read_only &&
      kubernetes_job_v1.schema_init.spec[0].template[0].spec[0].volume[0].config_map[0].name == kubernetes_config_map.schema.metadata[0].name
    )
    error_message = "The actual runner and its frozen ConfigMap must be mounted read-only."
  }
  assert {
    condition = (
      one([for item in kubernetes_job_v1.schema_init.spec[0].template[0].spec[0].container[0].env : item.value if item.name == "CH_HOST"]) == local.chi_service &&
      one([for item in kubernetes_job_v1.schema_init.spec[0].template[0].spec[0].container[0].env : item.value if item.name == "CH_EXPECTED_REPLICAS"]) == "3" &&
      one([for item in kubernetes_job_v1.schema_init.spec[0].template[0].spec[0].container[0].env : item.value_from[0].secret_key_ref[0].name if item.name == "CH_PASSWORD"]) == "fixture-writer" &&
      one([for item in kubernetes_job_v1.schema_init.spec[0].template[0].spec[0].container[0].env : item.value_from[0].secret_key_ref[0].key if item.name == "CH_PASSWORD"]) == "CH_PASSWORD"
    )
    error_message = "The initializer must retain the writer Secret reference and verify all three replicas."
  }
}
