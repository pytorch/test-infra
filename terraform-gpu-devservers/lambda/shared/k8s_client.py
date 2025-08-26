"""
Shared Kubernetes client utilities for Lambda functions
Handles EKS authentication and client setup with just-in-time EKS token refresh
"""

import base64
import logging
import os
import re
import time

import boto3
from botocore.signers import RequestSigner
from kubernetes import client

logger = logging.getLogger(__name__)

# Environment variables set by Lambda
EKS_CLUSTER_NAME = os.environ.get("EKS_CLUSTER_NAME")
REGION = os.environ.get("REGION")

# Token cache (module scope so it survives warm starts)
_token_cache = {"token": None, "expires_at": 0.0}

# Refresh when <60s left; effective TTL ~14m
_REFRESH_EARLY_SECONDS = 60
_EFFECTIVE_TOKEN_TTL = 14 * 60  # ~14 minutes


def get_bearer_token() -> str:
    """
    Create a k8s-aws-v1 bearer token by presigning STS:GetCallerIdentity.
    IMPORTANT: base64url-encode the FULL presigned URL, then strip padding.
    """
    logger.info("Starting bearer token generation")
    STS_TOKEN_EXPIRES_IN = 60
    session = boto3.session.Session(region_name=REGION)
    logger.info(f"Created boto3 session for region {REGION}")
    
    sts_client = session.client("sts")
    logger.info("Created STS client")
    
    service_id = sts_client.meta.service_model.service_id

    logger.info("Getting session credentials")
    credentials = session.get_credentials()
    logger.info("Creating request signer")
    
    signer = RequestSigner(
        service_id, REGION, "sts", "v4", credentials, session.events
    )
    
    logger.info("Preparing STS request parameters")
    params = {
        "method": "GET",
        "url": f"https://sts.{REGION}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15",
        "body": {},
        "headers": {"x-k8s-aws-id": EKS_CLUSTER_NAME},
        "context": {},
    }

    logger.info("Generating presigned URL")
    presigned = signer.generate_presigned_url(
        params, region_name=REGION, expires_in=STS_TOKEN_EXPIRES_IN, operation_name=""
    )
    
    logger.info("Encoding bearer token")
    b64 = base64.urlsafe_b64encode(presigned.encode("utf-8")).decode("utf-8")
    token = "k8s-aws-v1." + re.sub(r"=*$", "", b64)
    logger.info("Bearer token generation completed")
    return token


def setup_kubernetes_client() -> client.ApiClient:
    """
    Build an ApiClient configured for EKS and attach a refresh hook that
    keeps the Authorization header up to date. No locking (single-threaded Lambda).
    """
    try:
        logger.info(f"Creating EKS client for region {REGION}")
        eks = boto3.client("eks", region_name=REGION)
        
        logger.info(f"Describing EKS cluster: {EKS_CLUSTER_NAME}")
        cluster = eks.describe_cluster(name=EKS_CLUSTER_NAME)["cluster"]
        logger.info(f"Retrieved EKS cluster info for {EKS_CLUSTER_NAME}")

        # Always write CA cert (safe and avoids stale CA edge cases)
        logger.info("Writing CA certificate to /tmp/ca.crt")
        ca_path = "/tmp/ca.crt"
        with open(ca_path, "wb") as f:
            f.write(base64.b64decode(cluster["certificateAuthority"]["data"]))

        logger.info("Creating Kubernetes client configuration")
        cfg = client.Configuration()
        cfg.host = cluster["endpoint"]
        cfg.ssl_ca_cert = ca_path
        cfg.api_key_prefix = {"authorization": "Bearer"}

        logger.info("Getting initial bearer token")
        # Seed token
        initial = get_bearer_token()
        cfg.api_key = {"authorization": initial}
        logger.info("Bearer token obtained successfully")
        _token_cache["token"] = initial
        _token_cache["expires_at"] = time.time() + _EFFECTIVE_TOKEN_TTL

        # Called right before each request reads api_key
        def _refresh(cfg_obj: client.Configuration):
            now = time.time()
            if (
                _token_cache["token"]
                and now < _token_cache["expires_at"] - _REFRESH_EARLY_SECONDS
            ):
                return
            new_token = get_bearer_token()
            _token_cache["token"] = new_token
            _token_cache["expires_at"] = time.time() + _EFFECTIVE_TOKEN_TTL
            cfg_obj.api_key = {"authorization": new_token}

        cfg.refresh_api_key_hook = _refresh
        return client.ApiClient(cfg)

    except Exception as e:
        logger.error(f"Failed to configure Kubernetes client: {e}")
        raise
