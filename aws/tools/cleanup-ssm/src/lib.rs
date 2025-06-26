use aws_sdk_ssm::types::ParameterMetadata;
use chrono::{DateTime, Duration};
use cleanup_common::{CleanupConfig as BaseConfig, CleanupResult, ResourceFilter, ResourceLister, ResourceProcessor, time::TimeProvider};

#[cfg(test)]
use mockall::automock;

pub mod cleanup;
pub mod client;

#[derive(Debug, Clone)]
pub struct SsmCleanupConfig {
    pub base: BaseConfig,
    pub older_than_days: u16,
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

pub struct SsmParameterFilter<T: TimeProvider> {
    time_provider: T,
    older_than_days: u16,
}

impl<T: TimeProvider> SsmParameterFilter<T> {
    pub fn new(time_provider: T, older_than_days: u16) -> Self {
        Self {
            time_provider,
            older_than_days,
        }
    }
}

impl<T: TimeProvider> ResourceFilter<ParameterMetadata> for SsmParameterFilter<T> {
    fn should_process(&self, parameter: &ParameterMetadata) -> bool {
        if let Some(last_modified) = parameter.last_modified_date() {
            let threshold = self.time_provider.now() - Duration::days(self.older_than_days.into());
            let last_modified_time = DateTime::from_timestamp(last_modified.secs(), 0)
                .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap());
            last_modified_time < threshold
        } else {
            false
        }
    }
}

pub struct SsmParameterLister<'a, C: SsmClient> {
    client: &'a C,
}

impl<'a, C: SsmClient> SsmParameterLister<'a, C> {
    pub fn new(client: &'a C) -> Self {
        Self { client }
    }
}

impl<'a, C: SsmClient> ResourceLister<ParameterMetadata> for SsmParameterLister<'a, C> {
    type Error = aws_sdk_ssm::Error;
    
    async fn list_resources(&self) -> Result<Vec<ParameterMetadata>, Self::Error> {
        self.client.describe_parameters().await
    }
}

pub struct SsmParameterProcessor<'a, C: SsmClient> {
    client: &'a C,
}

impl<'a, C: SsmClient> SsmParameterProcessor<'a, C> {
    pub fn new(client: &'a C) -> Self {
        Self { client }
    }
}

impl<'a, C: SsmClient> ResourceProcessor<ParameterMetadata> for SsmParameterProcessor<'a, C> {
    type Error = aws_sdk_ssm::Error;
    
    async fn process_batch(&self, parameters: Vec<ParameterMetadata>) -> Result<(usize, usize), Self::Error> {
        let names: Vec<String> = parameters
            .into_iter()
            .filter_map(|p| p.name().map(|n| n.to_string()))
            .collect();
            
        cleanup::delete_parameters_in_batches(self.client, names).await
    }
}

pub async fn cleanup_ssm_parameters<C: SsmClient, T: TimeProvider>(
    client: &C,
    time_provider: T,
    config: &SsmCleanupConfig,
) -> Result<CleanupResult, aws_sdk_ssm::Error> {
    let lister = SsmParameterLister::new(client);
    let filter = SsmParameterFilter::new(time_provider, config.older_than_days);
    let processor = SsmParameterProcessor::new(client);
    
    cleanup_common::run_cleanup(&lister, &filter, &processor, &config.base).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_ssm::types::ParameterMetadata;
    use aws_smithy_types::DateTime as AwsDateTime;
    use chrono::{DateTime, Duration, Utc};
    use cleanup_common::{CleanupConfig, time::TimeProvider};

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

        mock_client
            .expect_delete_parameters()
            .times(0);

        let time_provider = MockTimeProvider::new(now);
        let config = SsmCleanupConfig {
            base: CleanupConfig {
                region: "us-east-1".to_string(),
                dry_run: true,
            },
            older_than_days: 1,
        };

        let result = cleanup_ssm_parameters(&mock_client, time_provider, &config)
            .await
            .unwrap();

        assert_eq!(result.items_found, 1);
        assert_eq!(result.items_processed, 0);
        assert_eq!(result.items_failed, 0);
    }
}
