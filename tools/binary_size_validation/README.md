# PyTorch Wheel Binary Size Validation

A script to fetch and validate the binary size of PyTorch wheels
in the given channel (test, nightly) against the given threshold.


### Installation

```bash
pip install -r requirements.txt
```

### Usage

```bash
# print help
python binary_size_validation.py --help

# print sizes of the all items in the index
python binary_size_validation.py --url https://download.pytorch.org/whl/nightly/torch/

# fail if any of the torch2.0 wheels are larger than 900MB
python binary_size_validation.py --url https://download.pytorch.org/whl/nightly/torch/ --include "torch-2\.0"  --threshold 900

# fail if any of the latest nightly pypi wheels are larger than 750MB
python binary_size_validation.py --include "pypi" --only-latest-version --threshold 750
```
