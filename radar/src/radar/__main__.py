"""Module execution entry point for ``python -m radar``."""

from __future__ import annotations

from radar.cli import main

__all__ = ["main"]

if __name__ == "__main__":
    raise SystemExit(main())
