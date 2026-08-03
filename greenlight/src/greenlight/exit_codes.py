"""Process exit codes for the greenlight service."""

from __future__ import annotations

EXIT_OK = 0
EXIT_FAILURE = 1
# 2 is reserved by argparse for CLI usage errors
EXIT_ALREADY_RUNNING = 3
