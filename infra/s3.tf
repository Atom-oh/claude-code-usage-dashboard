# ClickHouse 백업(clickhouse-backup → S3) + 콜드 티어(storage policy)용 버킷.
# 프리픽스로 나눠 버킷 1개로 — ponytail: 버킷 2개를 만들 이유가 없다.
resource "aws_s3_bucket" "clickhouse" {
  bucket = "cc-ab-clickhouse-${data.aws_caller_identity.current.account_id}-${var.region}"
}

resource "aws_s3_bucket_lifecycle_configuration" "clickhouse" {
  bucket = aws_s3_bucket.clickhouse.id
  rule {
    id     = "expire-backups"
    status = "Enabled"
    # cold_s3 디스크 endpoint가 이미 .../cold/로 끝나므로(clickhouse.tf의 cold_s3_endpoint)
    # Disk('cold_s3', 'backup/...')로 쓴 백업의 실제 S3 객체 경로는 cold/backup/... 이다.
    # prefix가 "backup/"이던 이전 버전은 아무 객체도 매칭하지 못해 백업이 무기한 누적되고
    # 있었을 가능성이 있다(PR #18 리뷰에서 확인) — 실제 경로로 수정.
    filter { prefix = "cold/backup/" }
    expiration { days = 30 }
  }
}

resource "aws_s3_bucket_public_access_block" "clickhouse" {
  bucket                  = aws_s3_bucket.clickhouse.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# IRSA — ClickHouse pod의 ServiceAccount만 이 버킷에 접근 가능 (namespace/SA로 trust 제한).
resource "aws_iam_role" "clickhouse_s3" {
  name = "cc-ab-clickhouse-s3"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.eks.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.oidc_issuer}:sub" = "system:serviceaccount:${var.k8s_namespace}:clickhouse"
          "${local.oidc_issuer}:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "clickhouse_s3" {
  name = "s3-access"
  role = aws_iam_role.clickhouse_s3.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Resource = [aws_s3_bucket.clickhouse.arn, "${aws_s3_bucket.clickhouse.arn}/*"]
    }]
  })
}
