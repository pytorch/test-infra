use serde::Deserialize;
use cleanup_common::{CleanupConfig as BaseConfig, CleanupResult, ResourceFilter, ResourceLister, ResourceProcessor};
use std::collections::HashSet;

#[cfg(test)]
use mockall::automock;

pub mod cleanup;
pub mod ec2_client;
pub mod github_client;

#[derive(Debug)]
pub enum RunnerCleanupError {
    GitHub(Box<dyn std::error::Error + Send + Sync>),
    Ec2(aws_sdk_ec2::Error),
}

impl std::fmt::Display for RunnerCleanupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunnerCleanupError::GitHub(e) => write!(f, "GitHub API error: {}", e),
            RunnerCleanupError::Ec2(e) => write!(f, "EC2 error: {}", e),
        }
    }
}

impl std::error::Error for RunnerCleanupError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            RunnerCleanupError::GitHub(e) => Some(e.as_ref()),
            RunnerCleanupError::Ec2(e) => Some(e),
        }
    }
}

impl From<aws_sdk_ec2::Error> for RunnerCleanupError {
    fn from(error: aws_sdk_ec2::Error) -> Self {
        RunnerCleanupError::Ec2(error)
    }
}

#[derive(Debug, Clone)]
pub struct RunnerCleanupConfig {
    pub base: BaseConfig,
    pub organization: String,
    pub runner_name: String,
    pub github_token: String,
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

#[derive(Debug, Clone)]
pub struct RunnerPair {
    pub github_runners: Vec<GitHubRunner>,
    pub ec2_instances: Vec<Ec2Instance>,
}

impl RunnerPair {
    pub fn find_orphaned_instances(&self) -> Vec<Ec2Instance> {
        let github_runner_names: HashSet<&str> = self.github_runners
            .iter()
            .map(|runner| runner.name.as_str())
            .collect();

        self.ec2_instances
            .iter()
            .filter(|instance| !github_runner_names.contains(instance.id.as_str()))
            .cloned()
            .collect()
    }
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

pub struct RunnerPairLister<'a, G: GitHubClient, E: Ec2Client> {
    github_client: &'a G,
    ec2_client: &'a E,
    organization: String,
    runner_name: String,
}

impl<'a, G: GitHubClient, E: Ec2Client> RunnerPairLister<'a, G, E> {
    pub fn new(github_client: &'a G, ec2_client: &'a E, organization: String, runner_name: String) -> Self {
        Self {
            github_client,
            ec2_client,
            organization,
            runner_name,
        }
    }
}

impl<'a, G: GitHubClient, E: Ec2Client> ResourceLister<RunnerPair> for RunnerPairLister<'a, G, E> {
    type Error = RunnerCleanupError;

    async fn list_resources(&self) -> Result<Vec<RunnerPair>, Self::Error> {
        let github_runners = self.github_client.get_runners(&self.organization).await
            .map_err(RunnerCleanupError::GitHub)?;
        let ec2_instances = self.ec2_client.get_instances_by_name(&self.runner_name).await
            .map_err(RunnerCleanupError::Ec2)?;

        Ok(vec![RunnerPair {
            github_runners,
            ec2_instances,
        }])
    }
}

pub struct OrphanedInstanceFilter;

impl ResourceFilter<RunnerPair> for OrphanedInstanceFilter {
    fn should_process(&self, pair: &RunnerPair) -> bool {
        !pair.find_orphaned_instances().is_empty()
    }
}

pub struct InstanceTerminator<'a, E: Ec2Client> {
    ec2_client: &'a E,
}

impl<'a, E: Ec2Client> InstanceTerminator<'a, E> {
    pub fn new(ec2_client: &'a E) -> Self {
        Self { ec2_client }
    }
}

impl<'a, E: Ec2Client> ResourceProcessor<RunnerPair> for InstanceTerminator<'a, E> {
    type Error = RunnerCleanupError;

    async fn process_batch(&self, pairs: Vec<RunnerPair>) -> Result<(usize, usize), Self::Error> {
        let mut terminated = 0;

        for pair in pairs {
            let orphaned_instances = pair.find_orphaned_instances();
            if !orphaned_instances.is_empty() {
                let instance_ids: Vec<String> = orphaned_instances.iter().map(|i| i.id.clone()).collect();
                terminated += cleanup::terminate_instances_in_batches(self.ec2_client, instance_ids).await
                    .map_err(RunnerCleanupError::Ec2)?;
            }
        }

        Ok((terminated, 0))
    }
}

pub async fn cleanup_offline_runners<G: GitHubClient, E: Ec2Client>(
    github_client: &G,
    ec2_client: &E,
    config: &RunnerCleanupConfig,
) -> Result<CleanupResult, RunnerCleanupError> {
    let lister = RunnerPairLister::new(
        github_client,
        ec2_client,
        config.organization.clone(),
        config.runner_name.clone()
    );
    let filter = OrphanedInstanceFilter;
    let processor = InstanceTerminator::new(ec2_client);

    cleanup_common::run_cleanup(&lister, &filter, &processor, &config.base).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use cleanup_common::CleanupConfig;

    #[tokio::test]
    async fn test_cleanup_dry_run() {
        let mut mock_github = MockGitHubClient::new();
        let mut mock_ec2 = MockEc2Client::new();

        mock_github
            .expect_get_runners()
            .times(1)
            .returning(|_| Ok(vec![GitHubRunner {
                id: 1,
                name: "i-123".to_string(),
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

        mock_ec2
            .expect_terminate_instances()
            .times(0);

        let config = RunnerCleanupConfig {
            base: CleanupConfig {
                region: "us-east-1".to_string(),
                dry_run: true,
            },
            organization: "test-org".to_string(),
            runner_name: "gh-ci-action-runner".to_string(),
            github_token: "token".to_string(),
        };

        let result = cleanup_offline_runners(&mock_github, &mock_ec2, &config).await.unwrap();

        assert_eq!(result.items_found, 1);
        assert_eq!(result.items_processed, 0);
        assert_eq!(result.items_failed, 0);
    }

    #[test]
    fn test_find_orphaned_instances() {
        let pair = RunnerPair {
            github_runners: vec![GitHubRunner {
                id: 1,
                name: "i-123".to_string(),
                status: "online".to_string(),
            }],
            ec2_instances: vec![
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
            ],
        };

        let orphaned = pair.find_orphaned_instances();
        assert_eq!(orphaned.len(), 1);
        assert_eq!(orphaned[0].id, "i-456");
    }
}
