use crate::DiffError;
use aws_config::meta::region::RegionProviderChain;
use aws_config::Region;
use aws_sdk_ec2::{
    types::{LaunchTemplate, LaunchTemplateVersion},
    Client,
};

#[async_trait::async_trait]
pub trait Ec2Client {
    async fn get_launch_template_by_name(&self, name: &str) -> Result<LaunchTemplate, DiffError>;
    async fn list_launch_template_versions(
        &self,
        template_id: &str,
    ) -> Result<Vec<LaunchTemplateVersion>, DiffError>;
    async fn get_launch_template_version(
        &self,
        template_id: &str,
        version: &str,
    ) -> Result<LaunchTemplateVersion, DiffError>;
}

pub struct AwsEc2Client {
    client: Client,
}

impl AwsEc2Client {
    pub async fn new(region: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let region_provider =
            RegionProviderChain::default_provider().or_else(Region::new(region.to_string()));
        let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(region_provider)
            .load()
            .await;
        let client = Client::new(&config);

        Ok(Self { client })
    }
}

#[async_trait::async_trait]
impl Ec2Client for AwsEc2Client {
    async fn get_launch_template_by_name(&self, name: &str) -> Result<LaunchTemplate, DiffError> {
        let response = self
            .client
            .describe_launch_templates()
            .launch_template_names(name)
            .send()
            .await
            .map_err(|e| {
                DiffError::AwsError(format!("Failed to describe launch template: {}", e))
            })?;

        response
            .launch_templates
            .unwrap_or_default()
            .into_iter()
            .next()
            .ok_or_else(|| DiffError::NotFound(format!("Launch template not found: {}", name)))
    }

    async fn list_launch_template_versions(
        &self,
        template_id: &str,
    ) -> Result<Vec<LaunchTemplateVersion>, DiffError> {
        let response = self
            .client
            .describe_launch_template_versions()
            .launch_template_id(template_id)
            .send()
            .await
            .map_err(|e| {
                DiffError::AwsError(format!("Failed to list launch template versions: {}", e))
            })?;

        Ok(response.launch_template_versions.unwrap_or_default())
    }

    async fn get_launch_template_version(
        &self,
        template_id: &str,
        version: &str,
    ) -> Result<LaunchTemplateVersion, DiffError> {
        let response = self
            .client
            .describe_launch_template_versions()
            .launch_template_id(template_id)
            .versions(version)
            .send()
            .await
            .map_err(|e| {
                DiffError::AwsError(format!("Failed to get launch template version: {}", e))
            })?;

        response
            .launch_template_versions
            .unwrap_or_default()
            .into_iter()
            .next()
            .ok_or_else(|| {
                DiffError::NotFound(format!("Launch template version not found: {}", version))
            })
    }
}
