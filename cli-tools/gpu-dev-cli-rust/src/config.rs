use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub aws_region: String,
    pub queue_url: String,
    pub reservations_table: String,
    pub servers_table: String,
    pub cluster_name: String,
    pub github_org: String,
    pub github_repo: String,
    pub github_team: String,
    pub github_token: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            aws_region: "us-east-2".to_string(),
            queue_url: String::new(),
            reservations_table: String::new(),
            servers_table: String::new(),
            cluster_name: String::new(),
            github_org: "pytorch".to_string(),
            github_repo: "pytorch".to_string(),
            github_team: "metamates".to_string(),
            github_token: None,
        }
    }
}

impl Config {
    pub async fn load() -> Result<Self> {
        let mut config = Self::load_from_file().unwrap_or_default();
        
        // Override with environment variables
        if let Ok(region) = env::var("GPU_DEV_AWS_REGION").or_else(|_| env::var("AWS_REGION")) {
            config.aws_region = region;
        }
        
        if let Ok(queue_url) = env::var("GPU_DEV_QUEUE_URL") {
            config.queue_url = queue_url;
        }
        
        if let Ok(table) = env::var("GPU_DEV_RESERVATIONS_TABLE") {
            config.reservations_table = table;
        }
        
        if let Ok(table) = env::var("GPU_DEV_SERVERS_TABLE") {
            config.servers_table = table;
        }
        
        if let Ok(cluster) = env::var("GPU_DEV_CLUSTER_NAME") {
            config.cluster_name = cluster;
        }
        
        if let Ok(org) = env::var("GPU_DEV_GITHUB_ORG") {
            config.github_org = org;
        }
        
        if let Ok(repo) = env::var("GPU_DEV_GITHUB_REPO") {
            config.github_repo = repo;
        }
        
        if let Ok(team) = env::var("GPU_DEV_GITHUB_TEAM") {
            config.github_team = team;
        }
        
        if let Ok(token) = env::var("GPU_DEV_GITHUB_TOKEN").or_else(|_| env::var("GITHUB_TOKEN")) {
            config.github_token = Some(token);
        }
        
        config.validate()?;
        Ok(config)
    }
    
    fn load_from_file() -> Result<Self> {
        let config_path = Self::get_config_path()?;
        
        if !config_path.exists() {
            return Ok(Self::default());
        }
        
        let content = fs::read_to_string(config_path)?;
        let config: Self = serde_json::from_str(&content)?;
        Ok(config)
    }
    
    fn get_config_path() -> Result<PathBuf> {
        let config_dir = dirs::config_dir()
            .ok_or_else(|| anyhow::anyhow!("Could not find config directory"))?
            .join("gpu-dev-cli");
        
        fs::create_dir_all(&config_dir)?;
        Ok(config_dir.join("config.json"))
    }
    
    fn validate(&self) -> Result<()> {
        if self.queue_url.is_empty() {
            return Err(anyhow::anyhow!("Queue URL is required"));
        }
        
        if self.reservations_table.is_empty() {
            return Err(anyhow::anyhow!("Reservations table is required"));
        }
        
        if self.servers_table.is_empty() {
            return Err(anyhow::anyhow!("Servers table is required"));
        }
        
        if self.cluster_name.is_empty() {
            return Err(anyhow::anyhow!("Cluster name is required"));
        }
        
        Ok(())
    }
}