"""Minimal AWS-only authentication for GPU Dev CLI"""

from typing import Dict, Any
from .config import Config

def authenticate_user(config: Config) -> Dict[str, Any]:
    """Authenticate using AWS credentials - if you can call AWS, you're authorized"""
    try:
        # Test AWS access by getting caller identity
        identity = config.get_user_identity()
        
        # Test specific resource access by trying to get queue URL
        config.get_queue_url()
        
        # Extract user info from AWS ARN
        arn = identity['arn']
        user_name = arn.split('/')[-1]  # Extract username from ARN
        
        return {
            'login': user_name,
            'user_id': identity['user_id'],
            'account': identity['account'],
            'arn': arn
        }
        
    except Exception as e:
        raise RuntimeError(f"AWS authentication failed: {e}")