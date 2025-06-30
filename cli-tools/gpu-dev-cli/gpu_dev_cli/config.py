"""Configuration management for GPU Dev CLI"""

import os
import json
from typing import Optional, Dict, Any
from pydantic import BaseModel, Field
from pathlib import Path

class Config(BaseModel):
    """Configuration model for GPU Dev CLI"""
    
    aws_region: str = Field(default="us-east-2")
    queue_url: str = Field(...)
    reservations_table: str = Field(...)
    servers_table: str = Field(...)
    cluster_name: str = Field(...)
    github_org: str = Field(default="pytorch")
    github_repo: str = Field(default="pytorch")
    github_team: str = Field(default="metamates")
    github_token: Optional[str] = Field(default=None)
    
    class Config:
        env_prefix = "GPU_DEV_"

def get_config_path() -> Path:
    """Get the configuration file path"""
    config_dir = Path.home() / ".config" / "gpu-dev-cli"
    config_dir.mkdir(parents=True, exist_ok=True)
    return config_dir / "config.json"

def load_config() -> Config:
    """Load configuration from file and environment"""
    config_path = get_config_path()
    
    config_data = {}
    
    # Load from file if exists
    if config_path.exists():
        with open(config_path, 'r') as f:
            config_data = json.load(f)
    
    # Override with environment variables
    env_vars = {
        'aws_region': os.getenv('GPU_DEV_AWS_REGION', os.getenv('AWS_REGION')),
        'queue_url': os.getenv('GPU_DEV_QUEUE_URL'),
        'reservations_table': os.getenv('GPU_DEV_RESERVATIONS_TABLE'),
        'servers_table': os.getenv('GPU_DEV_SERVERS_TABLE'),
        'cluster_name': os.getenv('GPU_DEV_CLUSTER_NAME'),
        'github_org': os.getenv('GPU_DEV_GITHUB_ORG'),
        'github_repo': os.getenv('GPU_DEV_GITHUB_REPO'),
        'github_team': os.getenv('GPU_DEV_GITHUB_TEAM'),
        'github_token': os.getenv('GPU_DEV_GITHUB_TOKEN', os.getenv('GITHUB_TOKEN')),
    }
    
    # Update config_data with non-None environment variables
    for key, value in env_vars.items():
        if value is not None:
            config_data[key] = value
    
    return Config(**config_data)

def save_config(config: Config) -> None:
    """Save configuration to file"""
    config_path = get_config_path()
    
    with open(config_path, 'w') as f:
        json.dump(config.dict(exclude_none=True), f, indent=2)

def init_config() -> Config:
    """Initialize configuration with prompts"""
    import click
    
    click.echo("🚀 Initializing GPU Dev CLI configuration...")
    
    # Get required values
    queue_url = click.prompt("SQS Queue URL")
    reservations_table = click.prompt("Reservations DynamoDB Table")
    servers_table = click.prompt("Servers DynamoDB Table")
    cluster_name = click.prompt("EKS Cluster Name")
    
    # Optional values
    aws_region = click.prompt("AWS Region", default="us-east-2")
    github_org = click.prompt("GitHub Organization", default="pytorch")
    github_repo = click.prompt("GitHub Repository", default="pytorch")
    github_team = click.prompt("GitHub Team", default="metamates")
    
    config = Config(
        aws_region=aws_region,
        queue_url=queue_url,
        reservations_table=reservations_table,
        servers_table=servers_table,
        cluster_name=cluster_name,
        github_org=github_org,
        github_repo=github_repo,
        github_team=github_team
    )
    
    save_config(config)
    click.echo("✅ Configuration saved!")
    
    return config