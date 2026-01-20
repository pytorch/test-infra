# GPU Monitoring Stack: Prometheus + Grafana + DCGM Exporter
#
# Architecture:
# - kube-prometheus-stack: Prometheus, Grafana, node-exporter, kube-state-metrics
# - DCGM Exporter: Enabled in GPU Operator (kubernetes.tf), excluded from profiling nodes
# - NVIDIA DCGM Dashboard: Pre-loaded in Grafana
#
# Node Labeling for Profiling:
# - Label one H100 and one B200 node with: gpu.monitoring/profiling-dedicated=true
# - These nodes will NOT have DCGM running (avoids conflict with Nsight profiling)
# - Commands:
#   kubectl label node <h100-node-name> gpu.monitoring/profiling-dedicated=true
#   kubectl label node <b200-node-name> gpu.monitoring/profiling-dedicated=true

# gp3 StorageClass for Prometheus persistent storage
resource "kubernetes_storage_class" "gp3" {
  depends_on = [aws_eks_cluster.gpu_dev_cluster]

  metadata {
    name = "gp3"
    annotations = {
      "storageclass.kubernetes.io/is-default-class" = "false"
    }
  }

  storage_provisioner    = "ebs.csi.aws.com"
  reclaim_policy         = "Delete"
  allow_volume_expansion = true
  volume_binding_mode    = "WaitForFirstConsumer"

  parameters = {
    type      = "gp3"
    fsType    = "ext4"
    encrypted = "true"
  }
}

resource "kubernetes_namespace" "monitoring" {
  depends_on = [aws_eks_cluster.gpu_dev_cluster]

  metadata {
    name = "monitoring"
    labels = {
      name    = "monitoring"
      purpose = "gpu-monitoring"
    }
  }
}

# Secret for Grafana Cloud remote write credentials (only created if URL is provided)
resource "kubernetes_secret" "grafana_cloud_credentials" {
  count = var.grafana_cloud_prometheus_url != "" ? 1 : 0

  depends_on = [kubernetes_namespace.monitoring]

  metadata {
    name      = "grafana-cloud-credentials"
    namespace = kubernetes_namespace.monitoring.metadata[0].name
  }

  data = {
    username = var.grafana_cloud_prometheus_username
    password = var.grafana_cloud_prometheus_password
  }
}

# kube-prometheus-stack: Prometheus + Grafana + exporters
resource "helm_release" "kube_prometheus_stack" {
  depends_on = [
    aws_eks_cluster.gpu_dev_cluster,
    kubernetes_namespace.monitoring,
    helm_release.nvidia_gpu_operator,
    kubernetes_secret.grafana_cloud_credentials
  ]

  name       = "kube-prometheus-stack"
  repository = "https://prometheus-community.github.io/helm-charts"
  chart      = "kube-prometheus-stack"
  version    = "67.9.0"
  namespace  = kubernetes_namespace.monitoring.metadata[0].name

  wait    = true
  timeout = 900

  values = [<<-EOT
    # Grafana configuration
    grafana:
      enabled: true
      adminPassword: "${var.grafana_admin_password}"

      # NodePort access
      service:
        type: NodePort
        nodePort: 30080

      # Prefer CPU nodes for Grafana
      nodeSelector:
        NodeType: cpu

      # Pre-load NVIDIA DCGM dashboard
      dashboardProviders:
        dashboardproviders.yaml:
          apiVersion: 1
          providers:
            - name: 'nvidia'
              orgId: 1
              folder: 'NVIDIA'
              type: file
              disableDeletion: false
              editable: true
              options:
                path: /var/lib/grafana/dashboards/nvidia

      dashboards:
        nvidia:
          nvidia-dcgm:
            gnetId: 12239
            revision: 2
            datasource: Prometheus

      # Sidecar for ConfigMap dashboards
      sidecar:
        dashboards:
          enabled: true
          label: grafana_dashboard
          searchNamespace: ALL

    # Prometheus configuration
    prometheus:
      prometheusSpec:
        # External labels - added to all metrics, used to identify environment in Grafana Cloud
        externalLabels:
          environment: "${local.current_config.environment}"
          cluster: "${var.prefix}"

        # Persistent storage
        storageSpec:
          volumeClaimTemplate:
            spec:
              storageClassName: gp3
              accessModes: ["ReadWriteOnce"]
              resources:
                requests:
                  storage: 50Gi

        # Retention
        retention: 15d
        retentionSize: 45GB

        # Prefer CPU nodes
        nodeSelector:
          NodeType: cpu
${var.grafana_cloud_prometheus_url != "" ? "        # Remote write to Grafana Cloud\n        remoteWrite:\n          - url: \"${var.grafana_cloud_prometheus_url}\"\n            basicAuth:\n              username:\n                name: grafana-cloud-credentials\n                key: username\n              password:\n                name: grafana-cloud-credentials\n                key: password\n            writeRelabelConfigs:\n              - sourceLabels: [__name__]\n                regex: \"DCGM_.*|node_.*|kube_pod_.*|kube_node_.*|kubelet_volume_.*\"\n                action: keep\n" : ""}
        # Scrape DCGM Exporter metrics
        additionalScrapeConfigs:
          - job_name: 'dcgm-exporter'
            kubernetes_sd_configs:
              - role: pod
                namespaces:
                  names:
                    - gpu-operator
            relabel_configs:
              - source_labels: [__meta_kubernetes_pod_label_app]
                regex: nvidia-dcgm-exporter
                action: keep
              - source_labels: [__meta_kubernetes_pod_container_port_number]
                regex: "9400"
                action: keep
              - source_labels: [__meta_kubernetes_pod_node_name]
                target_label: node
              - source_labels: [__meta_kubernetes_namespace]
                target_label: namespace

        # ServiceMonitor selector - pick up DCGM ServiceMonitor from GPU Operator
        serviceMonitorSelectorNilUsesHelmValues: false
        podMonitorSelectorNilUsesHelmValues: false

    # Node exporter for system metrics
    nodeExporter:
      enabled: true

    # Kube state metrics
    kubeStateMetrics:
      enabled: true

    # Alert manager (optional, can disable if not needed)
    alertmanager:
      enabled: false

    # Default rules for Kubernetes
    defaultRules:
      create: true
      rules:
        kubeProxy: false  # Disable if using managed EKS
  EOT
  ]
}

