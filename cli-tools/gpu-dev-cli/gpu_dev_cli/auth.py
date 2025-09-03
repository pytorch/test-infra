"""Minimal AWS-only authentication for GPU Dev CLI"""

import subprocess
import re
from typing import Dict, Any, Optional
from .config import Config


def authenticate_user(config: Config) -> Dict[str, Any]:
    """Authenticate using AWS credentials - if you can call AWS, you're authorized"""
    try:
        # Test AWS access by getting caller identity
        identity = config.get_user_identity()

        # Test specific resource access by trying to get queue URL
        config.get_queue_url()

        # Extract user info from AWS ARN
        arn = identity["arn"]
        user_name = arn.split("/")[-1]  # Extract username from ARN

        # Get GitHub username from config
        github_user = config.get_github_username()
        if not github_user:
            raise RuntimeError(
                f"GitHub username not configured. Please run: gpu-dev config set github_user <your-github-username>"
            )

        return {
            "user_id": user_name,  # AWS username for reservation ownership
            "github_user": github_user,  # GitHub username for SSH keys
            "arn": arn,
        }

    except Exception as e:
        raise RuntimeError(f"AWS authentication failed: {e}")


def validate_ssh_key_matches_github_user(config: Config) -> Dict[str, Any]:
    """
    Validate that the SSH key matches the configured GitHub username

    Returns:
        Dict with validation results:
        - "valid": bool - Whether SSH key matches configured username
        - "configured_user": str - Username from config
        - "ssh_user": str or None - Username detected from SSH
        - "error": str or None - Error message if validation failed
    """
    try:
        # Get configured GitHub username
        github_user = config.get_github_username()
        if not github_user:
            return {
                "valid": False,
                "configured_user": None,
                "ssh_user": None,
                "error": "GitHub username not configured. Run: gpu-dev config set github_user <username>",
            }

        # Run ssh git@github.com and capture output
        try:
            result = subprocess.run(
                ["ssh", "git@github.com"],
                capture_output=True,
                text=True,
                timeout=10,  # 10 second timeout
            )

            # GitHub SSH always returns non-zero exit code, so we check stderr for the response
            ssh_output = result.stderr

            # Parse GitHub SSH response to extract username
            # Expected format: "Hi <username>! You've successfully authenticated, but GitHub does not provide shell access."
            username_match = re.search(r"Hi ([^!]+)!", ssh_output)

            if not username_match:
                return {
                    "valid": False,
                    "configured_user": github_user,
                    "ssh_user": None,
                    "error": f"Could not parse GitHub SSH response. Output: {ssh_output[:200]}",
                }

            ssh_detected_user = username_match.group(1).strip()

            # Compare usernames (case-insensitive)
            is_valid = ssh_detected_user.lower() == github_user.lower()

            return {
                "valid": is_valid,
                "configured_user": github_user,
                "ssh_user": ssh_detected_user,
                "error": None
                if is_valid
                else f"SSH key belongs to '{ssh_detected_user}' but configured user is '{github_user}'",
            }

        except subprocess.TimeoutExpired:
            return {
                "valid": False,
                "configured_user": github_user,
                "ssh_user": None,
                "error": "SSH connection to GitHub timed out",
            }
        except subprocess.CalledProcessError as e:
            return {
                "valid": False,
                "configured_user": github_user,
                "ssh_user": None,
                "error": f"SSH command failed: {e}",
            }
        except FileNotFoundError:
            return {
                "valid": False,
                "configured_user": github_user,
                "ssh_user": None,
                "error": "SSH command not found. Please install OpenSSH client",
            }

    except Exception as e:
        return {
            "valid": False,
            "configured_user": github_user if "github_user" in locals() else None,
            "ssh_user": None,
            "error": f"Validation error: {str(e)}",
        }
