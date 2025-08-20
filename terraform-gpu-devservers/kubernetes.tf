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
        groups = [
          "system:bootstrappers",
          "system:nodes"
        ]
      },
      # Lambda reservation processor role
      {
        rolearn  = aws_iam_role.reservation_processor_role.arn
        username = "lambda-reservation-processor"
        groups = [
          "system:masters" # Full access needed for pod/service creation
        ]
      },
      # Lambda reservation expiry role
      {
        rolearn  = aws_iam_role.reservation_expiry_role.arn
        username = "lambda-reservation-expiry"
        groups = [
          "system:masters" # Full access needed for pod cleanup
        ]
      },
      # Lambda availability updater role
      {
        rolearn  = aws_iam_role.availability_updater_role.arn
        username = "lambda-availability-updater"
        groups = [
          "system:masters" # Full access needed for node/pod queries
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
      name    = "gpu-dev"
      purpose = "gpu-development"
    }
  }

  depends_on = [
    aws_eks_cluster.gpu_dev_cluster
    # Wait for either managed or self-managed nodes to be ready
  ]
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

# NVIDIA Device Plugin to expose GPU resources to Kubernetes
resource "kubernetes_daemonset" "nvidia_device_plugin" {
  metadata {
    name      = "nvidia-device-plugin-daemonset"
    namespace = "kube-system"
  }

  spec {
    selector {
      match_labels = {
        name = "nvidia-device-plugin-ds"
      }
    }

    template {
      metadata {
        labels = {
          name = "nvidia-device-plugin-ds"
        }
      }

      spec {
        priority_class_name = "system-node-critical"

        toleration {
          key      = "nvidia.com/gpu"
          operator = "Exists"
          effect   = "NoSchedule"
        }

        node_selector = {
          "kubernetes.io/arch" = "amd64"
        }

        container {
          image = "nvcr.io/nvidia/k8s-device-plugin:v0.14.5"
          name  = "nvidia-device-plugin-ctr"

          env {
            name  = "FAIL_ON_INIT_ERROR"
            value = "false"
          }

          security_context {
            allow_privilege_escalation = false
            capabilities {
              drop = ["ALL"]
            }
          }

          volume_mount {
            name       = "device-plugin"
            mount_path = "/var/lib/kubelet/device-plugins"
          }
        }

        volume {
          name = "device-plugin"
          host_path {
            path = "/var/lib/kubelet/device-plugins"
          }
        }
      }
    }
  }

  depends_on = [
    aws_eks_cluster.gpu_dev_cluster
    # Will work with either managed or self-managed nodes
  ]
}