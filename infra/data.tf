# 이미 있는 것들을 재사용 — 새 EKS 클러스터/VPC는 만들지 않는다 (사용자 결정).
data "aws_caller_identity" "current" {}

data "aws_eks_cluster" "this" {
  name = var.eks_cluster_name
}

data "aws_eks_cluster_auth" "this" {
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
  tags = { "karpenter.sh/discovery" = var.eks_cluster_name }
}

# 노드용 IAM 인스턴스 프로파일 role — 기존 EC2NodeClass(default)가 쓰는 것과 동일한 role 재사용.
data "aws_iam_roles" "node_role" {
  name_regex = "eksctl-${var.eks_cluster_name}-nodegroup.*NodeInstanceRole.*"
}

locals {
  node_role_name = tolist(data.aws_iam_roles.node_role.names)[0]
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
# 읽기 전용 참조).
data "aws_acm_certificate" "wildcard_regional" {
  domain      = "*.${var.domain}"
  statuses    = ["ISSUED"]
  most_recent = true
}

data "aws_acm_certificate" "wildcard_cloudfront" {
  provider    = aws.us_east_1
  domain      = "*.${var.domain}"
  statuses    = ["ISSUED"]
  most_recent = true
}

data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}
