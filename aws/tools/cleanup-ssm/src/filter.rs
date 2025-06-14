use crate::TimeProvider;
use aws_sdk_ssm::types::ParameterMetadata;
use chrono::{DateTime, Duration};

pub fn filter_old_parameters<T: TimeProvider>(
    parameters: &[ParameterMetadata],
    time_provider: &T,
    older_than_days: u32,
) -> Vec<String> {
    let threshold = time_provider.now() - Duration::days(older_than_days.into());
    let mut parameters_to_delete = Vec::new();

    for parameter in parameters {
        if let Some(last_modified) = parameter.last_modified_date() {
            let last_modified_chrono = DateTime::from_timestamp(last_modified.secs(), 0)
                .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap());

            if last_modified_chrono < threshold {
                if let Some(name) = parameter.name() {
                    parameters_to_delete.push(name.to_string());
                }
            }
        }
    }

    parameters_to_delete
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_ssm::types::ParameterMetadata;
    use aws_smithy_types::DateTime as AwsDateTime;
    use chrono::{DateTime, Utc};

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

    #[test]
    fn test_filter_old_parameters_empty_list() {
        let parameters = vec![];
        let time_provider = MockTimeProvider::new(Utc::now());

        let result = filter_old_parameters(&parameters, &time_provider, 1);

        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_filter_old_parameters_recent_parameter() {
        let now = Utc::now();
        let recent_time = now - Duration::hours(1); // 1 hour ago

        let parameter = ParameterMetadata::builder()
            .name("recent-param")
            .last_modified_date(AwsDateTime::from_secs(recent_time.timestamp()))
            .build();

        let time_provider = MockTimeProvider::new(now);
        let parameters = vec![parameter];

        let result = filter_old_parameters(&parameters, &time_provider, 1);

        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_filter_old_parameters_old_parameter() {
        let now = Utc::now();
        let old_time = now - Duration::days(5); // 5 days ago

        let parameter = ParameterMetadata::builder()
            .name("old-param")
            .last_modified_date(AwsDateTime::from_secs(old_time.timestamp()))
            .build();

        let time_provider = MockTimeProvider::new(now);
        let parameters = vec![parameter];

        let result = filter_old_parameters(&parameters, &time_provider, 1);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "old-param");
    }

    #[test]
    fn test_filter_old_parameters_mixed_ages() {
        let now = Utc::now();
        let old_time = now - Duration::days(5);
        let recent_time = now - Duration::hours(1);

        let old_parameter = ParameterMetadata::builder()
            .name("old-param")
            .last_modified_date(AwsDateTime::from_secs(old_time.timestamp()))
            .build();

        let recent_parameter = ParameterMetadata::builder()
            .name("recent-param")
            .last_modified_date(AwsDateTime::from_secs(recent_time.timestamp()))
            .build();

        let time_provider = MockTimeProvider::new(now);
        let parameters = vec![old_parameter, recent_parameter];

        let result = filter_old_parameters(&parameters, &time_provider, 2);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "old-param");
    }

    #[test]
    fn test_filter_old_parameters_no_timestamp() {
        let parameter = ParameterMetadata::builder()
            .name("no-timestamp-param")
            .build();

        let time_provider = MockTimeProvider::new(Utc::now());
        let parameters = vec![parameter];

        let result = filter_old_parameters(&parameters, &time_provider, 1);

        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_filter_old_parameters_no_name() {
        let now = Utc::now();
        let old_time = now - Duration::days(5);

        let parameter = ParameterMetadata::builder()
            .last_modified_date(AwsDateTime::from_secs(old_time.timestamp()))
            .build();

        let time_provider = MockTimeProvider::new(now);
        let parameters = vec![parameter];

        let result = filter_old_parameters(&parameters, &time_provider, 1);

        assert_eq!(result.len(), 0);
    }
}
