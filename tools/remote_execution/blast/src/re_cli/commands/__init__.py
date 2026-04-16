"""Shared utilities for commands."""

from typing import cast

import click

from ..core.core_types import console
from ..core.k8s_client import K8sClient, K8sConfig


def get_client(ctx: click.Context) -> K8sClient:
    """Lazy-init K8sClient from click context. Call from any command."""
    if ctx.obj.get("_client") is None:
        console.print("[Auth] getting K8sConfig")
        config = K8sConfig(
            namespace=ctx.obj["_k8s_namespace"],
            timeout=ctx.obj["_k8s_timeout"],
        )
        ctx.obj["_client"] = K8sClient(config)
    return cast(K8sClient, ctx.obj["_client"])
