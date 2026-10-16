variable "node_role_name" {
  description = "Existing EC2 node IAM role name admitted to this EKS cluster and usable by Karpenter. Null retains the legacy eksctl lookup, which must match exactly one role."
  type        = string
  default     = null
  validation {
    condition     = var.node_role_name == null ? true : can(regex("^[A-Za-z0-9_+=,.@-]{1,64}$", var.node_role_name))
    error_message = "node_role_name must be an IAM role name, not an ARN or path."
  }
}

variable "private_subnet_ids" {
  description = "Verified private subnet IDs in the existing cluster VPC for both workload nodes and internal NLBs. Empty retains Karpenter discovery tags; routes and reachability require independent verification."
  type        = list(string)
  default     = []
  validation {
    condition = length(var.private_subnet_ids) == length(distinct(var.private_subnet_ids)) && alltrue([
      for id in var.private_subnet_ids : can(regex("^subnet-([0-9a-f]{8}|[0-9a-f]{17})$", id))
    ])
    error_message = "private_subnet_ids must contain distinct AWS subnet IDs."
  }
}

variable "cloudfront_certificate_arn" {
  description = "Existing ACM certificate ARN in this AWS account and us-east-1 covering both public hostnames. Null retains latest ISSUED wildcard discovery. Pin the verified installed certificate to avoid an unintended certificate change; independently verify its status, expiry and names."
  type        = string
  default     = null
  validation {
    condition     = var.cloudfront_certificate_arn == null ? true : can(regex("^arn:aws:acm:us-east-1:[0-9]{12}:certificate/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.cloudfront_certificate_arn))
    error_message = "cloudfront_certificate_arn must be an ACM certificate ARN in us-east-1."
  }
  validation {
    condition     = var.cloudfront_certificate_arn == null ? true : try(split(":", var.cloudfront_certificate_arn)[4] == data.aws_caller_identity.current.account_id, false)
    error_message = "cloudfront_certificate_arn must belong to the AWS account running this installation."
  }
}

locals {
  cloudfront_certificate_arn = var.cloudfront_certificate_arn == null ? data.aws_acm_certificate.wildcard_cloudfront[0].arn : var.cloudfront_certificate_arn
  node_subnet_selector_terms = jsondecode(length(var.private_subnet_ids) > 0 ? jsonencode([
    for id in sort(data.aws_subnets.private.ids) : { id = id }
  ]) : jsonencode([{ tags = { "karpenter.sh/discovery" = var.eks_cluster_name } }]))
}
