# CloudFront(us-east-1) -> VPC Origin -> 내부 NLB. NLB는 AWS Load Balancer Controller가
# Service(type=LoadBalancer) apply 시점에 생성하므로 ARN을 미리 알 수 없다 — Resource Groups
# Tagging API로 controller가 붙이는 태그(service.k8s.aws/stack)를 통해 찾는다.
data "aws_resourcegroupstaggingapi_resources" "dashboard_nlb" {
  resource_type_filters = ["elasticloadbalancing:loadbalancer"]
  tag_filter {
    key    = "service.k8s.aws/stack"
    values = ["${var.k8s_namespace}/dashboard-nlb"]
  }
  depends_on = [kubernetes_service.dashboard_nlb]
}

data "aws_resourcegroupstaggingapi_resources" "ch_ingest_nlb" {
  resource_type_filters = ["elasticloadbalancing:loadbalancer"]
  tag_filter {
    key    = "service.k8s.aws/stack"
    values = ["${var.k8s_namespace}/clickhouse-ingest-nlb"]
  }
  depends_on = [kubernetes_service.clickhouse_ingest_nlb]
}

locals {
  dashboard_nlb_arn = data.aws_resourcegroupstaggingapi_resources.dashboard_nlb.resource_tag_mapping_list[0].resource_arn
  ch_nlb_arn        = data.aws_resourcegroupstaggingapi_resources.ch_ingest_nlb.resource_tag_mapping_list[0].resource_arn
}

resource "aws_cloudfront_vpc_origin" "dashboard" {
  # NLB는 TCP passthrough(TLS 리스너 불가 — CloudFront VPC Origin 제약)이므로 http-only로
  # 붙는다. viewer<->CloudFront는 여전히 HTTPS(아래 aws_cloudfront_distribution 참고);
  # 이 구간은 VPC origin ENI를 통한 AWS 백본 내부 트래픽이라 평문이어도 인터넷에 노출되지 않음.
  vpc_origin_endpoint_config {
    name                   = "cc-ab-dashboard"
    arn                    = local.dashboard_nlb_arn
    http_port              = 443  # 실제로 쓰이는 포트 (NLB TCP 리스너)
    https_port             = 8443 # http-only 정책이라 미사용, http_port와 달라야 해서 채운 placeholder
    origin_protocol_policy = "http-only"
    origin_ssl_protocols { # http-only라 미사용, 스키마상 필수 블록
      quantity = 1
      items    = ["TLSv1.2"]
    }
  }
}

resource "aws_cloudfront_vpc_origin" "ch_ingest" {
  vpc_origin_endpoint_config {
    name                   = "cc-ab-ch-ingest"
    arn                    = local.ch_nlb_arn
    http_port              = 443  # 실제로 쓰이는 포트 (NLB TCP 리스너)
    https_port             = 8443 # http-only 정책이라 미사용, http_port와 달라야 해서 채운 placeholder
    origin_protocol_policy = "http-only"
    origin_ssl_protocols { # http-only라 미사용, 스키마상 필수 블록
      quantity = 1
      items    = ["TLSv1.2"]
    }
  }
}

resource "aws_cloudfront_distribution" "dashboard" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "Claude Code A/B dashboard"
  aliases         = [var.dashboard_hostname]
  price_class     = "PriceClass_200"

  origin {
    domain_name = var.dashboard_hostname
    origin_id   = "dashboard-nlb"
    vpc_origin_config {
      vpc_origin_id       = aws_cloudfront_vpc_origin.dashboard.id
      origin_read_timeout = 30
    }
  }
  default_cache_behavior {
    target_origin_id         = "dashboard-nlb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
    origin_request_policy_id = "216adef6-5c7f-47e4-b989-5492eafa07d3" # AllViewer
  }
  viewer_certificate {
    acm_certificate_arn      = data.aws_acm_certificate.wildcard_cloudfront.arn
    minimum_protocol_version = "TLSv1.2_2021"
    ssl_support_method       = "sni-only"
  }
  restrictions {
    geo_restriction { restriction_type = "none" }
  }
}

# CH ingest — Collector가 OTLP/HTTP를 여기로 보낸다. Authorization 헤더(otel_writer basic auth)
# 전달 필요 + 캐시 비활성 + POST 허용.
resource "aws_cloudfront_distribution" "ch_ingest" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "Claude Code A/B ClickHouse OTel ingest"
  aliases         = [var.ch_ingest_hostname]
  price_class     = "PriceClass_200"

  origin {
    domain_name = var.ch_ingest_hostname
    origin_id   = "ch-ingest-nlb"
    vpc_origin_config {
      vpc_origin_id       = aws_cloudfront_vpc_origin.ch_ingest.id
      origin_read_timeout = 30
    }
  }
  default_cache_behavior {
    target_origin_id         = "ch-ingest-nlb"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
    origin_request_policy_id = "216adef6-5c7f-47e4-b989-5492eafa07d3" # AllViewer — Authorization 포함 전달
  }
  viewer_certificate {
    acm_certificate_arn      = data.aws_acm_certificate.wildcard_cloudfront.arn
    minimum_protocol_version = "TLSv1.2_2021"
    ssl_support_method       = "sni-only"
  }
  restrictions {
    geo_restriction { restriction_type = "none" }
  }
}

resource "aws_route53_record" "dashboard" {
  zone_id = data.aws_route53_zone.public.zone_id
  name    = var.dashboard_hostname
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.dashboard.domain_name
    zone_id                = aws_cloudfront_distribution.dashboard.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "ch_ingest" {
  zone_id = data.aws_route53_zone.public.zone_id
  name    = var.ch_ingest_hostname
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.ch_ingest.domain_name
    zone_id                = aws_cloudfront_distribution.ch_ingest.hosted_zone_id
    evaluate_target_health = false
  }
}
