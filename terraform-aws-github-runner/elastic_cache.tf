resource "aws_elasticache_subnet_group" "es" {
  name       = "${var.namespace}-cache-subnet"
  subnet_ids = ["${aws_subnet.default.*.id}"]
}

resource "aws_elasticache_replication_group" "default" {
  replication_group_id          = "${var.cluster_id}"
  replication_group_description = "Redis cluster for Hashicorp ElastiCache example"

  node_type            = "cache.m4.large"
  port                 = 6379
  parameter_group_name = "default.redis3.2.cluster.on"

  snapshot_retention_limit = 5
  snapshot_window          = "00:00-05:00"

  subnet_group_name = "${aws_elasticache_subnet_group.default.name}"

  automatic_failover_enabled = true

  cluster_mode {
    replicas_per_node_group = 1
    num_node_groups         = "${var.node_groups}"
  }
}
