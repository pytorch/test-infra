"""Module execution entry point for ``python -m greenlight``."""

from __future__ import annotations

from greenlight.cli import main

__all__ = ["main"]

if __name__ == "__main__":
    raise SystemExit(main())
