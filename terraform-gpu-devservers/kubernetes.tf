# Kubernetes resources for GPU development pods

# AWS Auth ConfigMap to allow Lambda roles to access EKS
# Use the kubernetes_config_map resource to manage the full ConfigMap
resource "kubernetes_config_map" "aws_auth" {
  depends_on = [
    aws_eks_cluster.gpu_dev_cluster
  ]

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
}

# Namespace for GPU development pods
resource "kubernetes_namespace" "gpu_dev" {
  depends_on = [aws_eks_cluster.gpu_dev_cluster]

  metadata {
    name = "gpu-dev"
    labels = {
      name    = "gpu-dev"
      purpose = "gpu-development"
    }
  }
}

# Service account for GPU development pods
resource "kubernetes_service_account" "gpu_dev_sa" {
  depends_on = [aws_eks_cluster.gpu_dev_cluster]

  metadata {
    name      = "gpu-dev-service-account"
    namespace = kubernetes_namespace.gpu_dev.metadata[0].name
  }
}

# Role for GPU development pods (basic permissions)
resource "kubernetes_role" "gpu_dev_role" {
  depends_on = [aws_eks_cluster.gpu_dev_cluster]

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
  depends_on = [aws_eks_cluster.gpu_dev_cluster]

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

# NVIDIA Device Plugin is now managed by gpu-operator (see helm_release.nvidia_gpu_operator)
# Removed the manual kubernetes_daemonset to avoid conflicts

# AWS EFA Device Plugin to expose EFA resources to Kubernetes
resource "kubernetes_service_account" "efa_device_plugin_sa" {
  depends_on = [aws_eks_cluster.gpu_dev_cluster]

  metadata {
    name      = "aws-efa-k8s-device-plugin"
    namespace = "kube-system"
  }
}

resource "kubernetes_daemonset" "efa_device_plugin" {
  depends_on = [
    aws_eks_cluster.gpu_dev_cluster,
    aws_autoscaling_group.gpu_dev_nodes
  ]

  metadata {
    name      = "aws-efa-k8s-device-plugin-daemonset"
    namespace = "kube-system"
  }

  spec {
    selector {
      match_labels = {
        name = "aws-efa-k8s-device-plugin"
      }
    }

    template {
      metadata {
        labels = {
          name = "aws-efa-k8s-device-plugin"
        }
      }

      spec {
        service_account_name = kubernetes_service_account.efa_device_plugin_sa.metadata[0].name
        host_network        = true

        toleration {
          key      = "CriticalAddonsOnly"
          operator = "Exists"
        }

        toleration {
          key      = "aws.amazon.com/efa"
          operator = "Exists"
          effect   = "NoSchedule"
        }

        node_selector = {
          "kubernetes.io/arch" = "amd64"
        }

        container {
          image = "602401143452.dkr.ecr.us-west-2.amazonaws.com/eks/aws-efa-k8s-device-plugin:v0.3.3"
          name  = "aws-efa-k8s-device-plugin"
          image_pull_policy = "Always"

          resources {
            requests = {
              cpu    = "10m"
              memory = "10Mi"
            }
            limits = {
              cpu    = "10m"
              memory = "10Mi"
            }
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

          volume_mount {
            name       = "proc"
            mount_path = "/host/proc"
          }

          volume_mount {
            name       = "sys"
            mount_path = "/host/sys"
          }
        }

        volume {
          name = "device-plugin"
          host_path {
            path = "/var/lib/kubelet/device-plugins"
          }
        }

        volume {
          name = "proc"
          host_path {
            path = "/proc"
          }
        }

        volume {
          name = "sys"
          host_path {
            path = "/sys"
          }
        }
      }
    }
  }
}

# NVIDIA GPU Operator - manages GPU drivers, device plugin, and monitoring
resource "helm_release" "nvidia_gpu_operator" {
  depends_on = [
    aws_eks_cluster.gpu_dev_cluster,
    aws_autoscaling_group.gpu_dev_nodes
  ]

  name       = "gpu-operator"
  repository = "https://helm.ngc.nvidia.com/nvidia"
  chart      = "gpu-operator"
  version    = "v25.3.3"
  namespace  = "gpu-operator"
  create_namespace = true

  # Wait for the operator to be ready
  wait = true
  timeout = 600

  set {
    name  = "operator.defaultRuntime"
    value = "containerd"
  }

  # Disable driver installation - drivers pre-installed on host via user-data
  set {
    name  = "driver.enabled"
    value = "false"
  }

  # Driver installation disabled - using host-installed drivers

  set {
    name  = "toolkit.enabled"
    value = "true"
  }

  set {
    name  = "devicePlugin.enabled"
    value = "true"
  }

  set {
    name  = "dcgmExporter.enabled"
    value = "true"
  }

  set {
    name  = "gfd.enabled"
    value = "true"
  }

  set {
    name  = "migManager.enabled"
    value = "true"
  }

  set {
    name  = "mig.strategy"
    value = "mixed"
  }

  # Configure MIG to expose full GPUs by default (not partitioned)
  set {
    name  = "migManager.config.default"
    value = "all-disabled"
  }

  set {
    name  = "nodeStatusExporter.enabled"
    value = "true"
  }

  # Tolerations for GPU nodes
  set {
    name  = "operator.tolerations[0].key"
    value = "nvidia.com/gpu"
  }

  set {
    name  = "operator.tolerations[0].operator"
    value = "Exists"
  }

  set {
    name  = "operator.tolerations[0].effect"
    value = "NoSchedule"
  }

  # Tolerations for CPU-only nodes
  set {
    name  = "operator.tolerations[1].key"
    value = "node-role"
  }

  set {
    name  = "operator.tolerations[1].operator"
    value = "Equal"
  }

  set {
    name  = "operator.tolerations[1].value"
    value = "cpu-only"
  }

  set {
    name  = "operator.tolerations[1].effect"
    value = "NoSchedule"
  }

  # Prefer CPU management nodes for GPU operator control plane components
  set {
    name  = "operator.nodeSelector.NodeType"
    value = "cpu"
  }

  # Runtime class configuration - toolkit uses default runtime, others use nvidia
  set {
    name  = "toolkit.runtimeClass"
    value = ""
  }

  # Other components can use nvidia runtime once it's configured by container toolkit
  set {
    name  = "devicePlugin.runtimeClass"
    value = "nvidia"
  }

  set {
    name  = "dcgmExporter.runtimeClass"
    value = "nvidia"
  }

  set {
    name  = "gfd.runtimeClass"
    value = "nvidia"
  }
}
