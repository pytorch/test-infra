use clap::Parser;
use cleanup_runners::{
    cleanup_offline_runners, ec2_client::AwsEc2Client, github_client::GitHubApiClient,
    RunnerCleanupConfig, RunnerCleanupError,
};
use cleanup_common::CleanupConfig;
use std::env;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// GitHub organization name (e.g., "pytorch")
    organization: String,

    /// AWS region to search for EC2 instances
    #[arg(short, long, default_value = "us-east-1")]
    region: String,

    /// If true, will not terminate any instances, just show what would be terminated
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    dry_run: bool,

    /// EC2 instance name pattern to filter for
    #[arg(long, default_value = "gh-ci-action-runner")]
    runner_name: String,

    /// GitHub token (can also be set via GITHUB_TOKEN environment variable)
    #[arg(long)]
    github_token: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), RunnerCleanupError> {
    let args = Args::parse();

    // Get GitHub token from CLI argument or environment variable
    let github_token = args
        .github_token
        .or_else(|| env::var("GITHUB_TOKEN").ok())
        .ok_or_else(|| RunnerCleanupError::GitHub(
            "GitHub token must be provided via --github-token argument or GITHUB_TOKEN environment variable".into()
        ))?;

    let config = RunnerCleanupConfig {
        base: CleanupConfig {
            region: args.region.clone(),
            dry_run: args.dry_run,
        },
        organization: args.organization,
        runner_name: args.runner_name,
        github_token: github_token.clone(),
    };

    // Initialize clients
    let github_client = GitHubApiClient::new(github_token)
        .map_err(RunnerCleanupError::GitHub)?;
    let ec2_client = AwsEc2Client::new(&args.region).await
        .map_err(RunnerCleanupError::Ec2)?;

    // Perform cleanup
    let result = cleanup_offline_runners(&github_client, &ec2_client, &config).await?;

    // Print summary
    println!("\n=== Cleanup Summary ===");
    println!("Resources found: {}", result.items_found);
    println!("Resources processed: {}", result.items_processed);
    println!("Resources failed: {}", result.items_failed);

    if config.base.dry_run {
        println!("Dry run mode - no instances were terminated");
        if result.items_found > 0 {
            println!(
                "Run with '--dry-run false' to actually terminate {} orphaned instances",
                result.items_found
            );
        }
    } else {
        println!("Instances terminated: {}", result.items_processed);
        if result.items_processed > 0 {
            println!("✅ Successfully cleaned up {} orphaned instances", result.items_processed);
        }
    }

    Ok(())
}
