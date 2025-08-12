use crate::SsmClient;
use indicatif::{ProgressBar, ProgressStyle};

const BATCH_SIZE: usize = 10;

pub async fn delete_parameters_in_batches<C: SsmClient>(
    client: &C,
    parameters_to_delete: Vec<String>,
) -> Result<(usize, usize), aws_sdk_ssm::Error> {
    let mut total_deleted = 0;
    let mut total_failed = 0;

    let total_params = parameters_to_delete.len();
    let total_batches = (total_params + BATCH_SIZE - 1).div_ceil(BATCH_SIZE);

    // Create progress bar for deletion
    let pb = ProgressBar::new(total_batches as u64);
    pb.set_style(
        ProgressStyle::default_bar()
            .template("{spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {pos}/{len} batches ({msg})")
            .unwrap()
            .progress_chars("#>-")
    );
    pb.set_message("Deleting parameters...");

    for (batch_idx, chunk) in parameters_to_delete.chunks(BATCH_SIZE).enumerate() {
        let (deleted, failed) = client.delete_parameters(chunk.to_vec()).await?;

        total_deleted += deleted.len();
        total_failed += failed.len();

        pb.set_message(format!(
            "Batch {}/{} - Deleted: {}, Failed: {}",
            batch_idx + 1,
            total_batches,
            total_deleted,
            total_failed
        ));
        pb.inc(1);
    }

    pb.finish_with_message(format!(
        "✓ Completed! Total deleted: {}, Total failed: {}",
        total_deleted, total_failed
    ));

    Ok((total_deleted, total_failed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MockSsmClient;
    use mockall::predicate::*;

    #[tokio::test]
    async fn test_delete_parameters_empty_list() {
        let mock_client = MockSsmClient::new();
        let parameters = vec![];

        let result = delete_parameters_in_batches(&mock_client, parameters)
            .await
            .unwrap();

        assert_eq!(result.0, 0); // deleted
        assert_eq!(result.1, 0); // failed
    }

    #[tokio::test]
    async fn test_delete_parameters_single_batch() {
        let mut mock_client = MockSsmClient::new();
        let parameters = vec!["param1".to_string(), "param2".to_string()];

        mock_client
            .expect_delete_parameters()
            .with(eq(vec!["param1".to_string(), "param2".to_string()]))
            .times(1)
            .returning(|params| Ok((params, vec![])));

        let result = delete_parameters_in_batches(&mock_client, parameters)
            .await
            .unwrap();

        assert_eq!(result.0, 2); // deleted
        assert_eq!(result.1, 0); // failed
    }

    #[tokio::test]
    async fn test_delete_parameters_multiple_batches() {
        let mut mock_client = MockSsmClient::new();
        let parameters: Vec<String> = (1..=25).map(|i| format!("param{}", i)).collect();

        // First batch (10 params)
        mock_client
            .expect_delete_parameters()
            .with(eq((1..=10)
                .map(|i| format!("param{}", i))
                .collect::<Vec<_>>()))
            .times(1)
            .returning(|params| Ok((params, vec![])));

        // Second batch (10 params)
        mock_client
            .expect_delete_parameters()
            .with(eq((11..=20)
                .map(|i| format!("param{}", i))
                .collect::<Vec<_>>()))
            .times(1)
            .returning(|params| Ok((params, vec![])));

        // Third batch (5 params)
        mock_client
            .expect_delete_parameters()
            .with(eq((21..=25)
                .map(|i| format!("param{}", i))
                .collect::<Vec<_>>()))
            .times(1)
            .returning(|params| Ok((params, vec![])));

        let result = delete_parameters_in_batches(&mock_client, parameters)
            .await
            .unwrap();

        assert_eq!(result.0, 25); // deleted
        assert_eq!(result.1, 0); // failed
    }

    #[tokio::test]
    async fn test_delete_parameters_with_failures() {
        let mut mock_client = MockSsmClient::new();
        let parameters = vec![
            "param1".to_string(),
            "param2".to_string(),
            "param3".to_string(),
        ];

        mock_client
            .expect_delete_parameters()
            .times(1)
            .returning(|_| {
                Ok((
                    vec!["param1".to_string()],
                    vec!["param2".to_string(), "param3".to_string()],
                ))
            });

        let result = delete_parameters_in_batches(&mock_client, parameters)
            .await
            .unwrap();

        assert_eq!(result.0, 1); // deleted
        assert_eq!(result.1, 2); // failed
    }

    #[tokio::test]
    async fn test_delete_parameters_api_error() {
        let mut mock_client = MockSsmClient::new();
        let parameters = vec!["param1".to_string()];

        mock_client
            .expect_delete_parameters()
            .times(1)
            .returning(|_| {
                Err(aws_sdk_ssm::Error::ThrottlingException(
                    aws_sdk_ssm::types::error::ThrottlingException::builder()
                        .message("Rate exceeded")
                        .build()
                        .unwrap(),
                ))
            });

        let result = delete_parameters_in_batches(&mock_client, parameters).await;

        assert!(result.is_err());
    }
}
