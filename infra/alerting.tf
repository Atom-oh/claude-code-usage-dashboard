# 대시보드 5xx 경보(선택). CloudFront 지표는 us-east-1에만 있으므로 알람과 SNS 토픽도 us-east-1.
# alert_email이 null이면 아무 리소스도 만들지 않는다. 구독 확인 메일을 수신자가 눌러야 발송이 시작된다.
variable "alert_email" {
  description = "CloudFront 5xx 알람을 받을 이메일. null이면 알람/SNS 토픽을 만들지 않는다."
  type        = string
  default     = null
}

resource "aws_sns_topic" "dashboard_alerts" {
  count    = var.alert_email == null ? 0 : 1
  provider = aws.us_east_1
  name     = "claude-code-dashboard-alerts"
}

resource "aws_sns_topic_subscription" "dashboard_alerts_email" {
  count     = var.alert_email == null ? 0 : 1
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.dashboard_alerts[0].arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# 5xxErrorRate는 CloudFront 기본 지표(추가 지표 활성화 불필요). 트래픽이 없는 구간은 데이터 없음이라
# notBreaching — 워크샵 사이 새벽에 울리지 않게. 5분×2 연속 5% 초과.
resource "aws_cloudwatch_metric_alarm" "dashboard_5xx" {
  count               = var.alert_email == null ? 0 : 1
  provider            = aws.us_east_1
  alarm_name          = "claude-code-dashboard-5xx-rate"
  namespace           = "AWS/CloudFront"
  metric_name         = "5xxErrorRate"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions = {
    DistributionId = aws_cloudfront_distribution.dashboard.id
    Region         = "Global"
  }
  alarm_actions = [aws_sns_topic.dashboard_alerts[0].arn]
  ok_actions    = [aws_sns_topic.dashboard_alerts[0].arn]
}
