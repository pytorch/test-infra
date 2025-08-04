"""Minimal configuration for GPU Dev CLI - Zero setup required"""

import os
import boto3
from typing import Dict, Any

class Config:
    """Zero-config AWS-based configuration"""
    
    def __init__(self):
        # Get region from AWS env or default
        self.aws_region = os.getenv('AWS_REGION', os.getenv('AWS_DEFAULT_REGION', 'us-east-2'))
        
        # Resource naming convention - no config needed!
        self.prefix = "pytorch-gpu-dev"
        
        # Construct ARNs from convention
        self.queue_name = f"{self.prefix}-reservation-queue"
        self.reservations_table = f"{self.prefix}-reservations"
        self.servers_table = f"{self.prefix}-servers"
        self.cluster_name = f"{self.prefix}-cluster"
        
        # AWS clients
        self._sts_client = None
        self._sqs_client = None
        self._dynamodb = None
        
    @property
    def sts_client(self):
        if self._sts_client is None:
            self._sts_client = boto3.client('sts', region_name=self.aws_region)
        return self._sts_client
    
    @property 
    def sqs_client(self):
        if self._sqs_client is None:
            self._sqs_client = boto3.client('sqs', region_name=self.aws_region)
        return self._sqs_client
    
    @property
    def dynamodb(self):
        if self._dynamodb is None:
            self._dynamodb = boto3.resource('dynamodb', region_name=self.aws_region)
        return self._dynamodb
    
    def get_queue_url(self) -> str:
        """Get SQS queue URL by name"""
        try:
            response = self.sqs_client.get_queue_url(QueueName=self.queue_name)
            return response['QueueUrl']
        except Exception as e:
            raise RuntimeError(f"Cannot access SQS queue {self.queue_name}. Check AWS permissions: {e}")
    
    def get_user_identity(self) -> Dict[str, Any]:
        """Get current AWS user identity"""
        try:
            response = self.sts_client.get_caller_identity()
            return {
                'user_id': response['UserId'],
                'account': response['Account'],
                'arn': response['Arn']
            }
        except Exception as e:
            raise RuntimeError(f"Cannot get AWS caller identity. Check AWS credentials: {e}")

def load_config() -> Config:
    """Load zero-config setup"""
    return Config()