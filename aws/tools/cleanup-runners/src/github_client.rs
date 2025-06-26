use crate::{GitHubClient, GitHubRunner};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, USER_AGENT};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct GitHubRunnersResponse {
    runners: Vec<GitHubRunner>,
}

#[derive(Clone)]
pub struct GitHubApiClient {
    client: reqwest::Client,
}

impl GitHubApiClient {
    pub fn new(token: String) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("token {}", token))?,
        );
        headers.insert(USER_AGENT, HeaderValue::from_static("clear-offline-runners"));

        let client = reqwest::Client::builder()
            .default_headers(headers)
            .build()?;

        Ok(Self { client })
    }
}

impl GitHubClient for GitHubApiClient {
    async fn get_runners(&self, organization: &str) -> Result<Vec<GitHubRunner>, Box<dyn std::error::Error + Send + Sync>> {
        let url = format!("https://api.github.com/orgs/{}/actions/runners", organization);
        
        let response = self.client
            .get(&url)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(format!(
                "GitHub API request failed with status: {} - {}",
                response.status(),
                response.text().await.unwrap_or_else(|_| "Unknown error".to_string())
            ).into());
        }

        let runners_response: GitHubRunnersResponse = response.json().await?;
        Ok(runners_response.runners)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_github_client_creation() {
        let client = GitHubApiClient::new("test-token".to_string());
        assert!(client.is_ok());
    }

    #[test]
    fn test_github_client_creation_invalid_token() {
        // Test with invalid characters that would fail header validation
        let client = GitHubApiClient::new("test\ntoken".to_string());
        assert!(client.is_err());
    }
} 