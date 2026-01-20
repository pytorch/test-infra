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

  # Note: DCGM exclusion from profiling-dedicated nodes is handled via node label:
  # nvidia.com/gpu.deploy.dcgm-exporter=false (set in al2023-user-data.sh for profiling nodes)

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

# DaemonSet to pre-pull GPU dev container image on all GPU nodes
# This ensures first user on new node doesn't wait for slow image pull
# After rebuilding image, trigger re-pull with: kubectl rollout restart daemonset gpu-dev-image-prepuller -n kube-system
resource "kubernetes_manifest" "image_prepuller_daemonset" {
  # force_conflicts needed because ecr.tf runs "kubectl rollout restart" after each image push,
  # which adds an annotation owned by kubectl-rollout that would otherwise conflict with terraform
  field_manager {
    force_conflicts = true
  }

  # Tell provider these fields are server-managed and shouldn't cause drift errors
  computed_fields = [
    "metadata.annotations[\"deprecated.daemonset.template.generation\"]",
    "metadata.annotations[\"kubectl.kubernetes.io/restartedAt\"]",
  ]

  manifest = {
    apiVersion = "apps/v1"
    kind       = "DaemonSet"
    metadata = {
      name      = "gpu-dev-image-prepuller"
      namespace = "kube-system"
      labels = {
        app = "image-prepuller"
      }
    }
    spec = {
      selector = {
        matchLabels = {
          app = "image-prepuller"
        }
      }
      template = {
        metadata = {
          labels = {
            app = "image-prepuller"
          }
        }
        spec = {
          nodeSelector = {
            NodeType                         = "gpu"
            "kubernetes.io/arch"            = "amd64"
          }
          tolerations = [
            {
              key      = "nvidia.com/gpu"
              operator = "Exists"
              effect   = "NoSchedule"
            }
          ]
          initContainers = [
            {
              name            = "pull-gpu-dev-image"
              image           = local.latest_image_uri  # Use stable 'latest' tag
              imagePullPolicy = "Always"
              command         = ["/bin/sh", "-c", "echo 'GPU dev image pulled successfully'"]
            }
          ]
          containers = [
            {
              name  = "pause"
              image = "registry.k8s.io/pause:3.10"
              resources = {
                requests = {
                  cpu    = "10m"
                  memory = "10Mi"
                }
                limits = {
                  cpu    = "10m"
                  memory = "10Mi"
                }
              }
            }
          ]
        }
      }
    }
  }

  depends_on = [
    null_resource.docker_build_and_push
  ]
}

# GPU types that should have one node labeled for Nsight profiling (no DCGM)
locals {
  profiling_gpu_types = {
    default = ["t4"]           # Test: one T4 node for profiling
    prod    = ["h200", "b200"] # Prod: one H200 and one B200 node for profiling
  }
}

# ServiceAccount for profiling node labeler
resource "kubernetes_service_account" "profiling_labeler" {
  metadata {
    name      = "profiling-node-labeler"
    namespace = "kube-system"
  }
}

# ClusterRole to allow labeling nodes
resource "kubernetes_cluster_role" "profiling_labeler" {
  metadata {
    name = "profiling-node-labeler"
  }

  rule {
    api_groups = [""]
    resources  = ["nodes"]
    verbs      = ["get", "list", "patch"]
  }
}

# ClusterRoleBinding for profiling labeler
resource "kubernetes_cluster_role_binding" "profiling_labeler" {
  metadata {
    name = "profiling-node-labeler"
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = kubernetes_cluster_role.profiling_labeler.metadata[0].name
  }

  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account.profiling_labeler.metadata[0].name
    namespace = "kube-system"
  }
}

# CronJob to ensure one node per GPU type has profiling labels
resource "kubernetes_cron_job_v1" "profiling_node_labeler" {
  metadata {
    name      = "profiling-node-labeler"
    namespace = "kube-system"
  }

  spec {
    schedule                      = "*/5 * * * *" # Every 5 minutes
    successful_jobs_history_limit = 1
    failed_jobs_history_limit     = 1

    job_template {
      metadata {}
      spec {
        template {
          metadata {}
          spec {
            service_account_name = kubernetes_service_account.profiling_labeler.metadata[0].name
            restart_policy       = "OnFailure"

            container {
              name  = "labeler"
              image = "bitnami/kubectl:latest"

              command = ["/bin/bash", "-c"]
              args = [<<-EOT
                set -e
                GPU_TYPES="${join(" ", lookup(local.profiling_gpu_types, terraform.workspace, []))}"

                for GPU_TYPE in $GPU_TYPES; do
                  echo "Checking $GPU_TYPE nodes..."

                  # Check if any node already has the profiling label
                  EXISTING=$(kubectl get nodes -l GpuType=$GPU_TYPE,gpu.monitoring/profiling-dedicated=true -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

                  if [ -n "$EXISTING" ]; then
                    echo "$GPU_TYPE: Node $EXISTING already labeled for profiling"
                    continue
                  fi

                  # Get first available node of this GPU type
                  NODE=$(kubectl get nodes -l GpuType=$GPU_TYPE -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

                  if [ -z "$NODE" ]; then
                    echo "$GPU_TYPE: No nodes found, skipping"
                    continue
                  fi

                  # Label the node for profiling
                  echo "$GPU_TYPE: Labeling $NODE for Nsight profiling..."
                  kubectl label node "$NODE" \
                    gpu.monitoring/profiling-dedicated=true \
                    nvidia.com/gpu.deploy.dcgm-exporter=false \
                    --overwrite

                  echo "$GPU_TYPE: Successfully labeled $NODE"
                done

                echo "Profiling node labeling complete"
              EOT
              ]
            }

            # Run on CPU nodes to avoid using GPU resources
            node_selector = {
              "kubernetes.io/arch" = "amd64"
            }

            toleration {
              operator = "Exists"
            }
          }
        }
      }
    }
  }

  depends_on = [
    kubernetes_cluster_role_binding.profiling_labeler
  ]
}
