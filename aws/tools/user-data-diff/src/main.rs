use clap::Parser;
use user_data_diff::client::AwsEc2Client;
use user_data_diff::{diff_launch_template_user_data, DiffConfig};

#[derive(Parser, Debug)]
#[command(name = "user-data-diff")]
#[command(about = "Compare user_data between AWS Launch Template versions")]
struct Args {
    #[clap(short, long, default_value = "us-east-1")]
    region: String,

    #[clap(long, group = "template")]
    template_name: Option<String>,

    #[clap(long, group = "template")]
    template_id: Option<String>,

    #[clap(long)]
    from_version: Option<String>,

    #[clap(long)]
    to_version: Option<String>,

    #[clap(long, default_value_t = false)]
    no_color: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    if args.template_name.is_none() && args.template_id.is_none() {
        eprintln!("Error: Must specify either --template-name or --template-id");
        std::process::exit(1);
    }

    let client = match AwsEc2Client::new(&args.region).await {
        Ok(client) => client,
        Err(e) => {
            eprintln!("Failed to create AWS EC2 client: {}", e);
            std::process::exit(1);
        }
    };

    let config = DiffConfig {
        region: args.region,
        template_name: args.template_name,
        template_id: args.template_id,
        from_version: args.from_version,
        to_version: args.to_version,
        use_color: !args.no_color,
    };

    if let Err(e) = diff_launch_template_user_data(&client, &config).await {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }

    Ok(())
}
