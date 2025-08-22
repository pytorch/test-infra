# Outputs for GPU Developer Servers

output "vpc_id" {
  description = "ID of the VPC"
  value       = aws_vpc.gpu_dev_vpc.id
}

output "subnet_id" {
  description = "ID of the subnet"
  value       = aws_subnet.gpu_dev_subnet.id
}

output "eks_cluster_name" {
  description = "Name of the EKS cluster"
  value       = aws_eks_cluster.gpu_dev_cluster.name
}

output "eks_cluster_endpoint" {
  description = "Endpoint for EKS control plane"
  value       = aws_eks_cluster.gpu_dev_cluster.endpoint
}

output "eks_cluster_arn" {
  description = "ARN of the EKS cluster"
  value       = aws_eks_cluster.gpu_dev_cluster.arn
}

output "reservation_queue_url" {
  description = "URL of the SQS reservation queue"
  value       = aws_sqs_queue.gpu_reservation_queue.id
}

output "reservation_queue_arn" {
  description = "ARN of the SQS reservation queue"
  value       = aws_sqs_queue.gpu_reservation_queue.arn
}

output "reservations_table_name" {
  description = "Name of the DynamoDB reservations table"
  value       = aws_dynamodb_table.gpu_reservations.name
}

# Removed servers_table_name output - now using K8s API for GPU tracking

output "reservation_processor_function_name" {
  description = "Name of the Lambda reservation processor function"
  value       = aws_lambda_function.reservation_processor.function_name
}

output "placement_group_name" {
  description = "Name of the cluster placement group"
  value       = aws_placement_group.gpu_dev_pg.name
}

output "security_group_id" {
  description = "ID of the security group"
  value       = aws_security_group.gpu_dev_sg.id
}

# GPU type configurations
output "supported_gpu_types" {
  description = "Supported GPU type configurations"
  value       = var.supported_gpu_types
}

# CLI configuration outputs
output "cli_config" {
  description = "Configuration for CLI tools"
  value = {
    region              = var.aws_region
    queue_url           = aws_sqs_queue.gpu_reservation_queue.id
    reservations_table  = aws_dynamodb_table.gpu_reservations.name
    cluster_name        = aws_eks_cluster.gpu_dev_cluster.name
    supported_gpu_types = var.supported_gpu_types
  }
  sensitive = false
}