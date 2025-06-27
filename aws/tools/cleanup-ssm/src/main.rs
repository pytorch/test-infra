use clap::Parser;
use cleanup_ssm::client::AwsSsmClient;
use cleanup_ssm::{CleanupConfig, SystemTimeProvider, cleanup_ssm_parameters};

#[derive(Parser, Debug)]
struct Args {
    // region to run the cleanup in
    #[clap(short, long, default_value = "us-east-1")]
    region: String,
    // if true, will not delete any parameters
    #[clap(long, default_value_t = true, action = clap::ArgAction::Set)]
    dry_run: bool,
    // time duration older than which to delete parameters (e.g., "1d", "2h", "30m")
    #[clap(long, default_value = "1d")]
    older_than: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<aws_sdk_ssm::Error>> {
    let args = Args::parse();

    // Parse the human-readable time string into a Duration
    let duration = humantime::parse_duration(&args.older_than).unwrap_or_else(|e| {
        eprintln!("Error: Invalid time format '{}': {}", args.older_than, e);
        eprintln!("Supported formats: 30m, 2h, 1d, 2w (minutes, hours, days, weeks)");
        eprintln!("Note: Decimal values like '1.5d' are not supported. Use '36h' instead.");
        std::process::exit(1);
    });

    // Get duration in seconds
    let older_than_seconds = duration.as_secs_f64();

    let client = AwsSsmClient::new(&args.region).await?;
    let time_provider = SystemTimeProvider;
    let config = CleanupConfig {
        region: args.region,
        dry_run: args.dry_run,
        older_than_seconds,
    };

    let result = cleanup_ssm_parameters(&client, &time_provider, &config).await?;

    if !config.dry_run {
        println!(
            "Cleanup completed: {} parameters processed, {} deleted, {} failed",
            result.parameters_found, result.parameters_deleted, result.parameters_failed
        );
    }

    Ok(())
}
