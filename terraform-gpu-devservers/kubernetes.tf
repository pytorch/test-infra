# Kubernetes resources for GPU development pods

# AWS Auth ConfigMap to allow Lambda roles to access EKS
# Use the kubernetes_config_map resource to manage the full ConfigMap
resource "kubernetes_config_map" "aws_auth" {
  metadata {
    name      = "aws-auth"
    namespace = "kube-system"
  }

  data = {
    mapRoles = yamlencode([
      # EKS Node Group role (required for nodes to join cluster)
      {
        rolearn  = aws_iam_role.eks_node_role.arn
        username = "system:node:{{EC2PrivateDNSName}}"
        groups   = [
          "system:bootstrappers",
          "system:nodes"
        ]
      },
      # Lambda reservation processor role
      {
        rolearn  = aws_iam_role.reservation_processor_role.arn
        username = "lambda-reservation-processor"
        groups   = [
          "system:masters"  # Full access needed for pod/service creation
        ]
      },
      # Lambda reservation expiry role
      {
        rolearn  = aws_iam_role.reservation_expiry_role.arn
        username = "lambda-reservation-expiry"
        groups   = [
          "system:masters"  # Full access needed for pod cleanup
        ]
      }
    ])
  }

  # Ensure this is created after the cluster but before nodes try to join
  depends_on = [
    aws_eks_cluster.gpu_dev_cluster
  ]
}

# Namespace for GPU development pods
resource "kubernetes_namespace" "gpu_dev" {
  metadata {
    name = "gpu-dev"
    labels = {
      name = "gpu-dev"
      purpose = "gpu-development"
    }
  }

  depends_on = [aws_eks_node_group.gpu_dev_nodes]
}

# Service account for GPU development pods
resource "kubernetes_service_account" "gpu_dev_sa" {
  metadata {
    name      = "gpu-dev-service-account"
    namespace = kubernetes_namespace.gpu_dev.metadata[0].name
  }
}

# Role for GPU development pods (basic permissions)
resource "kubernetes_role" "gpu_dev_role" {
  metadata {
    namespace = kubernetes_namespace.gpu_dev.metadata[0].name
    name      = "gpu-dev-role"
  }

  rule {
    api_groups = [""]
    resources  = ["pods", "pods/log", "pods/exec"]
    verbs      = ["get", "list", "create", "update", "patch", "watch"]
  }
}

# Role binding for GPU development service account
resource "kubernetes_role_binding" "gpu_dev_role_binding" {
  metadata {
    name      = "gpu-dev-role-binding"
    namespace = kubernetes_namespace.gpu_dev.metadata[0].name
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role.gpu_dev_role.metadata[0].name
  }

  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account.gpu_dev_sa.metadata[0].name
    namespace = kubernetes_namespace.gpu_dev.metadata[0].name
  }
}