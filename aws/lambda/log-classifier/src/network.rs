//! Various utilities for interacting with the external world.
use anyhow::{Context, Result};
use aws_sdk_dynamodb as dynamodb;
use aws_sdk_s3 as s3;
use aws_sdk_s3::types::ByteStream;
use bytes::buf::Buf;
use bytes::Bytes;
use dynamodb::model::{AttributeAction, AttributeValueUpdate};
use flate2::read::GzDecoder;
use serde_dynamo::aws_sdk_dynamodb_0_18::to_attribute_value;
use std::io::Read;
use tracing::info;

use crate::rule_match::SerializedMatch;

static BUCKET_NAME: &str = "ossci-raw-job-status";

/// Creates an S3 client instance preconfigured with the right credentials/region.
pub async fn get_s3_client() -> s3::Client {
    let config = aws_config::from_env().region("us-east-1").load().await;
    s3::Client::new(&config)
}

pub async fn get_dynamo_client() -> dynamodb::Client {
    let config = aws_config::load_from_env().await;
    dynamodb::Client::new(&config)
}

/// Download a log for `job_id` from S3.
pub async fn download_log(client: &s3::Client, job_id: usize) -> Result<String> {
    let resp = client
        .get_object()
        .bucket(BUCKET_NAME)
        .key(format!("log/{}", job_id))
        .send()
        .await?;

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
    job_id: usize,
    best_match: &SerializedMatch,
) -> Result<()> {
    let update = AttributeValueUpdate::builder()
        .action(AttributeAction::Put)
        .value(to_attribute_value(best_match)?)
        .build();
    client
        .update_item()
        .table_name("torchci-workflow-job")
        .key(
            "dynamoKey",
            to_attribute_value(format!("pytorch/pytorch/{}", job_id))?,
        )
        .attribute_updates("torchci_classification", update)
        .send()
        .await?;
    info!("SUCCESS upload classification to dynamo for job {}", job_id);
    Ok(())
}
