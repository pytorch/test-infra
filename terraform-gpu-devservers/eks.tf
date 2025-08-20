# EKS Cluster for GPU workload management

# EKS Cluster Service Role
resource "aws_iam_role" "eks_cluster_role" {
  name = "${var.prefix}-eks-cluster-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "eks.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "${var.prefix}-eks-cluster-role"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "eks_cluster_AmazonEKSClusterPolicy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
  role       = aws_iam_role.eks_cluster_role.name
}

# EKS Node Group Role
resource "aws_iam_role" "eks_node_role" {
  name = "${var.prefix}-eks-node-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "${var.prefix}-eks-node-role"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "eks_node_AmazonEKSWorkerNodePolicy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
  role       = aws_iam_role.eks_node_role.name
}

resource "aws_iam_role_policy_attachment" "eks_node_AmazonEKS_CNI_Policy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
  role       = aws_iam_role.eks_node_role.name
}

resource "aws_iam_role_policy_attachment" "eks_node_AmazonEC2ContainerRegistryReadOnly" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
  role       = aws_iam_role.eks_node_role.name
}

# Add Bedrock permissions to node role for Claude Code access
resource "aws_iam_role_policy" "eks_node_bedrock_policy" {
  name = "${var.prefix}-eks-node-bedrock-policy"
  role = aws_iam_role.eks_node_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream"
        ]
        Resource = [
          "arn:aws:bedrock:*:*:foundation-model/anthropic.claude-*",
          "arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-sonnet-*"
        ]
      }
    ]
  })
}

# EKS Cluster
resource "aws_eks_cluster" "gpu_dev_cluster" {
  name     = "${var.prefix}-cluster"
  role_arn = aws_iam_role.eks_cluster_role.arn

  vpc_config {
    subnet_ids = [
      aws_subnet.gpu_dev_subnet.id,
      aws_subnet.gpu_dev_subnet_secondary.id
    ]
    security_group_ids = [aws_security_group.eks_control_plane_sg.id]
  }

  depends_on = [
    aws_iam_role_policy_attachment.eks_cluster_AmazonEKSClusterPolicy,
  ]

  tags = {
    Name        = "${var.prefix}-cluster"
    Environment = var.environment
  }
}

# VPC CNI Addon - Required for pod networking
resource "aws_eks_addon" "vpc_cni" {
  cluster_name = aws_eks_cluster.gpu_dev_cluster.name
  addon_name   = "vpc-cni"
  
  depends_on = [aws_eks_cluster.gpu_dev_cluster]
  
  tags = {
    Name        = "${var.prefix}-vpc-cni"
    Environment = var.environment
  }
}


# EKS Managed Node Groups for GPU instances - one per GPU type
resource "aws_eks_node_group" "gpu_dev_nodes" {
  for_each = var.use_self_managed_nodes ? {} : var.supported_gpu_types
  
  cluster_name    = aws_eks_cluster.gpu_dev_cluster.name
  node_group_name = "${var.prefix}-gpu-nodes-${each.key}"
  node_role_arn   = aws_iam_role.eks_node_role.arn
  subnet_ids      = [aws_subnet.gpu_dev_subnet.id]

  # Use CUSTOM AMI type when launch template specifies image_id
  ami_type      = "CUSTOM"
  capacity_type = "ON_DEMAND"

  # Fixed size - no scaling, much faster
  scaling_config {
    desired_size = each.value.instance_count
    max_size     = each.value.instance_count
    min_size     = each.value.instance_count
  }

  # Fast updates - replace all nodes immediately
  update_config {
    max_unavailable_percentage = 100
  }
  
  # Prevent Terraform from trying to manage lifecycle
  lifecycle {
    ignore_changes = [
      scaling_config[0].desired_size
    ]
  }

  # Launch template for custom configuration (EFA, spot instances, etc.)
  launch_template {
    name    = aws_launch_template.gpu_dev_launch_template[each.key].name
    version = aws_launch_template.gpu_dev_launch_template[each.key].latest_version
  }

  depends_on = [
    aws_iam_role_policy_attachment.eks_node_AmazonEKSWorkerNodePolicy,
    aws_iam_role_policy_attachment.eks_node_AmazonEKS_CNI_Policy,
    aws_iam_role_policy_attachment.eks_node_AmazonEC2ContainerRegistryReadOnly,
    kubernetes_config_map.aws_auth  # Ensure aws-auth is configured before nodes join
  ]

  tags = {
    Name        = "${var.prefix}-gpu-nodes-${each.key}"
    Environment = var.environment
    GpuType     = each.key
  }
}

