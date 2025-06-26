use clap::Parser;
use cleanup_ssm::client::AwsSsmClient;
use cleanup_ssm::{cleanup_ssm_parameters, SsmCleanupConfig};
use cleanup_common::{CleanupConfig, time::SystemTimeProvider};

#[derive(Parser, Debug)]
struct Args {
    // region to run the cleanup in
    #[clap(short, long, default_value = "us-east-1")]
    region: String,
    // if true, will not delete any parameters
    #[clap(long, default_value_t = true, action = clap::ArgAction::Set)]
    dry_run: bool,
    // number of days older than the parameter to delete
    #[clap(long, default_value = "1")]
    older_than: u16,
}

#[tokio::main]
async fn main() -> Result<(), Box<aws_sdk_ssm::Error>> {
    let args = Args::parse();

    let client = AwsSsmClient::new(&args.region).await?;
    let time_provider = SystemTimeProvider;
    let config = SsmCleanupConfig {
        base: CleanupConfig {
            region: args.region,
            dry_run: args.dry_run,
        },
        older_than_days: args.older_than,
    };

    let result = cleanup_ssm_parameters(&client, time_provider, &config).await.map_err(Box::new)?;

    if !config.base.dry_run {
        println!(
            "Cleanup completed: {} parameters processed, {} deleted, {} failed",
            result.items_found, result.items_processed, result.items_failed
        );
    }

    Ok(())
}
