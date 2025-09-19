# EKS Cluster for GPU workload management

# EKS Cluster Service Role
resource "aws_iam_role" "eks_cluster_role" {
  name = "${local.workspace_prefix}-eks-cluster-role"

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
    Environment = local.current_config.environment
  }
}

resource "aws_iam_role_policy_attachment" "eks_cluster_AmazonEKSClusterPolicy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
  role       = aws_iam_role.eks_cluster_role.name
}

# EKS Node Group Role
resource "aws_iam_role" "eks_node_role" {
  name = "${local.workspace_prefix}-eks-node-role"

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
    Environment = local.current_config.environment
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

resource "aws_iam_role_policy_attachment" "eks_node_AmazonEBSCSIDriverPolicy" {
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
  role       = aws_iam_role.eks_node_role.name
}

# Add Bedrock permissions to node role for Claude Code access
resource "aws_iam_role_policy" "eks_node_bedrock_policy" {
  name = "${local.workspace_prefix}-eks-node-bedrock-policy"
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
          "arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-*"
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
    subnet_ids = concat([
      aws_subnet.gpu_dev_subnet.id,
      aws_subnet.gpu_dev_subnet_secondary.id
    ], length(aws_subnet.gpu_dev_subnet_tertiary) > 0 ? [aws_subnet.gpu_dev_subnet_tertiary[0].id] : [])
    security_group_ids = [aws_security_group.eks_control_plane_sg.id]
  }

  depends_on = [
    aws_iam_role_policy_attachment.eks_cluster_AmazonEKSClusterPolicy,
  ]

  tags = {
    Name        = "${var.prefix}-cluster"
    Environment = local.current_config.environment
  }
}

# VPC CNI Addon - Required for pod networking
resource "aws_eks_addon" "vpc_cni" {
  cluster_name = aws_eks_cluster.gpu_dev_cluster.name
  addon_name   = "vpc-cni"

  depends_on = [aws_eks_cluster.gpu_dev_cluster]

  tags = {
    Name        = "${var.prefix}-vpc-cni"
    Environment = local.current_config.environment
  }
}

# EBS CSI Driver Addon - Required for persistent EBS volumes
resource "aws_eks_addon" "ebs_csi_driver" {
  cluster_name = aws_eks_cluster.gpu_dev_cluster.name
  addon_name   = "aws-ebs-csi-driver"

  depends_on = [aws_eks_cluster.gpu_dev_cluster]

  tags = {
    Name        = "${var.prefix}-ebs-csi-driver"
    Environment = local.current_config.environment
  }
}

locals {
  # Flatten capacity reservations to create multiple ASGs when needed
  gpu_capacity_reservations = flatten([
    for gpu_type, gpu_config in local.current_config.supported_gpu_types : [
      for cr_index, cr_config in try(local.capacity_reservations[terraform.workspace][gpu_type], [null]) : {
        gpu_type = gpu_type
        gpu_config = gpu_config
        capacity_reservation_id = cr_config != null ? cr_config.id : null
        asg_key = cr_config != null ? "${gpu_type}-cr${cr_index}" : gpu_type
        # Use manual instance count from capacity reservation config, fallback to GPU config default
        instance_count = cr_config != null ? cr_config.instance_count : gpu_config.instance_count
      }
    ]
  ])

  # Convert to map for for_each
  gpu_asg_configs = {
    for item in local.gpu_capacity_reservations : item.asg_key => item
  }
}

