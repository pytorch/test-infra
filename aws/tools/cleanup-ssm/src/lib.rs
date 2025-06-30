use aws_sdk_ssm::types::ParameterMetadata;
use chrono::{DateTime, Utc};

#[derive(Debug)]
pub enum CleanupError {
    Aws(aws_sdk_ssm::Error),
    Regex(regex::Error),
}

impl From<aws_sdk_ssm::Error> for CleanupError {
    fn from(err: aws_sdk_ssm::Error) -> Self {
        CleanupError::Aws(err)
    }
}

impl From<regex::Error> for CleanupError {
    fn from(err: regex::Error) -> Self {
        CleanupError::Regex(err)
    }
}

impl std::fmt::Display for CleanupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CleanupError::Aws(err) => write!(f, "AWS error: {}", err),
            CleanupError::Regex(err) => write!(f, "Regex error: {}", err),
        }
    }
}

impl std::error::Error for CleanupError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            CleanupError::Aws(err) => Some(err),
            CleanupError::Regex(err) => Some(err),
        }
    }
}

#[cfg(test)]
use mockall::automock;

pub mod cleanup;
pub mod client;
pub mod filter;

#[derive(Debug, Clone)]
pub struct CleanupConfig {
    pub region: String,
    pub dry_run: bool,
    pub older_than_seconds: f64,
    pub pattern: String,
}

#[derive(Debug)]
pub struct CleanupResult {
    pub parameters_found: usize,
    pub parameters_deleted: usize,
    pub parameters_failed: usize,
}

#[cfg_attr(test, automock)]
pub trait SsmClient {
    #[allow(async_fn_in_trait)]
    async fn describe_parameters(&self) -> Result<Vec<ParameterMetadata>, aws_sdk_ssm::Error>;
    #[allow(async_fn_in_trait)]
    async fn delete_parameters(
        &self,
        names: Vec<String>,
    ) -> Result<(Vec<String>, Vec<String>), aws_sdk_ssm::Error>;
}

pub trait TimeProvider {
    fn now(&self) -> DateTime<Utc>;
}

pub struct SystemTimeProvider;

impl TimeProvider for SystemTimeProvider {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

pub async fn cleanup_ssm_parameters<C: SsmClient, T: TimeProvider>(
    client: &C,
    time_provider: &T,
    config: &CleanupConfig,
) -> Result<CleanupResult, CleanupError> {
    let parameters = client.describe_parameters().await?;

    let parameters_to_delete = filter::filter_old_parameters(
        &parameters,
        time_provider,
        config.older_than_seconds,
        &config.pattern,
    )?;

    println!("Found {} parameters to delete", parameters_to_delete.len());
    let parameters_found = parameters_to_delete.len();

    let deleted_count;
    let failed_count;

    if config.dry_run {
        println!("Dry run mode - no parameters were deleted");
        for name in &parameters_to_delete {
            println!("Would delete: {}", name);
        }
        deleted_count = 0;
        failed_count = 0;
    } else {
        let (actual_deleted, actual_failed) =
            cleanup::delete_parameters_in_batches(client, parameters_to_delete).await?;
        deleted_count = actual_deleted;
        failed_count = actual_failed;
    }

    Ok(CleanupResult {
        parameters_found,
        parameters_deleted: deleted_count,
        parameters_failed: failed_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_ssm::types::ParameterMetadata;
    use aws_smithy_types::DateTime as AwsDateTime;
    use chrono::{DateTime, Duration, Utc};

    struct MockTimeProvider {
        fixed_time: DateTime<Utc>,
    }

    impl MockTimeProvider {
        fn new(fixed_time: DateTime<Utc>) -> Self {
            Self { fixed_time }
        }
    }

    impl TimeProvider for MockTimeProvider {
        fn now(&self) -> DateTime<Utc> {
            self.fixed_time
        }
    }

    #[tokio::test]
    async fn test_cleanup_dry_run() {
        let mut mock_client = MockSsmClient::new();
        let now = Utc::now();
        let old_time = now - Duration::days(5);

        let parameter = ParameterMetadata::builder()
            .name("test-param")
            .last_modified_date(AwsDateTime::from_secs(old_time.timestamp()))
            .build();

        mock_client
            .expect_describe_parameters()
            .times(1)
            .returning(move || Ok(vec![parameter.clone()]));

        let time_provider = MockTimeProvider::new(now);
        let config = CleanupConfig {
            region: "us-east-1".to_string(),
            dry_run: true,
            older_than_seconds: 86400.0, // 1 day in seconds
            pattern: ".*".to_string(),
        };

        let result = cleanup_ssm_parameters(&mock_client, &time_provider, &config)
            .await
            .unwrap();

        assert_eq!(result.parameters_found, 1);
        assert_eq!(result.parameters_deleted, 0);
        assert_eq!(result.parameters_failed, 0);
    }
}
