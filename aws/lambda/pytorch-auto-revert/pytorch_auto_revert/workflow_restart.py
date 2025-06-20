"""
Shared module for restarting PyTorch workflows via GitHub API.
"""

import os
import requests
import logging


def dispatch_workflow(workflow_name: str, commit_sha: str) -> bool:
    """
    Dispatch a PyTorch workflow for a specific commit SHA.
    
    Args:
        workflow_name: Name of the workflow file (e.g., "trunk.yml")
        commit_sha: The commit SHA to restart workflow for
        
    Returns:
        bool: True if workflow was successfully dispatched, False otherwise
    """
    github_token = os.getenv("GITHUB_TOKEN")
    repo_owner = os.getenv("GITHUB_REPO_OWNER", "pytorch")
    repo_name = os.getenv("GITHUB_REPO_NAME", "pytorch")
    
    if not github_token:
        raise ValueError("GITHUB_TOKEN environment variable is required")
    
    logger = logging.getLogger(__name__)
    
    try:
        # Use trunk/{sha} tag format
        tag_ref = f"trunk/{commit_sha}"
        
        url = f"https://api.github.com/repos/{repo_owner}/{repo_name}/actions/workflows/{workflow_name}/dispatches"
        headers = {
            "Authorization": f"token {github_token}",
            "Accept": "application/vnd.github.v3+json"
        }
        data = {
            "ref": tag_ref,
            "inputs": {}
        }
        
        response = requests.post(url, headers=headers, json=data)
        
        if response.status_code == 204:
            logger.info(f"Successfully dispatched workflow {workflow_name} for commit {commit_sha}")
            return True
        else:
            logger.error(f"Failed to dispatch workflow: {response.status_code} - {response.text}")
            return False
            
    except Exception as e:
        logger.error(f"Error dispatching workflow {workflow_name}: {e}")
        return False