# Auto Scaling Groups - one per GPU type + capacity reservation combination
resource "aws_autoscaling_group" "gpu_dev_nodes" {
  for_each = local.gpu_asg_configs

  name                      = "${var.prefix}-gpu-nodes-${each.key}"
  vpc_zone_identifier       = (
    local.gpu_subnet_assignments[terraform.workspace][each.value.gpu_type] == "secondary" ? [aws_subnet.gpu_dev_subnet_secondary.id] :
    local.gpu_subnet_assignments[terraform.workspace][each.value.gpu_type] == "tertiary" && length(aws_subnet.gpu_dev_subnet_tertiary) > 0 ? [aws_subnet.gpu_dev_subnet_tertiary[0].id] :
    [aws_subnet.gpu_dev_subnet.id]
  )
  target_group_arns         = []
  health_check_type         = "EC2"
  health_check_grace_period = 300

  # Use dynamic instance count from capacity reservation
  min_size         = each.value.instance_count
  max_size         = each.value.instance_count
  desired_capacity = each.value.instance_count

  # Don't wait for instances to become healthy - prevents Terraform failures when AWS can't place instances
  wait_for_capacity_timeout = "0"

  # Use mixed instances policy for multiple instance types (like H200)
  # But NOT when using capacity reservations (AWS doesn't allow mixed instances with CR)
  dynamic "mixed_instances_policy" {
    for_each = each.value.gpu_config.instance_types != null && each.value.capacity_reservation_id == null ? [1] : []
    content {
      launch_template {
        launch_template_specification {
          launch_template_id = aws_launch_template.gpu_dev_launch_template[each.key].id
          version            = "$Latest"
        }

        # Allow both p5e.48xlarge and p5en.48xlarge for H200
        dynamic "override" {
          for_each = each.value.gpu_config.instance_types
          content {
            instance_type = override.value
          }
        }
      }
    }
  }

  # Use single launch template for single instance types OR when using capacity reservations
  # (capacity reservations don't support mixed instances policy)
  dynamic "launch_template" {
    for_each = each.value.gpu_config.instance_types == null || each.value.capacity_reservation_id != null ? [1] : []
    content {
      id      = aws_launch_template.gpu_dev_launch_template[each.key].id
      version = "$Latest"
    }
  }

  # Fast instance replacement
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 0 # Replace all at once for speed
    }
  }

  tag {
    key                 = "Name"
    value               = "${var.prefix}-gpu-node-${each.key}"
    propagate_at_launch = true
  }

  tag {
    key                 = "kubernetes.io/cluster/${aws_eks_cluster.gpu_dev_cluster.name}"
    value               = "owned"
    propagate_at_launch = true
  }

  tag {
    key                 = "Environment"
    value               = local.current_config.environment
    propagate_at_launch = true
  }

  tag {
    key                 = "GpuType"
    value               = each.value.gpu_type
    propagate_at_launch = true
  }

  tag {
    key                 = "CapacityReservation"
    value               = each.value.capacity_reservation_id != null ? each.value.capacity_reservation_id : "none"
    propagate_at_launch = true
  }
}


# Launch templates - one per GPU type + capacity reservation combination
resource "aws_launch_template" "gpu_dev_launch_template" {
  for_each = local.gpu_asg_configs

  name_prefix = "${var.prefix}-gpu-${each.key}-"
  image_id    = data.aws_ami.eks_gpu_ami.id
  key_name    = var.key_pair_name

  # Set instance_type if not using mixed instances policy OR if using capacity reservations
  # (capacity reservations require single instance type in launch template)
  instance_type = each.value.gpu_config.instance_types == null || each.value.capacity_reservation_id != null ? each.value.gpu_config.instance_type : null

  iam_instance_profile {
    name = aws_iam_instance_profile.eks_node_instance_profile.name
  }

  # Block device mapping for 4TB root volume (Amazon Linux 2023 uses /dev/xvda as root)
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 4096 # 4TB
      volume_type           = "gp3"
      delete_on_termination = true
      encrypted             = true
    }
  }

  # Only use placement group if specified
  # NOTE: This is key for instances where we are using capacity blocks / reservations
  dynamic "placement" {
    for_each = each.value.gpu_config.use_placement_group ? [1] : []
    content {
      group_name = aws_placement_group.gpu_dev_pg[each.value.gpu_type].name
    }
  }

  # Network interface (EFA enabled for supported instance types only)
  network_interfaces {
    associate_public_ip_address = true
    security_groups             = [aws_security_group.gpu_dev_sg.id]
    subnet_id                   = each.value.gpu_config.use_placement_group ? null : (local.gpu_subnet_assignments[terraform.workspace][each.value.gpu_type] == "secondary" ? aws_subnet.gpu_dev_subnet_secondary.id : aws_subnet.gpu_dev_subnet.id)
    # EFA is not supported on g4dn.2xlarge (t4-small), only on larger instances
    interface_type              = each.value.gpu_type == "t4-small" ? "interface" : "efa"
    delete_on_termination       = true
  }

  # Conditionally add instance_market_options for capacity block instances (only when capacity reservation exists)
  dynamic "instance_market_options" {
    for_each = each.value.capacity_reservation_id != null ? [1] : []
    content {
      market_type = "capacity-block"
    }
  }

  # Add capacity reservation specification for instances that have reservations configured
  dynamic "capacity_reservation_specification" {
    for_each = each.value.capacity_reservation_id != null ? [1] : []
    content {
      capacity_reservation_preference = "capacity-reservations-only"
      capacity_reservation_target {
        capacity_reservation_id = each.value.capacity_reservation_id
      }
    }
  }

  user_data = base64encode(templatefile("${path.module}/templates/al2023-user-data.sh", {
    cluster_name     = aws_eks_cluster.gpu_dev_cluster.name
    cluster_endpoint = aws_eks_cluster.gpu_dev_cluster.endpoint
    cluster_ca       = aws_eks_cluster.gpu_dev_cluster.certificate_authority[0].data
    cluster_cidr     = var.vpc_cidr
    region           = local.current_config.aws_region
    gpu_type         = each.value.gpu_type
  }))

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name               = "${var.prefix}-gpu-instance-${each.key}"
      Environment        = local.current_config.environment
      GpuType           = each.value.gpu_type
      CapacityReservation = each.value.capacity_reservation_id != null ? each.value.capacity_reservation_id : "none"
    }
  }

  tags = {
    Name               = "${var.prefix}-gpu-launch-template-${each.key}"
    Environment        = local.current_config.environment
    GpuType           = each.value.gpu_type
    CapacityReservation = each.value.capacity_reservation_id != null ? each.value.capacity_reservation_id : "none"
  }
}

