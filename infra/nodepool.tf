# ClickHouse/대시보드 전용 Karpenter NodePool — 기존 EC2NodeClass(default/graviton 등)는
# 건드리지 않고 이 워크로드만 위한 새 풀을 추가한다. m8g.xlarge 단일 타입(../aws-ec2-benchmark
# ClickBench 실측 가성비 1위). taint로 격리해 다른 워크로드가 여기 스케줄되지 않게 한다.

resource "kubectl_manifest" "claude_code_nodeclass" {
  yaml_body = yamlencode({
    apiVersion = "karpenter.k8s.aws/v1"
    kind       = "EC2NodeClass"
    metadata   = { name = "claude-code" }
    spec = {
      amiSelectorTerms = [{ alias = "al2023@latest" }]
      blockDeviceMappings = [{
        deviceName = "/dev/xvda"
        ebs        = { encrypted = true, volumeSize = "50Gi", volumeType = "gp3" }
      }]
      role                       = local.node_role_name
      securityGroupSelectorTerms = [{ tags = { "karpenter.sh/discovery" = var.eks_cluster_name } }]
      subnetSelectorTerms        = [{ tags = { "karpenter.sh/discovery" = var.eks_cluster_name } }]
      tags                       = { NodePool = "claude-code", Project = "claude-code-ab-dashboard", "managed-by" = "karpenter" }
    }
  })
}

resource "kubectl_manifest" "claude_code_nodepool" {
  yaml_body = yamlencode({
    apiVersion = "karpenter.sh/v1"
    kind       = "NodePool"
    metadata   = { name = "claude-code" }
    spec = {
      disruption = { consolidationPolicy = "WhenEmptyOrUnderutilized", consolidateAfter = "10m" }
      limits     = { cpu = "16", memory = "64Gi" }
      template = {
        metadata = { labels = { "node-type" = "claude-code" } }
        spec = {
          expireAfter  = "720h"
          nodeClassRef = { group = "karpenter.k8s.aws", kind = "EC2NodeClass", name = "claude-code" }
          taints       = [{ key = "claude-code", value = "true", effect = "NoSchedule" }]
          requirements = [
            { key = "kubernetes.io/arch", operator = "In", values = ["arm64"] },
            { key = "karpenter.sh/capacity-type", operator = "In", values = ["on-demand"] },
            { key = "node.kubernetes.io/instance-type", operator = "In", values = [var.clickhouse_node_instance_type] },
          ]
        }
      }
    }
  })
  depends_on = [kubectl_manifest.claude_code_nodeclass]
}
