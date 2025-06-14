use aws_sdk_ssm::types::ParameterMetadata;
use chrono::{DateTime, Utc};

#[cfg(test)]
use mockall::automock;

pub mod cleanup;
pub mod client;
pub mod filter;

#[derive(Debug, Clone)]
pub struct CleanupConfig {
    pub region: String,
    pub dry_run: bool,
    pub older_than_days: u32,
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
) -> Result<CleanupResult, aws_sdk_ssm::Error> {
    let parameters = client.describe_parameters().await?;

    let parameters_to_delete =
        filter::filter_old_parameters(&parameters, time_provider, config.older_than_days);

    println!("Found {} parameters to delete", parameters_to_delete.len());
    let parameters_found = parameters_to_delete.len();

    let (deleted_count, failed_count) = if !config.dry_run {
        cleanup::delete_parameters_in_batches(client, parameters_to_delete).await?
    } else {
        println!("Dry run mode - no parameters were deleted");
        for name in &parameters_to_delete {
            println!("Would delete: {}", name);
        }
        (0, 0)
    };

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
            older_than_days: 1,
        };

        let result = cleanup_ssm_parameters(&mock_client, &time_provider, &config)
            .await
            .unwrap();

        assert_eq!(result.parameters_found, 1);
        assert_eq!(result.parameters_deleted, 0);
        assert_eq!(result.parameters_failed, 0);
    }
}
