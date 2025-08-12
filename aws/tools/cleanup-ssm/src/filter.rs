use crate::TimeProvider;
use aws_sdk_ssm::types::ParameterMetadata;
use chrono::{DateTime, Duration};
use regex::Regex;

pub fn filter_old_parameters<T: TimeProvider>(
    parameters: &[ParameterMetadata],
    time_provider: &T,
    older_than_seconds: f64,
    pattern: &str,
) -> Result<Vec<String>, regex::Error> {
    let threshold = time_provider.now() - Duration::seconds(older_than_seconds as i64);
    let regex = Regex::new(pattern)?;
    let mut parameters_to_delete = Vec::new();

    for parameter in parameters {
        if let Some(last_modified) = parameter.last_modified_date() {
            let last_modified_time = DateTime::from_timestamp(last_modified.secs(), 0)
                .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap());

            if last_modified_time < threshold {
                if let Some(name) = parameter.name() {
                    if regex.is_match(name) {
                        parameters_to_delete.push(name.to_string());
                    }
                }
            }
        }
    }

    Ok(parameters_to_delete)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ONE_DAY_IN_SECONDS;
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

        let result =
            filter_old_parameters(&parameters, &time_provider, ONE_DAY_IN_SECONDS, ".*").unwrap();

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

        let result =
            filter_old_parameters(&parameters, &time_provider, ONE_DAY_IN_SECONDS, ".*").unwrap();

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

        let result =
            filter_old_parameters(&parameters, &time_provider, ONE_DAY_IN_SECONDS, ".*").unwrap();

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

        let result =
            filter_old_parameters(&parameters, &time_provider, ONE_DAY_IN_SECONDS * 2.0, ".*")
                .unwrap();

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

        let result =
            filter_old_parameters(&parameters, &time_provider, ONE_DAY_IN_SECONDS, ".*").unwrap();

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

        let result =
            filter_old_parameters(&parameters, &time_provider, ONE_DAY_IN_SECONDS, ".*").unwrap();

        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_filter_old_parameters_with_pattern_match() {
        let now = Utc::now();
        let old_time = now - Duration::days(5);

        let matching_parameter = ParameterMetadata::builder()
            .name("gh-ci-i-test-param")
            .last_modified_date(AwsDateTime::from_secs(old_time.timestamp()))
            .build();

        let non_matching_parameter = ParameterMetadata::builder()
            .name("other-param")
            .last_modified_date(AwsDateTime::from_secs(old_time.timestamp()))
            .build();

        let time_provider = MockTimeProvider::new(now);
        let parameters = vec![matching_parameter, non_matching_parameter];

        let result = filter_old_parameters(
            &parameters,
            &time_provider,
            ONE_DAY_IN_SECONDS,
            "gh-ci-i-.*",
        )
        .unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "gh-ci-i-test-param");
    }

    #[test]
    fn test_filter_old_parameters_with_pattern_no_match() {
        let now = Utc::now();
        let old_time = now - Duration::days(5);

        let parameter = ParameterMetadata::builder()
            .name("other-param")
            .last_modified_date(AwsDateTime::from_secs(old_time.timestamp()))
            .build();

        let time_provider = MockTimeProvider::new(now);
        let parameters = vec![parameter];

        let result = filter_old_parameters(
            &parameters,
            &time_provider,
            ONE_DAY_IN_SECONDS,
            "gh-ci-i-.*",
        )
        .unwrap();

        assert_eq!(result.len(), 0);
    }
}
