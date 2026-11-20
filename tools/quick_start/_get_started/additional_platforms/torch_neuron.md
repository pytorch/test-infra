# Installing on AWS Trainium (TorchNeuron)

**TorchNeuron (`torch-neuronx`)** is a native PyTorch backend for AWS Trainium.
It adds a `neuron` device through the PyTorch `PrivateUse1` mechanism.
It supports eager execution, `torch.compile`, distributed training, and custom NKI kernels.
TorchNeuron is in Beta.

## Prerequisites

### Hardware Requirements

* An AWS Trainium2 or Trainium3 instance

### Software Requirements

* Ubuntu 22.04, 24.04, or 26.04
* Python 3.12, 3.13, or 3.14
* The AWS Neuron driver and runtime

Use a [Neuron Deep Learning AMI](https://awsdocs-neuron.readthedocs-hosted.com/en/latest/setup/pytorch/dlami.html)
or [Deep Learning Container](https://awsdocs-neuron.readthedocs-hosted.com/en/latest/setup/pytorch/dlc.html)
for the simplest setup.
For another Ubuntu image, install the AWS Neuron driver and runtime before you install TorchNeuron.

See the [TorchNeuron release notes](https://awsdocs-neuron.readthedocs-hosted.com/en/latest/release-notes/components/torchneuron.html)
for current package and AWS Neuron SDK compatibility.

## Installation

### pip

```bash
NEURON_WHEEL_DIR=$(mktemp -d)
pip3 download --no-deps --dest "$NEURON_WHEEL_DIR" \
  "torch-neuronx==2.14.*" "neuronx-cc==2.*" "nki>=0.6" \
  --index-url https://pip.repos.neuron.amazonaws.com
pip3 install "torch==2.14.0" \
  --index-url https://download.pytorch.org/whl/cpu
pip3 install "$NEURON_WHEEL_DIR"/*.whl
rm -r "$NEURON_WHEEL_DIR"
```

Run these commands after you install the AWS Neuron driver and runtime.
Each network operation uses one package index.
This prevents a public package from replacing a Neuron package.
The commands install the stable TorchNeuron package for PyTorch 2.14.
Use the installation guide when you need release-pinned instructions.
The Neuron Deep Learning AMI and Deep Learning Container include a preinstalled environment.

For complete driver, runtime, and package instructions, see the
[TorchNeuron installation guide](https://awsdocs-neuron.readthedocs-hosted.com/en/latest/torch/get-started/quickstart-torch-neuron.html).

## Verification

Run the environment check:

```bash
python -m torch_neuronx.collect_env
```

The `device usable from torch` line must show `yes`.
Then run this code on a Trainium instance:

```python
import torch  # PyTorch loads torch-neuronx automatically.

model = torch.nn.Linear(16, 8).to("neuron").eval()
inputs = torch.randn(4, 16, device="neuron")

with torch.no_grad():
    eager_output = model(inputs)
    compiled_model = torch.compile(model, backend="neuron", dynamic=False)
    compiled_output = compiled_model(inputs)

print(tuple(eager_output.cpu().shape), tuple(compiled_output.cpu().shape))
```

The script prints:

```text
(4, 8) (4, 8)
```

## Support

* Bugs and feature requests: [GitHub Issues](https://github.com/aws-neuron/torch-neuronx/issues).
* Security issues: Follow the [security policy](https://github.com/aws-neuron/torch-neuronx/security/policy).
  Do not report a vulnerability through a public issue.

## Documentation

For more information, see:

* [TorchNeuron documentation](https://awsdocs-neuron.readthedocs-hosted.com/en/latest/torch/index.html)
* [API compatibility guide](https://github.com/aws-neuron/torch-neuronx/blob/main/docs/torch_api_compatibility.md)
* [GitHub repository](https://github.com/aws-neuron/torch-neuronx)