# IAM Instance Profile for GPU nodes
resource "aws_iam_instance_profile" "eks_node_instance_profile" {
  name = "${local.workspace_prefix}-eks-node-instance-profile"
  role = aws_iam_role.eks_node_role.name

  tags = {
    Name        = "${var.prefix}-eks-node-instance-profile"
    Environment = local.current_config.environment
  }
}


# Using only Auto Scaling Groups for GPU nodes

# Get the latest EKS-optimized AL2023 GPU AMI for the cluster version
data "aws_ami" "eks_gpu_ami" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["amazon-eks-node-al2023-x86_64-standard-1.33-*"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

# Deep Learning Base AMI for high-end GPU instances (H100, H200, B200) - has proper IPv6 networking
data "aws_ami" "deep_learning_gpu_ami" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) *"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }
  filter {
    name   = "state"
    values = ["available"]
  }
}

# CPU Launch template and Auto Scaling Group (consistent with GPU nodes)
resource "aws_launch_template" "cpu_launch_template" {
  name_prefix = "${var.prefix}-cpu-"
  image_id    = data.aws_ami.eks_gpu_ami.id
  key_name    = var.key_pair_name
  instance_type = "c5.4xlarge"

  vpc_security_group_ids = [aws_security_group.gpu_dev_sg.id]

  # Block device mapping for 4TB root volume (Amazon Linux 2023 uses /dev/xvda as root)
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 4096 # 4TB
      volume_type           = "gp3"
      delete_on_termination = true
      encrypted             = true
    }
  }

  iam_instance_profile {
    name = aws_iam_instance_profile.eks_node_instance_profile.name
  }

  user_data = base64encode(templatefile("${path.module}/templates/al2023-cpu-user-data.sh", {
    cluster_name     = aws_eks_cluster.gpu_dev_cluster.name
    cluster_endpoint = aws_eks_cluster.gpu_dev_cluster.endpoint
    cluster_ca       = aws_eks_cluster.gpu_dev_cluster.certificate_authority[0].data
    cluster_cidr     = var.vpc_cidr
    region           = local.current_config.aws_region
    gpu_type         = "cpu"
  }))

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name        = "${var.prefix}-cpu-mgmt-node"
      Environment = local.current_config.environment
      NodeType    = "cpu-management"
    }
  }

  tags = {
    Name        = "${var.prefix}-cpu-launch-template"
    Environment = local.current_config.environment
  }
}

resource "aws_autoscaling_group" "cpu_nodes" {
  name                = "${var.prefix}-cpu-nodes"
  vpc_zone_identifier = [aws_subnet.gpu_dev_subnet.id, aws_subnet.gpu_dev_subnet_secondary.id]
  target_group_arns   = []
  health_check_type   = "EC2"
  health_check_grace_period = 300

  min_size         = 1
  max_size         = 4
  desired_capacity = 2

  launch_template {
    id      = aws_launch_template.cpu_launch_template.id
    version = "$Latest"
  }

  # Fast instance replacement
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 0
    }
  }

  tag {
    key                 = "Name"
    value               = "${var.prefix}-cpu-mgmt-node"
    propagate_at_launch = true
  }

  tag {
    key                 = "kubernetes.io/cluster/${aws_eks_cluster.gpu_dev_cluster.name}"
    value               = "owned"
    propagate_at_launch = true
  }

  tag {
    key                 = "Environment"
    value               = local.current_config.environment
    propagate_at_launch = true
  }

  tag {
    key                 = "NodeType"
    value               = "cpu-management"
    propagate_at_launch = true
  }
}
