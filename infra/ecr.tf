resource "aws_ecr_repository" "dashboard" {
  name = "cc-ab-dashboard"
  # IMMUTABLE: 태그가 다이제스트를 고정한다. MUTABLE + `latest` 재푸시 조합에서는 "이 태그로
  # 배포했다"는 기록이 나중에 다른 이미지를 가리킬 수 있어 감사가 성립하지 않는다. 배포 런북은
  # 타임스탬프 태그만 푸시한다.
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecr_lifecycle_policy" "dashboard" {
  repository = aws_ecr_repository.dashboard.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 10 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 10 }
      action       = { type = "expire" }
    }]
  })
}
