"""Authentication module for GPU Dev CLI"""

import requests
import os
from typing import Optional, Dict, Any
from .config import Config

def get_github_token() -> Optional[str]:
    """Get GitHub token from environment or config"""
    return os.getenv('GITHUB_TOKEN') or os.getenv('GPU_DEV_GITHUB_TOKEN')

def authenticate_user(config: Config) -> Optional[Dict[str, Any]]:
    """Authenticate user with GitHub and verify team membership"""
    token = get_github_token()
    
    if not token:
        print("❌ GitHub token not found. Please set GITHUB_TOKEN environment variable")
        return None
    
    # Get user info
    user_info = get_user_info(token)
    if not user_info:
        print("❌ Failed to get user info from GitHub")
        return None
    
    # Check team membership
    if not is_team_member(token, config.github_org, config.github_team, user_info['login']):
        print(f"❌ User {user_info['login']} is not a member of {config.github_org}/{config.github_team}")
        return None
    
    # Check repository access
    if not has_repo_access(token, config.github_org, config.github_repo, user_info['login']):
        print(f"❌ User {user_info['login']} does not have access to {config.github_org}/{config.github_repo}")
        return None
    
    return user_info

def get_user_info(token: str) -> Optional[Dict[str, Any]]:
    """Get authenticated user information from GitHub API"""
    try:
        headers = {
            'Authorization': f'token {token}',
            'Accept': 'application/vnd.github.v3+json'
        }
        
        response = requests.get('https://api.github.com/user', headers=headers)
        response.raise_for_status()
        
        return response.json()
    
    except requests.RequestException as e:
        print(f"❌ Error getting user info: {e}")
        return None

def is_team_member(token: str, org: str, team: str, username: str) -> bool:
    """Check if user is a member of the specified GitHub team"""
    try:
        headers = {
            'Authorization': f'token {token}',
            'Accept': 'application/vnd.github.v3+json'
        }
        
        # Check team membership
        response = requests.get(
            f'https://api.github.com/orgs/{org}/teams/{team}/memberships/{username}',
            headers=headers
        )
        
        if response.status_code == 200:
            membership = response.json()
            return membership.get('state') == 'active'
        elif response.status_code == 404:
            # Try alternative API endpoint
            response = requests.get(
                f'https://api.github.com/orgs/{org}/teams/{team}/members/{username}',
                headers=headers
            )
            return response.status_code == 204
        
        return False
    
    except requests.RequestException as e:
        print(f"❌ Error checking team membership: {e}")
        return False

def has_repo_access(token: str, org: str, repo: str, username: str) -> bool:
    """Check if user has access to the specified repository"""
    try:
        headers = {
            'Authorization': f'token {token}',
            'Accept': 'application/vnd.github.v3+json'
        }
        
        # Check repository access
        response = requests.get(
            f'https://api.github.com/repos/{org}/{repo}/collaborators/{username}',
            headers=headers
        )
        
        if response.status_code == 204:
            return True
        
        # Check if user has push access to repository
        response = requests.get(
            f'https://api.github.com/repos/{org}/{repo}/collaborators/{username}/permission',
            headers=headers
        )
        
        if response.status_code == 200:
            permission = response.json()
            return permission.get('permission') in ['admin', 'write', 'maintain']
        
        return False
    
    except requests.RequestException as e:
        print(f"❌ Error checking repository access: {e}")
        return False

def get_user_public_keys(token: str, username: str) -> list:
    """Get user's public SSH keys from GitHub"""
    try:
        headers = {
            'Authorization': f'token {token}',
            'Accept': 'application/vnd.github.v3+json'
        }
        
        response = requests.get(
            f'https://api.github.com/users/{username}/keys',
            headers=headers
        )
        response.raise_for_status()
        
        return response.json()
    
    except requests.RequestException as e:
        print(f"❌ Error getting user public keys: {e}")
        return []