use crate::SsmClient;
use aws_config::BehaviorVersion;
use aws_config::Region;
use aws_sdk_ssm::types::ParameterMetadata;
use aws_sdk_ssm::{Client, Error};

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
        let resp = self.client.describe_parameters().send().await?;
        Ok(resp.parameters().to_vec())
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
