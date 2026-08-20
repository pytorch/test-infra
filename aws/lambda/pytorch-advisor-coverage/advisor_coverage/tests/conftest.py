"""Make both this package and the sibling `pytorch_auto_revert` importable.

In the deployed Lambda zip `advisor_coverage/` and `pytorch_auto_revert/` sit
side by side at the zip root. Locally they live in sibling lambda directories,
so the test process needs both on `sys.path`. Computed relative to this file so
it works regardless of the current working directory.
"""

import os
import sys


_HERE = os.path.dirname(os.path.abspath(__file__))
_LAMBDA_DIR = os.path.abspath(os.path.join(_HERE, "..", ".."))
_SIBLING = os.path.join(os.path.dirname(_LAMBDA_DIR), "pytorch-auto-revert")

for _path in (_LAMBDA_DIR, _SIBLING):
    if _path not in sys.path:
        sys.path.insert(0, _path)
