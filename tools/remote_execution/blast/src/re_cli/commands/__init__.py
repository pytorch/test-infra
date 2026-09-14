"""Shared utilities for commands."""

import os
from typing import cast

import click

from ..core.core_types import console
from ..core.k8s_client import K8sClient, K8sConfig


def get_client(ctx: click.Context) -> K8sClient:
    """Lazy-init K8sClient from click context. Call from any command.

    If BLAST_FROM_CREDENTIALS=1 is set, uses AWS credentials from env vars
    (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) instead of kubeconfig.
    Optional: BLAST_ROLE_ARN to assume a role before connecting.
    """
    if ctx.obj.get("_client") is None:
        config = K8sConfig(
            namespace=ctx.obj["_k8s_namespace"],
            timeout=ctx.obj["_k8s_timeout"],
        )

        if os.environ.get("BLAST_FROM_CREDENTIALS") == "1":
            access_key = os.environ.get("AWS_ACCESS_KEY_ID", "")
            secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY", "")
            if not access_key or not secret_key:
                console.print("[red]Error: BLAST_FROM_CREDENTIALS=1 requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY[/red]")
                raise SystemExit(1)
            console.print("[Auth] using AWS credentials (from_credentials)")
            ctx.obj["_client"] = K8sClient.from_credentials(
                access_key=access_key,
                secret_key=secret_key,
                role_arn=os.environ.get("BLAST_ROLE_ARN", ""),
                cfg=config,
            )
        else:
            console.print("[Auth] getting K8sConfig")
            ctx.obj["_client"] = K8sClient(config)
    return cast(K8sClient, ctx.obj["_client"])
