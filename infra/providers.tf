terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.33"
    }
    kubectl = {
      source  = "gavinbunney/kubectl"
      version = "~> 1.14"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
  }

  # ponytail: local state — 이 스택은 다른 리포(AWS-Demo-Platform)의 원격 상태/버킷과
  # 독립적으로 두기로 결정했다(사용자 확인). 팀 공유가 필요해지면 S3 backend로 옮길 것.
  # backend "s3" { ... }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "claude-code-ab-dashboard", ManagedBy = "terraform" }
  }
}

# CloudFront ACM 인증서는 us-east-1에서만 조회 가능.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

provider "kubernetes" {
  host                   = data.aws_eks_cluster.this.endpoint
  cluster_ca_certificate = base64decode(data.aws_eks_cluster.this.certificate_authority[0].data)
  token                  = data.aws_eks_cluster_auth.this.token
}

provider "kubectl" {
  host                   = data.aws_eks_cluster.this.endpoint
  cluster_ca_certificate = base64decode(data.aws_eks_cluster.this.certificate_authority[0].data)
  token                  = data.aws_eks_cluster_auth.this.token
  load_config_file       = false
}
