use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::config::Config;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub login: String,
    pub id: u64,
    pub name: Option<String>,
    pub email: Option<String>,
}

pub async fn authenticate_user(config: &Config) -> Result<UserInfo> {
    let token = config
        .github_token
        .as_ref()
        .ok_or_else(|| anyhow!("GitHub token not found. Please set GITHUB_TOKEN environment variable"))?;
    
    // Get user info
    let user_info = get_user_info(token).await?;
    
    // Check team membership
    if !is_team_member(token, &config.github_org, &config.github_team, &user_info.login).await? {
        return Err(anyhow!(
            "User {} is not a member of {}/{}",
            user_info.login,
            config.github_org,
            config.github_team
        ));
    }
    
    // Check repository access
    if !has_repo_access(token, &config.github_org, &config.github_repo, &user_info.login).await? {
        return Err(anyhow!(
            "User {} does not have access to {}/{}",
            user_info.login,
            config.github_org,
            config.github_repo
        ));
    }
    
    Ok(user_info)
}

async fn get_user_info(token: &str) -> Result<UserInfo> {
    let client = Client::new();
    
    let response = client
        .get("https://api.github.com/user")
        .header("Authorization", format!("token {}", token))
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "gpu-dev-cli")
        .send()
        .await?;
    
    if !response.status().is_success() {
        return Err(anyhow!("Failed to get user info: {}", response.status()));
    }
    
    let user_info: UserInfo = response.json().await?;
    Ok(user_info)
}

async fn is_team_member(token: &str, org: &str, team: &str, username: &str) -> Result<bool> {
    let client = Client::new();
    
    // Try membership endpoint first
    let url = format!("https://api.github.com/orgs/{}/teams/{}/memberships/{}", org, team, username);
    let response = client
        .get(&url)
        .header("Authorization", format!("token {}", token))
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "gpu-dev-cli")
        .send()
        .await?;
    
    if response.status().is_success() {
        #[derive(Deserialize)]
        struct Membership {
            state: String,
        }
        
        let membership: Membership = response.json().await?;
        return Ok(membership.state == "active");
    }
    
    // Try alternative endpoint
    let url = format!("https://api.github.com/orgs/{}/teams/{}/members/{}", org, team, username);
    let response = client
        .get(&url)
        .header("Authorization", format!("token {}", token))
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "gpu-dev-cli")
        .send()
        .await?;
    
    Ok(response.status().as_u16() == 204)
}

async fn has_repo_access(token: &str, org: &str, repo: &str, username: &str) -> Result<bool> {
    let client = Client::new();
    
    // Check collaborator status
    let url = format!("https://api.github.com/repos/{}/{}/collaborators/{}", org, repo, username);
    let response = client
        .get(&url)
        .header("Authorization", format!("token {}", token))
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "gpu-dev-cli")
        .send()
        .await?;
    
    if response.status().as_u16() == 204 {
        return Ok(true);
    }
    
    // Check permission level
    let url = format!("https://api.github.com/repos/{}/{}/collaborators/{}/permission", org, repo, username);
    let response = client
        .get(&url)
        .header("Authorization", format!("token {}", token))
        .header("Accept", "application/vnd.github.v3+json")
        .header("User-Agent", "gpu-dev-cli")
        .send()
        .await?;
    
    if response.status().is_success() {
        #[derive(Deserialize)]
        struct Permission {
            permission: String,
        }
        
        let permission: Permission = response.json().await?;
        return Ok(matches!(permission.permission.as_str(), "admin" | "write" | "maintain"));
    }
    
    Ok(false)
}