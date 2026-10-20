# 이미 있는 것들을 재사용 — 새 EKS 클러스터/VPC는 만들지 않는다 (사용자 결정).
data "aws_caller_identity" "current" {}

data "aws_eks_cluster" "this" {
  name = var.eks_cluster_name
}

data "aws_vpc" "this" {
  id = data.aws_eks_cluster.this.vpc_config[0].vpc_id
}

data "aws_subnets" "private" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.this.id]
  }
  dynamic "filter" {
    for_each = length(var.private_subnet_ids) > 0 ? [var.private_subnet_ids] : []
    content {
      name   = "subnet-id"
      values = filter.value
    }
  }
  tags = length(var.private_subnet_ids) > 0 ? {} : { "karpenter.sh/discovery" = var.eks_cluster_name }
  lifecycle {
    postcondition {
      condition     = length(self.ids) > 0 && (length(var.private_subnet_ids) == 0 || length(self.ids) == length(var.private_subnet_ids))
      error_message = "No matching subnets, or an explicit subnet is missing/outside the cluster VPC. Set private_subnet_ids to verified private subnets in that VPC."
    }
  }
}

# 노드용 IAM 인스턴스 프로파일 role — 기존 EC2NodeClass(default)가 쓰는 것과 동일한 role 재사용.
data "aws_iam_roles" "node_role" {
  count      = var.node_role_name == null ? 1 : 0
  name_regex = "eksctl-${var.eks_cluster_name}-nodegroup.*NodeInstanceRole.*"
  lifecycle {
    postcondition {
      condition     = length(self.names) == 1
      error_message = "Legacy node-role discovery must match exactly one role. Set node_role_name explicitly after verifying cluster admission and Karpenter permissions."
    }
  }
}

data "aws_iam_role" "explicit_node" {
  count = var.node_role_name == null ? 0 : 1
  name  = var.node_role_name
}

locals {
  node_role_name = var.node_role_name == null ? try(one(data.aws_iam_roles.node_role[0].names), "") : data.aws_iam_role.explicit_node[0].name
  oidc_issuer    = replace(data.aws_eks_cluster.this.identity[0].oidc[0].issuer, "https://", "")
}

data "aws_iam_openid_connect_provider" "eks" {
  url = data.aws_eks_cluster.this.identity[0].oidc[0].issuer
}

data "aws_route53_zone" "public" {
  name         = "${var.domain}."
  private_zone = false
}

# 이미 발급된 와일드카드 인증서 재사용 — 신규 발급/검증 없음 (다른 리포 상태와 결합되지 않는
# 읽기 전용 참조). CloudFront(us-east-1)에서만 필요 — NLB는 TCP passthrough라 리전 인증서 불필요
# (CloudFront VPC Origin이 NLB의 TLS 리스너를 허용하지 않음: "Use a TCP listener").
data "aws_acm_certificate" "wildcard_cloudfront" {
  count       = var.cloudfront_certificate_arn == null ? 1 : 0
  provider    = aws.us_east_1
  domain      = "*.${var.domain}"
  statuses    = ["ISSUED"]
  most_recent = true
}

data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}
