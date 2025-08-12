"""
Shared Kubernetes client utilities for Lambda functions
Handles EKS authentication and client setup
"""

import base64
import logging
import os
import re

import boto3
from botocore.signers import RequestSigner

logger = logging.getLogger(__name__)

# Environment variables that should be set by Lambda
EKS_CLUSTER_NAME = os.environ.get("EKS_CLUSTER_NAME")
REGION = os.environ.get("REGION")


def get_bearer_token():
    """Get EKS bearer token using AWS STS signing"""
    STS_TOKEN_EXPIRES_IN = 60
    session = boto3.session.Session(region_name=REGION)

    sts_client = session.client("sts")
    service_id = sts_client.meta.service_model.service_id

    signer = RequestSigner(
        service_id, REGION, "sts", "v4", session.get_credentials(), session.events
    )

    params = {
        "method": "GET",
        "url": f"https://sts.{REGION}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15",
        "body": {},
        "headers": {"x-k8s-aws-id": EKS_CLUSTER_NAME},
        "context": {},
    }

    signed_url = signer.generate_presigned_url(
        params, region_name=REGION, expires_in=STS_TOKEN_EXPIRES_IN, operation_name=""
    )

    base64_url = base64.urlsafe_b64encode(signed_url.encode("utf-8")).decode("utf-8")
    # Remove any base64 encoding padding
    return "k8s-aws-v1." + re.sub(r"=*", "", base64_url)


def setup_kubernetes_client():
    """Set up Kubernetes client for EKS cluster using AWS STS signing"""
    try:
        from kubernetes import client

        # Get EKS cluster info
        eks = boto3.client("eks", region_name=REGION)
        cluster_info = eks.describe_cluster(name=EKS_CLUSTER_NAME)
        cluster = cluster_info["cluster"]

        # Get cluster endpoint and certificate
        cluster_endpoint = cluster["endpoint"]
        cert_authority = cluster["certificateAuthority"]["data"]

        # Write CA cert to temp file
        with open("/tmp/ca.crt", "wb") as f:
            f.write(base64.b64decode(cert_authority))

        # Create configuration
        configuration = client.Configuration()
        configuration.api_key = {"authorization": get_bearer_token()}
        configuration.api_key_prefix = {"authorization": "Bearer"}
        configuration.host = cluster_endpoint
        configuration.ssl_ca_cert = "/tmp/ca.crt"

        return client.ApiClient(configuration)

    except Exception as e:
        logger.error(f"Failed to configure Kubernetes client: {str(e)}")
        raise
