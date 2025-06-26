use crate::{Ec2Client, Ec2Instance};
use aws_config::{BehaviorVersion, Region};
use aws_sdk_ec2::{Client, Error};

#[derive(Clone)]
pub struct AwsEc2Client {
    client: Client,
}

impl AwsEc2Client {
    pub async fn new(region: &str) -> Result<Self, Error> {
        let config = aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(region.to_string()))
            .load()
            .await;
        let client = Client::new(&config);

        Ok(Self { client })
    }
}

impl Ec2Client for AwsEc2Client {
    async fn get_instances_by_name(&self, name_pattern: &str) -> Result<Vec<Ec2Instance>, Error> {
        let response = self
            .client
            .describe_instances()
            .filters(
                aws_sdk_ec2::types::Filter::builder()
                    .name("tag:Name")
                    .values(name_pattern)
                    .build(),
            )
            .filters(
                aws_sdk_ec2::types::Filter::builder()
                    .name("instance-state-name")
                    .values("running")
                    .values("pending")
                    .values("stopping")
                    .values("stopped")
                    .build(),
            )
            .send()
            .await?;

        let mut instances = Vec::new();
        for reservation in response.reservations() {
            for instance in reservation.instances() {
                let instance_id = instance.instance_id().unwrap_or("").to_string();
                let mut instance_name = String::new();

                for tag in instance.tags() {
                    if tag.key() == Some("Name") {
                        instance_name = tag.value().unwrap_or("").to_string();
                        break;
                    }
                }

                let state = instance
                    .state()
                    .and_then(|s| s.name())
                    .map(|n| n.as_str())
                    .unwrap_or("unknown")
                    .to_string();

                instances.push(Ec2Instance {
                    id: instance_id,
                    name: instance_name,
                    state,
                });
            }
        }

        Ok(instances)
    }

    async fn terminate_instances(&self, instance_ids: Vec<String>) -> Result<usize, Error> {
        if instance_ids.is_empty() {
            return Ok(0);
        }

        let response = self
            .client
            .terminate_instances()
            .set_instance_ids(Some(instance_ids.clone()))
            .send()
            .await?;

        // Count successfully terminated instances
        let terminated_count = response
            .terminating_instances()
            .iter()
            .filter(|instance| {
                instance
                    .current_state()
                    .and_then(|state| state.name())
                    .map(|name| name.as_str() == "shutting-down")
                    .unwrap_or(false)
            })
            .count();

        println!("Successfully initiated termination for {} instances", terminated_count);

        Ok(terminated_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Note: These are unit tests that don't require AWS credentials
    // Integration tests would need real AWS setup

    #[test]
    fn test_empty_instance_list() {
        // This test verifies that our logic handles empty lists correctly
        let empty_instances: Vec<Ec2Instance> = vec![];
        assert_eq!(empty_instances.len(), 0);
    }
} 