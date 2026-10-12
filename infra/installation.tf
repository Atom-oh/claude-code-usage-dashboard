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

locals {
  node_subnet_selector_terms = jsondecode(length(var.private_subnet_ids) > 0 ? jsonencode([
    for id in var.private_subnet_ids : { id = id }
  ]) : jsonencode([{ tags = { "karpenter.sh/discovery" = var.eks_cluster_name } }]))
}