# Self-Managed Auto Scaling Groups - one per GPU type
resource "aws_autoscaling_group" "gpu_dev_nodes_self_managed" {
  for_each = var.use_self_managed_nodes ? var.supported_gpu_types : {}
  
  name                = "${var.prefix}-gpu-nodes-self-managed-${each.key}"
  vpc_zone_identifier = [aws_subnet.gpu_dev_subnet.id]
  target_group_arns   = []
  health_check_type   = "EC2"
  health_check_grace_period = 300

  min_size         = each.value.instance_count
  max_size         = each.value.instance_count
  desired_capacity = each.value.instance_count

  # Don't wait for instances to become healthy - prevents Terraform failures when AWS can't place instances
  wait_for_capacity_timeout = "0"

  # Use mixed instances policy for multiple instance types (like H200)
  dynamic "mixed_instances_policy" {
    for_each = each.value.instance_types != null ? [1] : []
    content {
      launch_template {
        launch_template_specification {
          launch_template_id = aws_launch_template.gpu_dev_launch_template_self_managed[each.key].id
          version            = "$Latest"
        }
        
        # Allow both p5e.48xlarge and p5en.48xlarge for H200
        dynamic "override" {
          for_each = each.value.instance_types
          content {
            instance_type = override.value
          }
        }
      }
    }
  }

  # Use single launch template for single instance types
  dynamic "launch_template" {
    for_each = each.value.instance_types == null ? [1] : []
    content {
      id      = aws_launch_template.gpu_dev_launch_template_self_managed[each.key].id
      version = "$Latest"
    }
  }

  # Fast instance replacement
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 0  # Replace all at once for speed
    }
  }

  tag {
    key                 = "Name"
    value               = "${var.prefix}-gpu-node-self-managed-${each.key}"
    propagate_at_launch = true
  }

  tag {
    key                 = "kubernetes.io/cluster/${aws_eks_cluster.gpu_dev_cluster.name}"
    value               = "owned"
    propagate_at_launch = true
  }

  tag {
    key                 = "Environment"
    value               = var.environment
    propagate_at_launch = true
  }

  tag {
    key                 = "GpuType"
    value               = each.key
    propagate_at_launch = true
  }
}

