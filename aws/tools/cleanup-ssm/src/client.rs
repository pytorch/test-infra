use crate::SsmClient;
use aws_config::BehaviorVersion;
use aws_config::Region;
use aws_sdk_ssm::error::ProvideErrorMetadata;
use aws_sdk_ssm::types::ParameterMetadata;
use aws_sdk_ssm::{Client, Error};
use indicatif::{ProgressBar, ProgressStyle};
use tokio::time::{Duration, sleep};

pub struct AwsSsmClient {
    client: Client,
}

impl AwsSsmClient {
    pub async fn new(region: &str) -> Result<Self, Error> {
        let config = aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(region.to_string()))
            .load()
            .await;
        let client = Client::new(&config);

        Ok(Self { client })
    }
}

impl SsmClient for AwsSsmClient {
    async fn describe_parameters(&self) -> Result<Vec<ParameterMetadata>, Error> {
        let mut all_parameters = Vec::new();
        let mut next_token: Option<String> = None;

        // Create a progress bar for fetching parameters
        let pb = ProgressBar::new_spinner();
        pb.set_style(
            ProgressStyle::default_spinner()
                .template("{spinner:.green} Fetching SSM parameters... [{elapsed_precise}] {msg}")
                .unwrap(),
        );
        pb.set_message("Starting...");

        loop {
            let mut request = self.client.describe_parameters().max_results(50);

            if let Some(token) = next_token {
                request = request.next_token(token);
            }

            match request.send().await {
                Ok(resp) => {
                    let new_params = resp.parameters().to_vec();
                    all_parameters.extend(new_params);
                    pb.set_message(format!("Found {} parameters", all_parameters.len()));
                    next_token = resp.next_token().map(|s| s.to_string());

                    if next_token.is_none() {
                        break;
                    }

                    // Add delay to avoid rate limiting, 250ms seems to be the sweet spot
                    sleep(Duration::from_millis(250)).await;
                }
                Err(e) => {
                    // Check if it's a throttling error
                    let metadata = e.meta();
                    if metadata.code() == Some("ThrottlingException") {
                        pb.finish_with_message(format!(
                            "Rate limit reached. Collected {} parameters",
                            all_parameters.len()
                        ));
                        return Ok(all_parameters);
                    }
                    // For other errors, return them
                    pb.abandon_with_message("Error fetching parameters");
                    return Err(e.into());
                }
            }
        }

        pb.finish_with_message(format!("✓ Collected {} parameters", all_parameters.len()));
        Ok(all_parameters)
    }

    async fn delete_parameters(
        &self,
        names: Vec<String>,
    ) -> Result<(Vec<String>, Vec<String>), Error> {
        let delete_resp = self
            .client
            .delete_parameters()
            .set_names(Some(names))
            .send()
            .await?;

        let deleted = delete_resp.deleted_parameters().to_vec();
        let invalid = delete_resp.invalid_parameters().to_vec();

        Ok((deleted, invalid))
    }
}
