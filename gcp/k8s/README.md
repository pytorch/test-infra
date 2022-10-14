# Google Cloud Kubernetes setup for PyTorch CI

## Sources of config files

The origin of cert-manager.yaml is `https://github.com/cert-manager/cert-manager/releases/download/v1.9.1/cert-manager.yaml`.

The origin of actions-runner-controller.yaml is `https://github.com/actions-runner-controller/actions-runner-controller/releases/download/v0.22.0/actions-runner-controller.yaml`.

The origin of daemonset-preloaded-latest.yaml is `https://raw.githubusercontent.com/GoogleCloudPlatform/container-engine-accelerators/master/nvidia-driver-installer/cos/daemonset-preloaded-latest.yaml`. We modified it to install the latest Nvidia driver instead of the stable version.

## Deploy on K8s cluster

First, create a K8s cluster using Google Cloud web UI. Setup the node pool to use the type of instance you want to deploy in the cluster. In this example, the cluster name we use is `torchbench-a100-cluster`, and the instance type is `a2-highgpu-1g`.

Run the following commands:

```
kubectl apply -f cert-manager.yaml
kubectl apply -f actions-runner-controller.yaml
kubectl apply -f daemonset-preloaded-latest.yaml
kubectl apply -f runnerdeployment.yaml
```

Now you should be able to use the label `a100-runner` to run GitHub Actions.