# Launch templates for self-managed nodes - one per GPU type
resource "aws_launch_template" "gpu_dev_launch_template_self_managed" {
  for_each = var.use_self_managed_nodes ? var.supported_gpu_types : {}
  
  name_prefix = "${var.prefix}-gpu-self-managed-${each.key}-"
  image_id    = data.aws_ami.eks_gpu_ami.id
  key_name    = var.key_pair_name
  
  # Only set instance_type if not using mixed instances policy
  instance_type = each.value.instance_types == null ? each.value.instance_type : null

  iam_instance_profile {
    name = aws_iam_instance_profile.eks_node_instance_profile.name
  }

  # Block device mapping for 4TB root volume
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 4096  # 4TB
      volume_type           = "gp3"
      delete_on_termination = true
      encrypted             = true
    }
  }

  placement {
    group_name = aws_placement_group.gpu_dev_pg.name
  }

  # Network interface (EFA for H100/H200 instance types)
  network_interfaces {
    associate_public_ip_address = true
    security_groups             = [aws_security_group.gpu_dev_sg.id]
    interface_type = (
      # Check if any instance type in the list supports EFA
      each.value.instance_types != null ? 
        (length([for it in each.value.instance_types : it if can(regex("^(p5\\.48xlarge|p5e\\.48xlarge|p5en\\.48xlarge)$", it))]) > 0 ? "efa" : "interface") :
        # Single instance type check
        can(regex("^(p5\\.48xlarge|p5e\\.48xlarge|p5en\\.48xlarge)$", each.value.instance_type)) ? "efa" : "interface"
    )
    delete_on_termination = true
  }

  # Conditionally add instance_market_options for p5.48xlarge instances
  dynamic "instance_market_options" {
    for_each = (
      # Check if single instance type is p5.48xlarge
      each.value.instance_types == null ? 
        (each.value.instance_type == "p5.48xlarge" ? [1] : []) :
        # Check if any instance type in the list is p5.48xlarge
        (length([for it in each.value.instance_types : it if it == "p5.48xlarge"]) > 0 ? [1] : [])
    )
    content {
      market_type = "capacity-block"
    }
  }

  user_data = base64encode(templatefile("${path.module}/templates/user-data-self-managed.sh", {
    cluster_name = aws_eks_cluster.gpu_dev_cluster.name
    region       = var.aws_region
    gpu_type     = each.key
  }))

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name        = "${var.prefix}-gpu-instance-self-managed-${each.key}"
      Environment = var.environment
      GpuType     = each.key
    }
  }

  tags = {
    Name        = "${var.prefix}-gpu-launch-template-self-managed-${each.key}"
    Environment = var.environment
    GpuType     = each.key
  }
}

# IAM Instance Profile for self-managed nodes
resource "aws_iam_instance_profile" "eks_node_instance_profile" {
  name = "${var.prefix}-eks-node-instance-profile"
  role = aws_iam_role.eks_node_role.name

  tags = {
    Name        = "${var.prefix}-eks-node-instance-profile"
    Environment = var.environment
  }
}

# Launch templates for EFA networking (Managed Node Groups) - one per GPU type
resource "aws_launch_template" "gpu_dev_launch_template" {
  for_each = var.supported_gpu_types
  
  name_prefix = "${var.prefix}-gpu-lt-${each.key}-"
  image_id    = data.aws_ami.eks_gpu_ami.id
  key_name    = var.key_pair_name
  
  # Only set instance_type if not using mixed instances policy
  instance_type = each.value.instance_types == null ? each.value.instance_type : null

  # Block device mapping for 4TB root volume
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 4096  # 4TB
      volume_type           = "gp3"
      delete_on_termination = true
      encrypted             = true
    }
  }

  # Only use placement group if specified
  dynamic "placement" {
    for_each = each.value.use_placement_group ? [1] : []
    content {
      group_name = aws_placement_group.gpu_dev_pg.name
    }
  }

  # Network interface (EFA for H100/H200 instance types)
  network_interfaces {
    associate_public_ip_address = true
    security_groups             = [aws_security_group.gpu_dev_sg.id]
    interface_type = (
      # Check if any instance type in the list supports EFA
      each.value.instance_types != null ? 
        (length([for it in each.value.instance_types : it if can(regex("^(p5\\.48xlarge|p5e\\.48xlarge|p5en\\.48xlarge)$", it))]) > 0 ? "efa" : "interface") :
        # Single instance type check
        can(regex("^(p5\\.48xlarge|p5e\\.48xlarge|p5en\\.48xlarge)$", each.value.instance_type)) ? "efa" : "interface"
    )
  }

  user_data = base64encode(templatefile("${path.module}/templates/user-data.sh", {
    cluster_name = aws_eks_cluster.gpu_dev_cluster.name
    region       = var.aws_region
    gpu_type     = each.key
  }))

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name        = "${var.prefix}-gpu-instance-${each.key}"
      Environment = var.environment
      GpuType     = each.key
    }
  }

  tags = {
    Name        = "${var.prefix}-gpu-launch-template-${each.key}"
    Environment = var.environment
    GpuType     = each.key
  }
}

# Get the latest EKS-optimized AL2023 GPU AMI for the cluster version
data "aws_ami" "eks_gpu_ami" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["amazon-eks-node-al2023-x86_64-nvidia-1.33-*"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}