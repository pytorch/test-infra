use crate::Ec2Client;
use std::time::Duration;
use tokio::time::sleep;

const BATCH_SIZE: usize = 10;
const RETRY_ATTEMPTS: usize = 3;
const BASE_DELAY_MS: u64 = 1000;

pub async fn terminate_instances_in_batches<C: Ec2Client>(
    client: &C,
    instance_ids: Vec<String>,
) -> Result<usize, aws_sdk_ec2::Error> {
    if instance_ids.is_empty() {
        return Ok(0);
    }

    let mut total_terminated = 0;
    let batches: Vec<Vec<String>> = instance_ids
        .chunks(BATCH_SIZE)
        .map(|chunk| chunk.to_vec())
        .collect();

    println!("Processing {} instances in {} batches", instance_ids.len(), batches.len());

    for (i, batch) in batches.iter().enumerate() {
        let batch_num = i + 1;
        println!("Processing batch {}/{}", batch_num, batches.len());

        let mut retry_count = 0;
        let mut success = false;

        while retry_count < RETRY_ATTEMPTS && !success {
            match client.terminate_instances(batch.clone()).await {
                Ok(terminated_count) => {
                    total_terminated += terminated_count;
                    success = true;
                    println!("Batch {} completed successfully", batch_num);
                }
                Err(e) => {
                    retry_count += 1;
                    if retry_count < RETRY_ATTEMPTS {
                        let delay = Duration::from_millis(BASE_DELAY_MS * (1 << retry_count));
                        println!(
                            "Batch {} failed (attempt {}), retrying in {:?}...",
                            batch_num, retry_count, delay
                        );
                        sleep(delay).await;
                    } else {
                        println!("Batch {} failed after {} attempts: {}", batch_num, RETRY_ATTEMPTS, e);
                        return Err(e);
                    }
                }
            }
        }

        // Add a small delay between successful batches to avoid rate limiting
        if batch_num < batches.len() {
            sleep(Duration::from_millis(500)).await;
        }
    }

    Ok(total_terminated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MockEc2Client;
    use mockall::predicate::*;

    #[tokio::test]
    async fn test_terminate_instances_empty_list() {
        let mock_client = MockEc2Client::new();
        let instance_ids = vec![];

        let result = terminate_instances_in_batches(&mock_client, instance_ids)
            .await
            .unwrap();

        assert_eq!(result, 0);
    }

    #[tokio::test]
    async fn test_terminate_instances_single_batch() {
        let mut mock_client = MockEc2Client::new();
        let instance_ids = vec!["i-123".to_string(), "i-456".to_string()];

        mock_client
            .expect_terminate_instances()
            .with(eq(vec!["i-123".to_string(), "i-456".to_string()]))
            .times(1)
            .returning(|instances| Ok(instances.len()));

        let result = terminate_instances_in_batches(&mock_client, instance_ids)
            .await
            .unwrap();

        assert_eq!(result, 2);
    }

    #[tokio::test]
    async fn test_terminate_instances_multiple_batches() {
        let mut mock_client = MockEc2Client::new();
        let instance_ids: Vec<String> = (1..=25).map(|i| format!("i-{:03}", i)).collect();

        // First batch (10 instances)
        mock_client
            .expect_terminate_instances()
            .with(eq((1..=10)
                .map(|i| format!("i-{:03}", i))
                .collect::<Vec<_>>()))
            .times(1)
            .returning(|instances| Ok(instances.len()));

        // Second batch (10 instances)
        mock_client
            .expect_terminate_instances()
            .with(eq((11..=20)
                .map(|i| format!("i-{:03}", i))
                .collect::<Vec<_>>()))
            .times(1)
            .returning(|instances| Ok(instances.len()));

        // Third batch (5 instances)
        mock_client
            .expect_terminate_instances()
            .with(eq((21..=25)
                .map(|i| format!("i-{:03}", i))
                .collect::<Vec<_>>()))
            .times(1)
            .returning(|instances| Ok(instances.len()));

        let result = terminate_instances_in_batches(&mock_client, instance_ids)
            .await
            .unwrap();

        assert_eq!(result, 25);
    }

    #[tokio::test]
    async fn test_terminate_instances_with_retry_success() {
        let mut mock_client = MockEc2Client::new();
        let instance_ids = vec!["i-123".to_string()];

        mock_client
            .expect_terminate_instances()
            .times(2)
            .returning(|_| {
                // First call fails, second succeeds
                static mut CALL_COUNT: usize = 0;
                unsafe {
                    CALL_COUNT += 1;
                    if CALL_COUNT == 1 {
                        use aws_sdk_ec2::{error::SdkError, operation::terminate_instances::TerminateInstancesError};
                        Err(SdkError::service_error(
                            TerminateInstancesError::unhandled("Rate exceeded"),
                            http::Response::builder().status(500).body("").unwrap()
                        ).into())
                    } else {
                        Ok(1)
                    }
                }
            });

        let result = terminate_instances_in_batches(&mock_client, instance_ids)
            .await
            .unwrap();

        assert_eq!(result, 1);
    }

    #[tokio::test]
    async fn test_terminate_instances_max_retries_exceeded() {
        let mut mock_client = MockEc2Client::new();
        let instance_ids = vec!["i-123".to_string()];

        mock_client
            .expect_terminate_instances()
            .times(RETRY_ATTEMPTS)
            .returning(|_| {
                use aws_sdk_ec2::{error::SdkError, operation::terminate_instances::TerminateInstancesError};
                Err(SdkError::service_error(
                    TerminateInstancesError::unhandled("Rate exceeded"),
                    http::Response::builder().status(500).body("").unwrap()
                ).into())
            });

        let result = terminate_instances_in_batches(&mock_client, instance_ids).await;

        assert!(result.is_err());
    }
} 