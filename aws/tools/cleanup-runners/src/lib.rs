use serde::Deserialize;

#[cfg(test)]
use mockall::automock;

pub mod cleanup;
pub mod ec2_client;
pub mod filter;
pub mod github_client;

#[derive(Debug, Clone)]
pub struct CleanupConfig {
    pub organization: String,
    pub region: String,
    pub dry_run: bool,
    pub runner_name: String,
    pub github_token: String,
}

#[derive(Debug)]
pub struct CleanupResult {
    pub github_runners_found: usize,
    pub ec2_instances_found: usize,
    pub orphaned_instances: usize,
    pub instances_terminated: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GitHubRunner {
    pub id: u64,
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct Ec2Instance {
    pub id: String,
    pub name: String,
    pub state: String,
}

#[cfg_attr(test, automock)]
pub trait GitHubClient {
    #[allow(async_fn_in_trait)]
    async fn get_runners(&self, organization: &str) -> Result<Vec<GitHubRunner>, Box<dyn std::error::Error + Send + Sync>>;
}

#[cfg_attr(test, automock)]
pub trait Ec2Client {
    #[allow(async_fn_in_trait)]
    async fn get_instances_by_name(&self, name_pattern: &str) -> Result<Vec<Ec2Instance>, aws_sdk_ec2::Error>;
    #[allow(async_fn_in_trait)]
    async fn terminate_instances(&self, instance_ids: Vec<String>) -> Result<usize, aws_sdk_ec2::Error>;
}

pub async fn cleanup_offline_runners<G: GitHubClient, E: Ec2Client>(
    github_client: &G,
    ec2_client: &E,
    config: &CleanupConfig,
) -> Result<CleanupResult, Box<dyn std::error::Error + Send + Sync>> {
    // Get GitHub runners
    let github_runners = github_client.get_runners(&config.organization).await?;
    println!("Found {} GitHub runners", github_runners.len());

    // Get EC2 instances
    let ec2_instances = ec2_client.get_instances_by_name(&config.runner_name).await?;
    println!("Found {} EC2 instances with name '{}'", ec2_instances.len(), config.runner_name);

    // Find orphaned instances
    let orphaned_instances = filter::find_orphaned_instances(&github_runners, &ec2_instances);
    println!("Found {} orphaned instances", orphaned_instances.len());

    let instances_terminated = if config.dry_run {
        println!("Dry run mode - no instances were terminated");
        for instance in &orphaned_instances {
            println!("Would terminate: {} ({})", instance.id, instance.name);
        }
        0
    } else {
        let instance_ids: Vec<String> = orphaned_instances.iter().map(|i| i.id.clone()).collect();
        cleanup::terminate_instances_in_batches(ec2_client, instance_ids).await?
    };

    Ok(CleanupResult {
        github_runners_found: github_runners.len(),
        ec2_instances_found: ec2_instances.len(),
        orphaned_instances: orphaned_instances.len(),
        instances_terminated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_cleanup_dry_run() {
        let mut mock_github = MockGitHubClient::new();
        let mut mock_ec2 = MockEc2Client::new();

        mock_github
            .expect_get_runners()
            .times(1)
            .returning(|_| Ok(vec![GitHubRunner {
                id: 1,
                name: "i-123".to_string(), // GitHub runner name should match EC2 instance ID
                status: "online".to_string(),
            }]));

        mock_ec2
            .expect_get_instances_by_name()
            .times(1)
            .returning(|_| Ok(vec![
                Ec2Instance {
                    id: "i-123".to_string(),
                    name: "runner-1".to_string(),
                    state: "running".to_string(),
                },
                Ec2Instance {
                    id: "i-456".to_string(),
                    name: "runner-2".to_string(),
                    state: "running".to_string(),
                },
            ]));

        let config = CleanupConfig {
            organization: "test-org".to_string(),
            region: "us-east-1".to_string(),
            dry_run: true,
            runner_name: "gh-ci-action-runner".to_string(),
            github_token: "token".to_string(),
        };

        let result = cleanup_offline_runners(&mock_github, &mock_ec2, &config).await.unwrap();

        assert_eq!(result.github_runners_found, 1);
        assert_eq!(result.ec2_instances_found, 2);
        assert_eq!(result.orphaned_instances, 1);
        assert_eq!(result.instances_terminated, 0);
    }
} 