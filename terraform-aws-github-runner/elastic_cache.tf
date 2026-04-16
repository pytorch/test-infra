resource "aws_security_group" "allow_es_from_local" {
  name        = "${var.environment}-allow_es_from_local"
  description = "Allow connection on port 6379 (redis)"
  vpc_id      = var.vpc_ids[0].vpc

  ingress {
    description = "Allow connection on port 6379 (redis)"
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidrs[0].cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = var.tags
}

resource "random_password" "es_password" {
  length  = 21
  special = false
}

resource "aws_elasticache_user" "scale_lambda" {
  user_id       = "${var.environment}-scalelambda"
  user_name     = "${var.environment}-scalelambda"
  access_string = "on ~* +@all"
  engine        = "REDIS"
  passwords     = [random_password.es_password.result]
  tags          = var.tags
}

resource "aws_elasticache_subnet_group" "es" {
  name       = "${var.environment}-cache-subnet"
  subnet_ids = var.lambda_subnet_ids
  tags       = var.tags
}

resource "aws_elasticache_replication_group" "es" {
  automatic_failover_enabled = false
  description                = "scale runners and lambdas"
  engine                     = "redis"
  node_type                  = "cache.m4.large"
  num_node_groups            = 1
  port                       = 6379
  replicas_per_node_group    = 1
  replication_group_id       = "${var.environment}-scale-runners-rep-group"
  security_group_ids         = [aws_security_group.allow_es_from_local.id]
  subnet_group_name          = aws_elasticache_subnet_group.es.name
  tags                       = var.tags
}

resource "aws_elasticache_cluster" "es" {
  apply_immediately    = true
  cluster_id           = "${var.environment}-scale-runners"
  replication_group_id = aws_elasticache_replication_group.es.id
  tags                 = var.tags
}
