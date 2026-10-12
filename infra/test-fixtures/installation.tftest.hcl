mock_provider "aws" {
  mock_data "aws_eks_cluster" {
    defaults = {
      vpc_config = [{ vpc_id = "vpc-00000000000000001" }]
      identity   = [{ oidc = [{ issuer = "https://oidc.example.invalid/id/fixture" }] }]
    }
  }
  mock_data "aws_subnets" {
    defaults = { ids = ["subnet-00000000000000001", "subnet-00000000000000002"] }
  }
  mock_data "aws_iam_roles" {
    defaults = { names = ["fixture-node-role"] }
  }
}
mock_provider "aws" {
  alias = "us_east_1"
}
mock_provider "kubectl" {}

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

run "legacy_discovery_preserves_selector" {
  command = plan
  assert {
    condition     = output.node_role_name == "fixture-node-role" && length(data.aws_iam_roles.node_role) == 1 && length(data.aws_iam_role.explicit_node) == 0
    error_message = "Default discovery must use the single matching legacy role."
  }
  assert {
    condition     = output.nodeclass.spec.subnetSelectorTerms[0].tags["karpenter.sh/discovery"] == "fixture-cluster"
    error_message = "The legacy tagged selector must remain unchanged."
  }
}

run "explicit_customer_environment" {
  command = plan
  variables {
    node_role_name     = "customer-node-role"
    private_subnet_ids = ["subnet-00000000000000001", "subnet-00000000000000002"]
  }
  assert {
    condition     = output.node_role_name == "customer-node-role" && length(data.aws_iam_roles.node_role) == 0 && length(data.aws_iam_role.explicit_node) == 1
    error_message = "An explicit existing role must bypass the eksctl lookup."
  }
  assert {
    condition     = toset([for term in output.nodeclass.spec.subnetSelectorTerms : term.id]) == toset(output.subnet_ids) && length(data.aws_subnets.private.tags) == 0
    error_message = "Explicit subnets must drive nodes and service lookups without tag filters."
  }
  assert {
    condition     = contains([for filter in data.aws_subnets.private.filter : filter.name], "vpc-id") && contains([for filter in data.aws_subnets.private.filter : filter.name], "subnet-id")
    error_message = "Explicit subnet IDs must still be restricted to the cluster VPC."
  }
}

run "missing_legacy_role" {
  command = plan
  override_data {
    target = data.aws_iam_roles.node_role[0]
    values = { names = [] }
  }
  expect_failures = [data.aws_iam_roles.node_role[0]]
}

run "ambiguous_legacy_roles" {
  command = plan
  override_data {
    target = data.aws_iam_roles.node_role[0]
    values = { names = ["first-role", "second-role"] }
  }
  expect_failures = [data.aws_iam_roles.node_role[0]]
}

run "no_discovered_subnets" {
  command = plan
  override_data {
    target = data.aws_subnets.private
    values = { ids = [] }
  }
  expect_failures = [data.aws_subnets.private]
}

run "explicit_subnet_missing_or_wrong_vpc" {
  command = plan
  variables {
    private_subnet_ids = ["subnet-00000000000000001", "subnet-00000000000000002"]
  }
  override_data {
    target = data.aws_subnets.private
    values = { ids = ["subnet-00000000000000001"] }
  }
  expect_failures = [data.aws_subnets.private]
}

run "role_arn_rejected" {
  command = plan
  variables {
    node_role_name = "arn:aws:iam::000000000000:role/example"
  }
  expect_failures = [var.node_role_name]
}

run "targeted_nodeclass_cannot_skip_vpc_lookup" {
  command = plan
  plan_options {
    target = [kubectl_manifest.claude_code_nodeclass]
  }
  variables {
    private_subnet_ids = ["subnet-00000000000000001", "subnet-00000000000000002"]
  }
  override_data {
    target = data.aws_subnets.private
    values = { ids = ["subnet-00000000000000001"] }
  }
  expect_failures = [data.aws_subnets.private]
}

run "empty_explicit_role_rejected" {
  command = plan
  variables {
    node_role_name = ""
  }
  expect_failures = [var.node_role_name]
}

run "invalid_subnet_id_rejected" {
  command = plan
  variables {
    private_subnet_ids = ["not-a-subnet"]
  }
  expect_failures = [var.private_subnet_ids]
}

run "duplicate_subnet_id_rejected" {
  command = plan
  variables {
    private_subnet_ids = ["subnet-00000000000000001", "subnet-00000000000000001"]
  }
  expect_failures = [var.private_subnet_ids]
}
