//! Various utilities for interacting with the external world.
use anyhow::{Context, Result};
use aws_config::BehaviorVersion;
use aws_sdk_dynamodb as dynamodb;
use aws_sdk_s3 as s3;
use aws_sdk_s3::primitives::ByteStream;
use bytes::buf::Buf;
use bytes::Bytes;
use dynamodb::types::{AttributeAction, AttributeValueUpdate};
use flate2::read::GzDecoder;
use serde_dynamo::aws_sdk_dynamodb_1::to_attribute_value;
use std::io::Read;
use tracing::info;

use crate::rule_match::SerializedMatch;

static BUCKET_NAME: &str = "ossci-raw-job-status";

/// Creates an S3 client instance preconfigured with the right credentials/region.
pub async fn get_s3_client() -> s3::Client {
    let config = aws_config::defaults(BehaviorVersion::v2024_03_28())
        .region("us-east-1")
        .load()
        .await;
    s3::Client::new(&config)
}

pub async fn get_dynamo_client() -> dynamodb::Client {
    let config = aws_config::load_defaults(BehaviorVersion::v2024_03_28()).await;
    dynamodb::Client::new(&config)
}

/// Download a log for `job_id` from S3.
pub async fn download_log(
    client: &s3::Client,
    repo: &str,
    job_id: usize,
    is_temp_log: bool,
) -> Result<String> {
    let mut key = match repo {
        "pytorch/pytorch" => format!("log/{}", job_id),
        _ => format!("log/{}/{}", repo, job_id),
    };
    let mut bucket = BUCKET_NAME;
    if is_temp_log {
        key = format!("temp_logs/{}", job_id);
        bucket = "gha-artifacts";
    }
    let resp = client.get_object().bucket(bucket).key(key).send().await?;

    let data = resp.body.collect().await?;
    let mut decoder = GzDecoder::new(data.reader());
    let mut raw_log = String::new();
    decoder
        .read_to_string(&mut raw_log)
        .context("failed to decompress log")?;
    Ok(raw_log)
}

/// Upload a classification for `job_id` to S3. `body` should be a serialized
/// instance of `SerializedMatch`.
pub async fn upload_classification_s3(
    client: &s3::Client,
    job_id: usize,
    body: String,
) -> Result<()> {
    client
        .put_object()
        .bucket(BUCKET_NAME)
        .key(format!("classification/{job_id}"))
        .content_type("application/json")
        .body(ByteStream::from(Bytes::from(body)))
        .send()
        .await?;
    info!("SUCCESS upload classification to s3 for job {}", job_id);
    Ok(())
}

/// Mutates the DynamoDB object for `job_id` to include the `SerializedMatch`.
pub async fn upload_classification_dynamo(
    client: &dynamodb::Client,
    repo: &str,
    job_id: usize,
    best_match: &SerializedMatch,
    is_temp_log: bool,
) -> Result<()> {
    let update = AttributeValueUpdate::builder()
        .action(AttributeAction::Put)
        .value(to_attribute_value(best_match)?)
        .build();
    let attribute_name = if is_temp_log {
        "torchci_classification_temp"
    } else {
        "torchci_classification"
    };
    client
        .update_item()
        .table_name("torchci-workflow-job")
        .key(
            "dynamoKey",
            to_attribute_value(format!("{}/{}", repo, job_id))?,
        )
        .attribute_updates(attribute_name, update)
        .send()
        .await?;
    info!("SUCCESS upload classification to dynamo for job {}", job_id);
    Ok(())
}
