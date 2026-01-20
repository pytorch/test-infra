"""GPU Developer CLI Package"""

import importlib.metadata

try:
    __version__ = importlib.metadata.version("gpu-dev-cli")
except importlib.metadata.PackageNotFoundError:
    # Fallback for development installations
    __version__ = "0.0.0-dev"
