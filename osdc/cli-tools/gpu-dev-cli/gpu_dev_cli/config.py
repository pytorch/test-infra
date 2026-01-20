"""Minimal configuration for GPU Dev CLI - Zero setup required"""

import os
import json
import boto3
from pathlib import Path
from typing import Dict, Any, Optional


class Config:
    """Zero-config AWS-based configuration"""

    # Environment configurations (test vs prod)
    ENVIRONMENTS = {
        "test": {
            "region": "us-west-1",
            "workspace": "default",
            "description": "Test environment",
        },
        "prod": {
            "region": "us-east-2",
            "workspace": "prod",
            "description": "Production environment",
        },
    }
    DEFAULT_ENVIRONMENT = "prod"

    # Config file path (class-level for access without instantiation)
    CONFIG_FILE = Path.home() / ".config" / "gpu-dev" / "config.json"

    # Legacy paths for migration
    LEGACY_CONFIG_FILE = Path.home() / ".gpu-dev-config"
    LEGACY_ENVIRONMENT_FILE = Path.home() / ".gpu-dev-environment.json"

    def __init__(self):
        # Load unified config (handles migration from legacy files)
        self.user_config = self._load_config()

        # Get region from config, then AWS env vars, or default
        if self.user_config.get("region"):
            self.aws_region = self.user_config["region"]
        else:
            self.aws_region = os.getenv(
                "AWS_REGION", os.getenv("AWS_DEFAULT_REGION", "us-east-2")
            )

        os.environ["AWS_DEFAULT_REGION"] = self.aws_region

        # Resource naming convention - no config needed!
        self.prefix = "pytorch-gpu-dev"

        # Construct ARNs from convention
        self.queue_name = f"{self.prefix}-reservation-queue"
        self.reservations_table = f"{self.prefix}-reservations"
        self.disks_table = f"{self.prefix}-disks"
        self.availability_table = f"{self.prefix}-gpu-availability"
        self.cluster_name = f"{self.prefix}-cluster"

        # Determine AWS session (with profile support)
        self.session = self._create_aws_session()

        # AWS clients
        self._sts_client = None
        self._sqs_client = None
        self._dynamodb = None

    def _create_aws_session(self):
        """Create AWS session with profile support"""
        try:
            # Try to use 'gpu-dev' profile if it exists
            session = boto3.Session(profile_name="gpu-dev")
            # Test if profile works by checking credentials
            session.get_credentials()
            return session
        except Exception:
            # Fall back to default credentials (environment, default profile, IAM role, etc.)
            return boto3.Session()

    @property
    def sts_client(self):
        if self._sts_client is None:
            self._sts_client = self.session.client("sts", region_name=self.aws_region)
        return self._sts_client

    @property
    def sqs_client(self):
        if self._sqs_client is None:
            self._sqs_client = self.session.client("sqs", region_name=self.aws_region)
        return self._sqs_client

    @property
    def dynamodb(self):
        if self._dynamodb is None:
            self._dynamodb = self.session.resource(
                "dynamodb", region_name=self.aws_region
            )
        return self._dynamodb

    def get_queue_url(self) -> str:
        """Get SQS queue URL by name"""
        try:
            response = self.sqs_client.get_queue_url(QueueName=self.queue_name)
            return response["QueueUrl"]
        except Exception as e:
            raise RuntimeError(
                f"Cannot access SQS queue {self.queue_name}. Check AWS permissions: {e}"
            )

    def get_user_identity(self) -> Dict[str, Any]:
        """Get current AWS user identity"""
        try:
            response = self.sts_client.get_caller_identity()
            return {
                "user_id": response["UserId"],
                "account": response["Account"],
                "arn": response["Arn"],
            }
        except Exception as e:
            raise RuntimeError(
                f"Cannot get AWS caller identity. Check AWS credentials: {e}"
            )

    def _load_config(self) -> Dict[str, Any]:
        """Load unified config from ~/.config/gpu-dev/config.json

        Migrates from legacy locations if needed:
        - ~/.gpu-dev-config (user config)
        - ~/.gpu-dev-environment.json (environment config)

        Ensures required environment keys exist, filling from defaults.
        """
        config = {}
        needs_save = False

        # Try to load existing config
        if self.CONFIG_FILE.exists():
            try:
                with open(self.CONFIG_FILE, "r") as f:
                    config = json.load(f)
            except Exception as e:
                print(f"Warning: Could not load config: {e}")
        else:
            # Migrate from legacy files
            migrated_from = []

            if self.LEGACY_CONFIG_FILE.exists():
                try:
                    with open(self.LEGACY_CONFIG_FILE, "r") as f:
                        config.update(json.load(f))
                    migrated_from.append(str(self.LEGACY_CONFIG_FILE))
                except Exception as e:
                    print(f"Warning: Could not read {self.LEGACY_CONFIG_FILE}: {e}")

            if self.LEGACY_ENVIRONMENT_FILE.exists():
                try:
                    with open(self.LEGACY_ENVIRONMENT_FILE, "r") as f:
                        config.update(json.load(f))
                    migrated_from.append(str(self.LEGACY_ENVIRONMENT_FILE))
                except Exception as e:
                    print(f"Warning: Could not read {self.LEGACY_ENVIRONMENT_FILE}: {e}")

            if migrated_from:
                print(
                    f"Migrated config from {', '.join(migrated_from)} "
                    f"to {self.CONFIG_FILE}"
                )
                needs_save = True

        # Ensure required environment keys exist
        default_env = self.ENVIRONMENTS[self.DEFAULT_ENVIRONMENT]
        if "region" not in config:
            config["region"] = default_env["region"]
            needs_save = True
        if "environment" not in config:
            config["environment"] = self.DEFAULT_ENVIRONMENT
            needs_save = True
        if "workspace" not in config:
            config["workspace"] = default_env["workspace"]
            needs_save = True

        # Save if we added any defaults or migrated
        if needs_save:
            try:
                self._save_config(config)
            except Exception as e:
                print(f"Warning: Could not save config: {e}")

        return config

    def _save_config(self, config: Dict[str, Any]) -> None:
        """Save config dict to file."""
        self.CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(self.CONFIG_FILE, "w") as f:
            json.dump(config, f, indent=2)

    def save_config(self, key: str, value: Any) -> None:
        """Save a configuration value."""
        self.user_config[key] = value
        self._save_config(self.user_config)

    def set_environment(self, env_name: str) -> Dict[str, Any]:
        """Set the environment (test or prod).

        Args:
            env_name: Environment name ('test' or 'prod')

        Returns:
            The environment config dict

        Raises:
            ValueError: If env_name is not valid

        Note:
            This does not invalidate cached AWS clients. In the CLI, this is
            fine since each command is a separate process. If using Config
            as a library, create a new instance after changing environments.
        """
        if env_name not in self.ENVIRONMENTS:
            raise ValueError(
                f"Invalid environment: {env_name}. "
                f"Must be one of: {list(self.ENVIRONMENTS.keys())}"
            )

        env_config = self.ENVIRONMENTS[env_name]

        # Update config with environment settings
        self.user_config["environment"] = env_name
        self.user_config["region"] = env_config["region"]
        self.user_config["workspace"] = env_config["workspace"]

        self._save_config(self.user_config)
        self.aws_region = env_config["region"]
        os.environ["AWS_DEFAULT_REGION"] = self.user_config["region"]

        return env_config

    def get(self, key: str) -> Optional[Any]:
        """Get a config value."""
        return self.user_config.get(key)

    def get_github_username(self) -> Optional[str]:
        """Get GitHub username from config."""
        return self.user_config.get("github_user")


def load_config() -> Config:
    """Load zero-config setup"""
    return Config()
