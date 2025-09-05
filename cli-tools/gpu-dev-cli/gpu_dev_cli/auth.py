"""Minimal AWS-only authentication for GPU Dev CLI"""

import subprocess
import re
from typing import Dict, Any
from .config import Config
from rich.spinner import Spinner


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


def validate_ssh_key_matches_github_user(config: Config, live=None) -> Dict[str, Any]:
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

        # Run ssh git@github.com with interactive host verification support
        ssh_output = None

        try:
            # First try with batch mode to check if host key is already known
            batch_result = subprocess.run(
                ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "git@github.com"],
                capture_output=True,
                text=True,
                timeout=10,
            )

            # If batch mode works, use that output
            ssh_output = batch_result.stderr or ""

            # Check if output indicates host key verification failure
            if "Host key verification failed" in ssh_output or "authenticity of host" in ssh_output:
                raise subprocess.CalledProcessError(batch_result.returncode, "ssh", "Host verification needed")

        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as batch_error:
            try:
                # Host key not known, need interactive verification
                from rich.console import Console
                console = Console()

                # Stop the spinner to allow interactive input
                if live:
                    live.stop()

                console.print(
                    "[yellow]⚠️  GitHub host key verification required. Please respond to the prompt below.[/yellow]")

                # Use os.system for true terminal interaction
                import os
                exit_code = os.system("ssh -o BatchMode=no -o ConnectTimeout=10 git@github.com")

                # Restart the spinner
                if live:
                    live.start()
                    live.update(Spinner("dots", text="🔐 Validating SSH key..."))
                # SSH should return non-zero (that's normal for GitHub), but if it's 255 it means connection failed
                if exit_code == 255 * 256:  # os.system returns exit_code * 256
                    console.print("[red]⚠️  SSH connection failed - host key may not have been accepted.[/red]")
                    raise Exception("SSH connection failed - host key may not have been accepted")

                # After interactive verification, run again in batch mode to get output
                final_result = subprocess.run(
                    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "git@github.com"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )

                ssh_output = final_result.stderr or ""

            except Exception as interactive_error:
                return {
                    "valid": False,
                    "configured_user": github_user,
                    "ssh_user": None,
                    "error": f"Interactive SSH verification failed: {str(interactive_error)}",
                }

        # Ensure ssh_output is not None
        if ssh_output is None:
            ssh_output = ""

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

    except Exception as e:
        return {
            "valid": False,
            "configured_user": github_user if "github_user" in locals() else None,
            "ssh_user": None,
            "error": f"Validation error: {str(e)}",
        }