# Note: GPU Operator creates its own ServiceMonitor for DCGM Exporter when dcgmExporter.enabled=true
# The additionalScrapeConfigs in Prometheus also scrapes DCGM as a fallback

# Comprehensive GPU Dashboard
resource "kubernetes_config_map" "gpu_overview_dashboard" {
  depends_on = [helm_release.kube_prometheus_stack]

  metadata {
    name      = "gpu-overview-dashboard"
    namespace = kubernetes_namespace.monitoring.metadata[0].name
    labels = {
      grafana_dashboard = "1"
    }
  }

  data = {
    "gpu-overview.json" = jsonencode({
      annotations = { list = [] }
      editable    = true
      fiscalYearStartMonth = 0
      graphTooltip = 1
      id = null
      links = []
      liveNow = false
      panels = [
        # Row 0: Summary Stats
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "thresholds" }
              mappings = []
              thresholds = { mode = "absolute", steps = [{ color = "green", value = null }] }
              unit = "none"
            }
            overrides = []
          }
          gridPos = { h = 4, w = 4, x = 0, y = 0 }
          id = 1
          options = {
            colorMode = "value"
            graphMode = "none"
            justifyMode = "auto"
            orientation = "auto"
            reduceOptions = { calcs = ["lastNotNull"], fields = "", values = false }
            textMode = "auto"
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "count(DCGM_FI_DEV_GPU_UTIL)", refId = "A" }]
          title = "Total GPUs"
          type = "stat"
        },
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "thresholds" }
              mappings = []
              thresholds = { mode = "absolute", steps = [{ color = "green", value = null }, { color = "yellow", value = 50 }, { color = "red", value = 80 }] }
              unit = "percent"
              max = 100
            }
            overrides = []
          }
          gridPos = { h = 4, w = 5, x = 4, y = 0 }
          id = 2
          options = {
            colorMode = "value"
            graphMode = "area"
            justifyMode = "auto"
            orientation = "auto"
            reduceOptions = { calcs = ["lastNotNull"], fields = "", values = false }
            textMode = "auto"
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "avg(DCGM_FI_DEV_GPU_UTIL)", refId = "A" }]
          title = "Avg GPU Util"
          type = "stat"
        },
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "thresholds" }
              mappings = []
              thresholds = { mode = "absolute", steps = [{ color = "green", value = null }, { color = "yellow", value = 50 }, { color = "red", value = 80 }] }
              unit = "percent"
              max = 100
            }
            overrides = []
          }
          gridPos = { h = 4, w = 5, x = 9, y = 0 }
          id = 3
          options = {
            colorMode = "value"
            graphMode = "area"
            justifyMode = "auto"
            orientation = "auto"
            reduceOptions = { calcs = ["lastNotNull"], fields = "", values = false }
            textMode = "auto"
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "avg(DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE) * 100)", refId = "A" }]
          title = "Avg VRAM Util"
          type = "stat"
        },
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "thresholds" }
              mappings = []
              thresholds = { mode = "absolute", steps = [{ color = "green", value = null }, { color = "orange", value = 80 }, { color = "red", value = 95 }] }
              unit = "percent"
              max = 100
            }
            overrides = []
          }
          gridPos = { h = 4, w = 5, x = 14, y = 0 }
          id = 4
          options = {
            colorMode = "value"
            graphMode = "none"
            justifyMode = "auto"
            orientation = "auto"
            reduceOptions = { calcs = ["max"], fields = "", values = false }
            textMode = "auto"
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "max(DCGM_FI_DEV_GPU_UTIL)", refId = "A" }]
          title = "Max GPU Util (current)"
          type = "stat"
        },
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "thresholds" }
              mappings = []
              thresholds = { mode = "absolute", steps = [{ color = "green", value = null }, { color = "orange", value = 80 }, { color = "red", value = 95 }] }
              unit = "percent"
              max = 100
            }
            overrides = []
          }
          gridPos = { h = 4, w = 5, x = 19, y = 0 }
          id = 5
          options = {
            colorMode = "value"
            graphMode = "none"
            justifyMode = "auto"
            orientation = "auto"
            reduceOptions = { calcs = ["max"], fields = "", values = false }
            textMode = "auto"
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "max(DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE) * 100)", refId = "A" }]
          title = "Max VRAM Util (current)"
          type = "stat"
        },
        # Row 1: Cluster-wide aggregated utilization
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "palette-classic" }
              custom = {
                axisBorderShow = false, axisCenteredZero = false, axisColorMode = "text", axisLabel = ""
                axisPlacement = "auto", barAlignment = 0, drawStyle = "line", fillOpacity = 20
                gradientMode = "opacity", hideFrom = { legend = false, tooltip = false, viz = false }
                lineInterpolation = "smooth", lineWidth = 2, pointSize = 5
                scaleDistribution = { type = "linear" }, showPoints = "never", spanNulls = false
                stacking = { group = "A", mode = "none" }, thresholdsStyle = { mode = "off" }
              }
              mappings = [], thresholds = { mode = "absolute", steps = [{ color = "green", value = null }] }
              unit = "percent", max = 100, min = 0
            }
            overrides = []
          }
          gridPos = { h = 7, w = 12, x = 0, y = 4 }
          id = 6
          options = {
            legend = { calcs = ["mean", "max", "min"], displayMode = "table", placement = "bottom", showLegend = true }
            tooltip = { maxHeight = 600, mode = "multi", sort = "desc" }
          }
          targets = [
            { datasource = { type = "prometheus", uid = "prometheus" }, expr = "avg(DCGM_FI_DEV_GPU_UTIL)", legendFormat = "Cluster Average", refId = "A" },
            { datasource = { type = "prometheus", uid = "prometheus" }, expr = "max(DCGM_FI_DEV_GPU_UTIL)", legendFormat = "Cluster Max", refId = "B" },
            { datasource = { type = "prometheus", uid = "prometheus" }, expr = "min(DCGM_FI_DEV_GPU_UTIL)", legendFormat = "Cluster Min", refId = "C" }
          ]
          title = "Cluster GPU Utilization (Aggregated)"
          type = "timeseries"
        },
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "palette-classic" }
              custom = {
                axisBorderShow = false, axisCenteredZero = false, axisColorMode = "text", axisLabel = ""
                axisPlacement = "auto", barAlignment = 0, drawStyle = "line", fillOpacity = 20
                gradientMode = "opacity", hideFrom = { legend = false, tooltip = false, viz = false }
                lineInterpolation = "smooth", lineWidth = 2, pointSize = 5
                scaleDistribution = { type = "linear" }, showPoints = "never", spanNulls = false
                stacking = { group = "A", mode = "none" }, thresholdsStyle = { mode = "off" }
              }
              mappings = [], thresholds = { mode = "absolute", steps = [{ color = "green", value = null }] }
              unit = "percent", max = 100, min = 0
            }
            overrides = []
          }
          gridPos = { h = 7, w = 12, x = 12, y = 4 }
          id = 7
          options = {
            legend = { calcs = ["mean", "max", "min"], displayMode = "table", placement = "bottom", showLegend = true }
            tooltip = { maxHeight = 600, mode = "multi", sort = "desc" }
          }
          targets = [
            { datasource = { type = "prometheus", uid = "prometheus" }, expr = "avg(DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE) * 100)", legendFormat = "Cluster Average", refId = "A" },
            { datasource = { type = "prometheus", uid = "prometheus" }, expr = "max(DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE) * 100)", legendFormat = "Cluster Max", refId = "B" },
            { datasource = { type = "prometheus", uid = "prometheus" }, expr = "min(DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE) * 100)", legendFormat = "Cluster Min", refId = "C" }
          ]
          title = "Cluster VRAM Utilization (Aggregated)"
          type = "timeseries"
        },
        # Row 2: Per-node GPU utilization
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "palette-classic" }
              custom = {
                axisBorderShow = false, axisCenteredZero = false, axisColorMode = "text", axisLabel = ""
                axisPlacement = "auto", barAlignment = 0, drawStyle = "line", fillOpacity = 10
                gradientMode = "none", hideFrom = { legend = false, tooltip = false, viz = false }
                lineInterpolation = "linear", lineWidth = 1, pointSize = 5
                scaleDistribution = { type = "linear" }, showPoints = "never", spanNulls = false
                stacking = { group = "A", mode = "none" }, thresholdsStyle = { mode = "off" }
              }
              mappings = [], thresholds = { mode = "absolute", steps = [{ color = "green", value = null }, { color = "red", value = 80 }] }
              unit = "percent", max = 100, min = 0
            }
            overrides = []
          }
          gridPos = { h = 8, w = 12, x = 0, y = 11 }
          id = 8
          options = {
            legend = { calcs = ["mean", "max"], displayMode = "table", placement = "bottom", showLegend = true }
            tooltip = { maxHeight = 600, mode = "multi", sort = "desc" }
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "avg by (Hostname) (DCGM_FI_DEV_GPU_UTIL)", legendFormat = "{{Hostname}}", refId = "A" }]
          title = "GPU Utilization by Node (avg of GPUs)"
          type = "timeseries"
        },
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "palette-classic" }
              custom = {
                axisBorderShow = false, axisCenteredZero = false, axisColorMode = "text", axisLabel = ""
                axisPlacement = "auto", barAlignment = 0, drawStyle = "line", fillOpacity = 10
                gradientMode = "none", hideFrom = { legend = false, tooltip = false, viz = false }
                lineInterpolation = "linear", lineWidth = 1, pointSize = 5
                scaleDistribution = { type = "linear" }, showPoints = "never", spanNulls = false
                stacking = { group = "A", mode = "none" }, thresholdsStyle = { mode = "off" }
              }
              mappings = [], thresholds = { mode = "absolute", steps = [{ color = "green", value = null }, { color = "red", value = 80 }] }
              unit = "percent", max = 100, min = 0
            }
            overrides = []
          }
          gridPos = { h = 8, w = 12, x = 12, y = 11 }
          id = 9
          options = {
            legend = { calcs = ["mean", "max"], displayMode = "table", placement = "bottom", showLegend = true }
            tooltip = { maxHeight = 600, mode = "multi", sort = "desc" }
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "avg by (Hostname) (DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE) * 100)", legendFormat = "{{Hostname}}", refId = "A" }]
          title = "VRAM Utilization by Node (avg of GPUs)"
          type = "timeseries"
        },
        # Row 3: Per-GPU detailed view
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "palette-classic" }
              custom = {
                axisBorderShow = false, axisCenteredZero = false, axisColorMode = "text", axisLabel = ""
                axisPlacement = "auto", barAlignment = 0, drawStyle = "line", fillOpacity = 5
                gradientMode = "none", hideFrom = { legend = false, tooltip = false, viz = false }
                lineInterpolation = "linear", lineWidth = 1, pointSize = 5
                scaleDistribution = { type = "linear" }, showPoints = "never", spanNulls = false
                stacking = { group = "A", mode = "none" }, thresholdsStyle = { mode = "off" }
              }
              mappings = [], thresholds = { mode = "absolute", steps = [{ color = "green", value = null }] }
              unit = "percent", max = 100, min = 0
            }
            overrides = []
          }
          gridPos = { h = 8, w = 12, x = 0, y = 19 }
          id = 10
          options = {
            legend = { calcs = ["mean", "max"], displayMode = "table", placement = "right", showLegend = true }
            tooltip = { maxHeight = 600, mode = "multi", sort = "desc" }
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "DCGM_FI_DEV_GPU_UTIL", legendFormat = "{{Hostname}} GPU{{gpu}}", refId = "A" }]
          title = "GPU Utilization (All GPUs)"
          type = "timeseries"
        },
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "palette-classic" }
              custom = {
                axisBorderShow = false, axisCenteredZero = false, axisColorMode = "text", axisLabel = ""
                axisPlacement = "auto", barAlignment = 0, drawStyle = "line", fillOpacity = 5
                gradientMode = "none", hideFrom = { legend = false, tooltip = false, viz = false }
                lineInterpolation = "linear", lineWidth = 1, pointSize = 5
                scaleDistribution = { type = "linear" }, showPoints = "never", spanNulls = false
                stacking = { group = "A", mode = "none" }, thresholdsStyle = { mode = "off" }
              }
              mappings = [], thresholds = { mode = "absolute", steps = [{ color = "green", value = null }] }
              unit = "percent", max = 100, min = 0
            }
            overrides = []
          }
          gridPos = { h = 8, w = 12, x = 12, y = 19 }
          id = 11
          options = {
            legend = { calcs = ["mean", "max"], displayMode = "table", placement = "right", showLegend = true }
            tooltip = { maxHeight = 600, mode = "multi", sort = "desc" }
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE) * 100", legendFormat = "{{Hostname}} GPU{{gpu}}", refId = "A" }]
          title = "VRAM Utilization (All GPUs)"
          type = "timeseries"
        },
        # Row 4: Current state gauges
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "thresholds" }
              mappings = []
              thresholds = { mode = "absolute", steps = [{ color = "green", value = null }, { color = "yellow", value = 50 }, { color = "red", value = 80 }] }
              unit = "percent", max = 100, min = 0
            }
            overrides = []
          }
          gridPos = { h = 6, w = 12, x = 0, y = 27 }
          id = 12
          options = {
            minVizHeight = 75, minVizWidth = 75, orientation = "horizontal"
            reduceOptions = { calcs = ["lastNotNull"], fields = "", values = false }
            showThresholdLabels = false, showThresholdMarkers = true, sizing = "auto"
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "avg by (Hostname) (DCGM_FI_DEV_GPU_UTIL)", legendFormat = "{{Hostname}}", refId = "A" }]
          title = "Current GPU Utilization by Node"
          type = "gauge"
        },
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "thresholds" }
              mappings = []
              thresholds = { mode = "absolute", steps = [{ color = "green", value = null }, { color = "yellow", value = 50 }, { color = "red", value = 80 }] }
              unit = "percent", max = 100, min = 0
            }
            overrides = []
          }
          gridPos = { h = 6, w = 12, x = 12, y = 27 }
          id = 13
          options = {
            minVizHeight = 75, minVizWidth = 75, orientation = "horizontal"
            reduceOptions = { calcs = ["lastNotNull"], fields = "", values = false }
            showThresholdLabels = false, showThresholdMarkers = true, sizing = "auto"
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "avg by (Hostname) (DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE) * 100)", legendFormat = "{{Hostname}}", refId = "A" }]
          title = "Current VRAM Utilization by Node"
          type = "gauge"
        },
        # Row 5: Temperature and Power
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "palette-classic" }
              custom = {
                axisBorderShow = false, axisCenteredZero = false, axisColorMode = "text", axisLabel = ""
                axisPlacement = "auto", barAlignment = 0, drawStyle = "line", fillOpacity = 10
                gradientMode = "none", hideFrom = { legend = false, tooltip = false, viz = false }
                lineInterpolation = "linear", lineWidth = 1, pointSize = 5
                scaleDistribution = { type = "linear" }, showPoints = "never", spanNulls = false
                stacking = { group = "A", mode = "none" }, thresholdsStyle = { mode = "off" }
              }
              mappings = [], thresholds = { mode = "absolute", steps = [{ color = "green", value = null }, { color = "yellow", value = 70 }, { color = "red", value = 85 }] }
              unit = "celsius"
            }
            overrides = []
          }
          gridPos = { h = 7, w = 12, x = 0, y = 33 }
          id = 14
          options = {
            legend = { calcs = ["mean", "max"], displayMode = "table", placement = "bottom", showLegend = true }
            tooltip = { maxHeight = 600, mode = "multi", sort = "desc" }
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "avg by (Hostname) (DCGM_FI_DEV_GPU_TEMP)", legendFormat = "{{Hostname}}", refId = "A" }]
          title = "GPU Temperature by Node"
          type = "timeseries"
        },
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "palette-classic" }
              custom = {
                axisBorderShow = false, axisCenteredZero = false, axisColorMode = "text", axisLabel = ""
                axisPlacement = "auto", barAlignment = 0, drawStyle = "line", fillOpacity = 10
                gradientMode = "none", hideFrom = { legend = false, tooltip = false, viz = false }
                lineInterpolation = "linear", lineWidth = 1, pointSize = 5
                scaleDistribution = { type = "linear" }, showPoints = "never", spanNulls = false
                stacking = { group = "A", mode = "none" }, thresholdsStyle = { mode = "off" }
              }
              mappings = [], thresholds = { mode = "absolute", steps = [{ color = "green", value = null }] }
              unit = "watt"
            }
            overrides = []
          }
          gridPos = { h = 7, w = 12, x = 12, y = 33 }
          id = 15
          options = {
            legend = { calcs = ["mean", "max"], displayMode = "table", placement = "bottom", showLegend = true }
            tooltip = { maxHeight = 600, mode = "multi", sort = "desc" }
          }
          targets = [
            { datasource = { type = "prometheus", uid = "prometheus" }, expr = "sum by (Hostname) (DCGM_FI_DEV_POWER_USAGE)", legendFormat = "{{Hostname}}", refId = "A" },
            { datasource = { type = "prometheus", uid = "prometheus" }, expr = "sum(DCGM_FI_DEV_POWER_USAGE)", legendFormat = "Total Cluster", refId = "B" }
          ]
          title = "GPU Power Usage by Node"
          type = "timeseries"
        }
      ]
      refresh = "10s"
      schemaVersion = 39
      tags = ["nvidia", "gpu", "dcgm"]
      templating = { list = [] }
      time = { from = "now-1h", to = "now" }
      timepicker = {}
      timezone = "browser"
      title = "GPU Cluster Overview"
      uid = "gpu-overview"
      version = 1
    })
  }
}

