# Installing on AWS Trainium (TorchNeuron)

**TorchNeuron (`torch-neuronx`)** is a native PyTorch backend for AWS Trainium.
It adds a `neuron` device through the PyTorch `PrivateUse1` mechanism.
It supports eager execution, `torch.compile`, distributed training, and custom NKI kernels.

## Prerequisites

### Hardware Requirements

* An AWS Trainium2 or Trainium3 instance

### Software Requirements

* Linux with Ubuntu 22.04, 24.04, or 26.04
* Python 3.12, 3.13, or 3.14
* The AWS Neuron driver and runtime

Use a Neuron Deep Learning AMI or Deep Learning Container for the simplest setup.
For another Linux image, install the driver and runtime before you install TorchNeuron.

## Installation

### pip

Use the selector above to get the stable installation command.
Keep the version pins because earlier `torch-neuronx` versions use the XLA-based backend.

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
import torch

x = torch.ones(2, 2, device="neuron")
y = x + 1

print(y.cpu())
```

The output must show a 2-by-2 tensor with a value of `2` in each element.

## Documentation

For more information, see:

* [TorchNeuron documentation](https://awsdocs-neuron.readthedocs-hosted.com/en/latest/torch/index.html)
* [API compatibility guide](https://github.com/aws-neuron/torch-neuronx/blob/main/docs/torch_api_compatibility.md)
* [GitHub repository](https://github.com/aws-neuron/torch-neuronx)
* [Support channel](https://github.com/aws-neuron/torch-neuronx/issues)
