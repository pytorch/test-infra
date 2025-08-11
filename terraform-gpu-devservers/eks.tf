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

# EKS Cluster
resource "aws_eks_cluster" "gpu_dev_cluster" {
  name     = "${var.prefix}-cluster"
  role_arn = aws_iam_role.eks_cluster_role.arn

  vpc_config {
    subnet_ids = [
      aws_subnet.gpu_dev_subnet.id,
      aws_subnet.gpu_dev_subnet_secondary.id
    ]
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

# EKS Node Group for GPU instances
resource "aws_eks_node_group" "gpu_dev_nodes" {
  cluster_name    = aws_eks_cluster.gpu_dev_cluster.name
  node_group_name = "${var.prefix}-gpu-nodes"
  node_role_arn   = aws_iam_role.eks_node_role.arn
  subnet_ids      = [aws_subnet.gpu_dev_subnet.id]

  # Use CUSTOM AMI type when launch template specifies image_id
  ami_type      = "CUSTOM"
  capacity_type = "ON_DEMAND"

  scaling_config {
    desired_size = 2
    max_size     = var.gpu_instance_count
    min_size     = 0
  }

  update_config {
    max_unavailable = 2
  }

  # Launch template for custom configuration (EFA, spot instances, etc.)
  launch_template {
    name    = aws_launch_template.gpu_dev_launch_template.name
    version = aws_launch_template.gpu_dev_launch_template.latest_version
  }

  depends_on = [
    aws_iam_role_policy_attachment.eks_node_AmazonEKSWorkerNodePolicy,
    aws_iam_role_policy_attachment.eks_node_AmazonEKS_CNI_Policy,
    aws_iam_role_policy_attachment.eks_node_AmazonEC2ContainerRegistryReadOnly,
    kubernetes_config_map.aws_auth,  # Ensure aws-auth is configured before nodes join
  ]

  tags = {
    Name        = "${var.prefix}-gpu-nodes"
    Environment = var.environment
  }
}

# Launch template for EFA networking
resource "aws_launch_template" "gpu_dev_launch_template" {
  name_prefix   = "${var.prefix}-gpu-lt-"
  image_id      = data.aws_ami.eks_gpu_ami.id
  instance_type = var.instance_type
  key_name      = var.key_pair_name

  placement {
    group_name = aws_placement_group.gpu_dev_pg.name
  }

  # Network interface (EFA only for supported instance types like p5.48xlarge)
  network_interfaces {
    associate_public_ip_address = true
    security_groups             = [aws_security_group.gpu_dev_sg.id]
    interface_type              = can(regex("^(p5\\.48xlarge|p6-b200\\.48xlarge)$", var.instance_type)) ? "efa" : "interface"
  }

  user_data = base64encode(templatefile("${path.module}/templates/user-data.sh", {
    cluster_name = aws_eks_cluster.gpu_dev_cluster.name
    region       = var.aws_region
  }))

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name        = "${var.prefix}-gpu-instance"
      Environment = var.environment
    }
  }

  tags = {
    Name        = "${var.prefix}-gpu-launch-template"
    Environment = var.environment
  }
}

# Get the latest EKS-optimized GPU AMI for the cluster version
data "aws_ami" "eks_gpu_ami" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["amazon-eks-gpu-node-*"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}