# Kubernetes & Storage Dashboard
resource "kubernetes_config_map" "k8s_storage_dashboard" {
  depends_on = [helm_release.kube_prometheus_stack]

  metadata {
    name      = "k8s-storage-dashboard"
    namespace = kubernetes_namespace.monitoring.metadata[0].name
    labels = {
      grafana_dashboard = "1"
    }
  }

  data = {
    "k8s-storage.json" = jsonencode({
      annotations = { list = [] }
      editable    = true
      fiscalYearStartMonth = 0
      graphTooltip = 1
      id = null
      links = []
      liveNow = false
      panels = [
        # Row 0: Pod stats
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "thresholds" }
              mappings = []
              thresholds = { mode = "absolute", steps = [{ color = "green", value = null }] }
              unit = "none"
            }
            overrides = []
          }
          gridPos = { h = 4, w = 4, x = 0, y = 0 }
          id = 1
          options = {
            colorMode = "value", graphMode = "none", justifyMode = "auto", orientation = "auto"
            reduceOptions = { calcs = ["lastNotNull"], fields = "", values = false }, textMode = "auto"
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "count(kube_pod_info{namespace=\"gpu-dev\"})", refId = "A" }]
          title = "GPU Dev Pods"
          type = "stat"
        },
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "thresholds" }
              mappings = []
              thresholds = { mode = "absolute", steps = [{ color = "green", value = null }] }
              unit = "none"
            }
            overrides = []
          }
          gridPos = { h = 4, w = 4, x = 4, y = 0 }
          id = 2
          options = {
            colorMode = "value", graphMode = "none", justifyMode = "auto", orientation = "auto"
            reduceOptions = { calcs = ["lastNotNull"], fields = "", values = false }, textMode = "auto"
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "count(kube_pod_status_phase{namespace=\"gpu-dev\", phase=\"Running\"})", refId = "A" }]
          title = "Running Pods"
          type = "stat"
        },
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "thresholds" }
              mappings = []
              thresholds = { mode = "absolute", steps = [{ color = "green", value = null }] }
              unit = "none"
            }
            overrides = []
          }
          gridPos = { h = 4, w = 4, x = 8, y = 0 }
          id = 3
          options = {
            colorMode = "value", graphMode = "none", justifyMode = "auto", orientation = "auto"
            reduceOptions = { calcs = ["lastNotNull"], fields = "", values = false }, textMode = "auto"
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "count(kube_node_info)", refId = "A" }]
          title = "Total Nodes"
          type = "stat"
        },
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "thresholds" }
              mappings = []
              thresholds = { mode = "absolute", steps = [{ color = "green", value = null }] }
              unit = "none"
            }
            overrides = []
          }
          gridPos = { h = 4, w = 4, x = 12, y = 0 }
          id = 4
          options = {
            colorMode = "value", graphMode = "none", justifyMode = "auto", orientation = "auto"
            reduceOptions = { calcs = ["lastNotNull"], fields = "", values = false }, textMode = "auto"
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "count(kube_node_status_condition{condition=\"Ready\", status=\"true\"})", refId = "A" }]
          title = "Ready Nodes"
          type = "stat"
        },
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "thresholds" }
              mappings = []
              thresholds = { mode = "absolute", steps = [{ color = "green", value = null }] }
              unit = "none"
            }
            overrides = []
          }
          gridPos = { h = 4, w = 4, x = 16, y = 0 }
          id = 5
          options = {
            colorMode = "value", graphMode = "area", justifyMode = "auto", orientation = "auto"
            reduceOptions = { calcs = ["lastNotNull"], fields = "", values = false }, textMode = "auto"
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "count(kube_persistentvolumeclaim_info{namespace=\"gpu-dev\"})", refId = "A" }]
          title = "PVCs (gpu-dev)"
          type = "stat"
        },
        # Row 1: Node disk usage
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "palette-classic" }
              custom = {
                axisBorderShow = false, axisCenteredZero = false, axisColorMode = "text", axisLabel = ""
                axisPlacement = "auto", barAlignment = 0, drawStyle = "line", fillOpacity = 10
                gradientMode = "none", hideFrom = { legend = false, tooltip = false, viz = false }
                lineInterpolation = "linear", lineWidth = 1, pointSize = 5
                scaleDistribution = { type = "linear" }, showPoints = "never", spanNulls = false
                stacking = { group = "A", mode = "none" }, thresholdsStyle = { mode = "off" }
              }
              mappings = [], thresholds = { mode = "absolute", steps = [{ color = "green", value = null }] }
              unit = "percent", max = 100, min = 0
            }
            overrides = []
          }
          gridPos = { h = 8, w = 12, x = 0, y = 4 }
          id = 6
          options = {
            legend = { calcs = ["mean", "max"], displayMode = "table", placement = "bottom", showLegend = true }
            tooltip = { maxHeight = 600, mode = "multi", sort = "desc" }
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "100 - ((node_filesystem_avail_bytes{mountpoint=\"/\", fstype!=\"rootfs\"} / node_filesystem_size_bytes{mountpoint=\"/\", fstype!=\"rootfs\"}) * 100)", legendFormat = "{{instance}}", refId = "A" }]
          title = "Node Root Disk Usage %"
          type = "timeseries"
        },
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "palette-classic" }
              custom = {
                axisBorderShow = false, axisCenteredZero = false, axisColorMode = "text", axisLabel = ""
                axisPlacement = "auto", barAlignment = 0, drawStyle = "line", fillOpacity = 10
                gradientMode = "none", hideFrom = { legend = false, tooltip = false, viz = false }
                lineInterpolation = "linear", lineWidth = 1, pointSize = 5
                scaleDistribution = { type = "linear" }, showPoints = "never", spanNulls = false
                stacking = { group = "A", mode = "none" }, thresholdsStyle = { mode = "off" }
              }
              mappings = [], thresholds = { mode = "absolute", steps = [{ color = "green", value = null }] }
              unit = "bytes"
            }
            overrides = []
          }
          gridPos = { h = 8, w = 12, x = 12, y = 4 }
          id = 7
          options = {
            legend = { calcs = ["mean", "max"], displayMode = "table", placement = "bottom", showLegend = true }
            tooltip = { maxHeight = 600, mode = "multi", sort = "desc" }
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "node_filesystem_size_bytes{mountpoint=\"/\", fstype!=\"rootfs\"} - node_filesystem_avail_bytes{mountpoint=\"/\", fstype!=\"rootfs\"}", legendFormat = "{{instance}}", refId = "A" }]
          title = "Node Root Disk Used (bytes)"
          type = "timeseries"
        },
        # Row 2: PVC storage
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "palette-classic" }
              custom = {
                axisBorderShow = false, axisCenteredZero = false, axisColorMode = "text", axisLabel = ""
                axisPlacement = "auto", barAlignment = 0, drawStyle = "line", fillOpacity = 10
                gradientMode = "none", hideFrom = { legend = false, tooltip = false, viz = false }
                lineInterpolation = "linear", lineWidth = 1, pointSize = 5
                scaleDistribution = { type = "linear" }, showPoints = "never", spanNulls = false
                stacking = { group = "A", mode = "none" }, thresholdsStyle = { mode = "off" }
              }
              mappings = [], thresholds = { mode = "absolute", steps = [{ color = "green", value = null }] }
              unit = "percent", max = 100, min = 0
            }
            overrides = []
          }
          gridPos = { h = 8, w = 12, x = 0, y = 12 }
          id = 8
          options = {
            legend = { calcs = ["mean", "max"], displayMode = "table", placement = "bottom", showLegend = true }
            tooltip = { maxHeight = 600, mode = "multi", sort = "desc" }
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "100 - ((kubelet_volume_stats_available_bytes{namespace=\"gpu-dev\"} / kubelet_volume_stats_capacity_bytes{namespace=\"gpu-dev\"}) * 100)", legendFormat = "{{persistentvolumeclaim}}", refId = "A" }]
          title = "PVC Usage % (gpu-dev namespace)"
          type = "timeseries"
        },
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "palette-classic" }
              custom = {
                axisBorderShow = false, axisCenteredZero = false, axisColorMode = "text", axisLabel = ""
                axisPlacement = "auto", barAlignment = 0, drawStyle = "line", fillOpacity = 10
                gradientMode = "none", hideFrom = { legend = false, tooltip = false, viz = false }
                lineInterpolation = "linear", lineWidth = 1, pointSize = 5
                scaleDistribution = { type = "linear" }, showPoints = "never", spanNulls = false
                stacking = { group = "A", mode = "none" }, thresholdsStyle = { mode = "off" }
              }
              mappings = [], thresholds = { mode = "absolute", steps = [{ color = "green", value = null }] }
              unit = "bytes"
            }
            overrides = []
          }
          gridPos = { h = 8, w = 12, x = 12, y = 12 }
          id = 9
          options = {
            legend = { calcs = ["mean", "max"], displayMode = "table", placement = "bottom", showLegend = true }
            tooltip = { maxHeight = 600, mode = "multi", sort = "desc" }
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "kubelet_volume_stats_used_bytes{namespace=\"gpu-dev\"}", legendFormat = "{{persistentvolumeclaim}}", refId = "A" }]
          title = "PVC Used Bytes (gpu-dev namespace)"
          type = "timeseries"
        },
        # Row 3: Container startup time (approximation)
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "palette-classic" }
              custom = {
                axisBorderShow = false, axisCenteredZero = false, axisColorMode = "text", axisLabel = ""
                axisPlacement = "auto", barAlignment = 0, drawStyle = "line", fillOpacity = 10
                gradientMode = "none", hideFrom = { legend = false, tooltip = false, viz = false }
                lineInterpolation = "linear", lineWidth = 1, pointSize = 5
                scaleDistribution = { type = "linear" }, showPoints = "auto", spanNulls = false
                stacking = { group = "A", mode = "none" }, thresholdsStyle = { mode = "off" }
              }
              mappings = [], thresholds = { mode = "absolute", steps = [{ color = "green", value = null }] }
              unit = "s"
            }
            overrides = []
          }
          gridPos = { h = 8, w = 24, x = 0, y = 20 }
          id = 10
          options = {
            legend = { calcs = ["mean", "max", "min"], displayMode = "table", placement = "bottom", showLegend = true }
            tooltip = { maxHeight = 600, mode = "multi", sort = "desc" }
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "(kube_pod_start_time{namespace=\"gpu-dev\"} - kube_pod_created{namespace=\"gpu-dev\"}) > 0", legendFormat = "{{pod}}", refId = "A" }]
          title = "Pod Startup Time (created to running) - gpu-dev"
          type = "timeseries"
        },
        # Row 4: EFS mount points (if available via node_exporter)
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "palette-classic" }
              custom = {
                axisBorderShow = false, axisCenteredZero = false, axisColorMode = "text", axisLabel = ""
                axisPlacement = "auto", barAlignment = 0, drawStyle = "line", fillOpacity = 10
                gradientMode = "none", hideFrom = { legend = false, tooltip = false, viz = false }
                lineInterpolation = "linear", lineWidth = 1, pointSize = 5
                scaleDistribution = { type = "linear" }, showPoints = "never", spanNulls = false
                stacking = { group = "A", mode = "none" }, thresholdsStyle = { mode = "off" }
              }
              mappings = [], thresholds = { mode = "absolute", steps = [{ color = "green", value = null }] }
              unit = "bytes"
            }
            overrides = []
          }
          gridPos = { h = 8, w = 12, x = 0, y = 28 }
          id = 11
          options = {
            legend = { calcs = ["mean", "max"], displayMode = "table", placement = "bottom", showLegend = true }
            tooltip = { maxHeight = 600, mode = "multi", sort = "desc" }
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "node_filesystem_size_bytes{fstype=\"nfs4\"} - node_filesystem_avail_bytes{fstype=\"nfs4\"}", legendFormat = "{{instance}} {{mountpoint}}", refId = "A" }]
          title = "EFS/NFS Used (bytes)"
          type = "timeseries"
        },
        {
          datasource = { type = "prometheus", uid = "prometheus" }
          fieldConfig = {
            defaults = {
              color = { mode = "thresholds" }
              mappings = []
              thresholds = { mode = "absolute", steps = [{ color = "green", value = null }, { color = "yellow", value = 70 }, { color = "red", value = 90 }] }
              unit = "percent", max = 100, min = 0
            }
            overrides = []
          }
          gridPos = { h = 8, w = 12, x = 12, y = 28 }
          id = 12
          options = {
            minVizHeight = 75, minVizWidth = 75, orientation = "horizontal"
            reduceOptions = { calcs = ["lastNotNull"], fields = "", values = false }
            showThresholdLabels = false, showThresholdMarkers = true, sizing = "auto"
          }
          targets = [{ datasource = { type = "prometheus", uid = "prometheus" }, expr = "100 - ((node_filesystem_avail_bytes{mountpoint=\"/\"} / node_filesystem_size_bytes{mountpoint=\"/\"}) * 100)", legendFormat = "{{instance}}", refId = "A" }]
          title = "Current Node Disk Usage"
          type = "gauge"
        }
      ]
      refresh = "30s"
      schemaVersion = 39
      tags = ["kubernetes", "storage", "pvc"]
      templating = { list = [] }
      time = { from = "now-6h", to = "now" }
      timepicker = {}
      timezone = "browser"
      title = "Kubernetes & Storage"
      uid = "k8s-storage"
      version = 1
    })
  }
}
