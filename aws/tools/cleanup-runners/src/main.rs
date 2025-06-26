use clap::Parser;
use clear_offline_runners::{
    cleanup_offline_runners, ec2_client::AwsEc2Client, github_client::GitHubApiClient,
    CleanupConfig,
};
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
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = Args::parse();

    // Get GitHub token from CLI argument or environment variable
    let github_token = args
        .github_token
        .or_else(|| env::var("GITHUB_TOKEN").ok())
        .ok_or("GitHub token must be provided via --github-token argument or GITHUB_TOKEN environment variable")?;

    let config = CleanupConfig {
        organization: args.organization,
        region: args.region.clone(),
        dry_run: args.dry_run,
        runner_name: args.runner_name,
        github_token: github_token.clone(),
    };

    // Initialize clients
    let github_client = GitHubApiClient::new(github_token)?;
    let ec2_client = AwsEc2Client::new(&args.region).await?;

    // Perform cleanup
    let result = cleanup_offline_runners(&github_client, &ec2_client, &config).await?;

    // Print summary
    println!("\n=== Cleanup Summary ===");
    println!("GitHub runners found: {}", result.github_runners_found);
    println!("EC2 instances found: {}", result.ec2_instances_found);
    println!("Orphaned instances identified: {}", result.orphaned_instances);

    if config.dry_run {
        println!("Dry run mode - no instances were terminated");
        if result.orphaned_instances > 0 {
            println!(
                "Run with '--dry-run false' to actually terminate {} orphaned instances",
                result.orphaned_instances
            );
        }
    } else {
        println!("Instances terminated: {}", result.instances_terminated);
        if result.instances_terminated > 0 {
            println!("✅ Successfully cleaned up {} orphaned instances", result.instances_terminated);
        }
    }

    Ok(())
} 