# TorchFix - a linter for PyTorch-using code with autofix support

TorchFix is a Python code static analysis tool - a linter with autofix capabilities -
for users of PyTorch. It can be used to find and fix issues like usage of deprecated
PyTorch functions and non-public symbols, and to adopt PyTorch best practices in general.

TorchFix is built upon https://github.com/Instagram/LibCST - a library to manipulate
Python concrete syntax trees. LibCST enables "codemods" (autofixes) in addition to
reporting issues.

TorchFix can be used as a Flake8 plugin (linting only) or as a standalone
program (with autofix available for a subset of the lint violations).

Currently TorchFix is in a **prototype/alpha version** stage, so there are a lot of rough
edges and many things can and will change.

## Installation

To install the latest code from GitHub, clone/download
https://github.com/pytorch/test-infra/tree/main/tools/torchfix and run `pip install .`
inside the directory.

To install a release version from PyPI, run `pip install torchfix`.

## Usage

After the installation, TorchFix will be available as a Flake8 plugin, so running
Flake8 normally will run the TorchFix linter.

To see only TorchFix warnings without the rest of the Flake8 linters, you can run
`flake8 --isolated --select=TOR`

TorchFix can also be run as a standalone program: `torchfix --ignore-stderr .`
Add `--fix` parameter to try to autofix some of the issues (the files will be overwritten!)

Please keep in mind that autofix is a best-effort mechanism. Given the dynamic nature of Python,
and especially the prototype/alpha version status of TorchFix, it's very difficult to have
certainty when making changes to code, even for the seemingly trivial fixes.

## Reporting problems

If you encounter a bug or some other problem with TorchFix, please file an issue on
https://github.com/pytorch/test-infra/issues, mentioning [TorchFix] in the title.
