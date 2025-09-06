variable "aws_region" {
  description = "AWS region to deploy to"
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Name prefix for all resources"
  type        = string
  default     = "alerting-dev"
}

variable "tags" {
  description = "Common tags to apply to resources"
  type        = map(string)
  default     = {
    "app"   = "alerting-min-v1"
    "owner" = "dev-infra"
  }
}

variable "webhook_grafana_token" {
  description = "Token expected in X-Grafana-Token header for webhook auth (Grafana only)"
  sensitive    = true
  type         = string
}
