use clap::{Parser, Subcommand};
use colored::*;

mod auth;
mod config;
mod reservations;

use config::Config;

#[derive(Parser)]
#[command(name = "gpu-dev")]
#[command(about = "Fast Rust CLI for PyTorch GPU developer server reservations")]
#[command(version = "0.1.0")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Reserve GPU development server(s)
    Reserve {
        /// Number of GPUs to reserve (1, 2, 4, 8, 16)
        #[arg(short, long, default_value = "1")]
        gpus: u8,
        
        /// Reservation duration in hours (max 24)
        #[arg(short = 'H', long, default_value = "8")]
        hours: u8,
        
        /// Optional name for the reservation
        #[arg(short, long)]
        name: Option<String>,
        
        /// Show what would be reserved without actually reserving
        #[arg(long)]
        dry_run: bool,
    },
    
    /// List GPU reservations
    List {
        /// Filter by user
        #[arg(short, long)]
        user: Option<String>,
        
        /// Filter by status (active, expired, cancelled)
        #[arg(short, long)]
        status: Option<String>,
    },
    
    /// Cancel a GPU reservation
    Cancel {
        /// Reservation ID to cancel
        reservation_id: String,
    },
    
    /// Get SSH connection details for a reservation
    Connect {
        /// Reservation ID to connect to
        reservation_id: String,
    },
    
    /// Show overall GPU cluster status
    Status,
    
    /// Show current configuration
    Config,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    
    // Load configuration
    let config = Config::load().await?;
    
    match cli.command {
        Commands::Reserve { gpus, hours, name, dry_run } => {
            handle_reserve(config, gpus, hours, name, dry_run).await?;
        }
        Commands::List { user, status } => {
            handle_list(config, user, status).await?;
        }
        Commands::Cancel { reservation_id } => {
            handle_cancel(config, reservation_id).await?;
        }
        Commands::Connect { reservation_id } => {
            handle_connect(config, reservation_id).await?;
        }
        Commands::Status => {
            handle_status(config).await?;
        }
        Commands::Config => {
            handle_config(config).await?;
        }
    }
    
    Ok(())
}

async fn handle_reserve(
    config: Config,
    gpus: u8,
    hours: u8,
    name: Option<String>,
    dry_run: bool,
) -> anyhow::Result<()> {
    // Validate parameters
    if ![1, 2, 4, 8, 16].contains(&gpus) {
        eprintln!("{} Invalid GPU count. Must be 1, 2, 4, 8, or 16", "❌".red());
        return Ok(());
    }
    
    if hours > 24 {
        eprintln!("{} Maximum reservation time is 24 hours", "❌".red());
        return Ok(());
    }
    
    // Authenticate user
    let user_info = auth::authenticate_user(&config).await?;
    
    if dry_run {
        println!("{} Would reserve {} GPU(s) for {} hours", "🔍".yellow(), gpus, hours);
        println!("{} User: {}", "🔍".yellow(), user_info.login);
        return Ok(());
    }
    
    // Create reservation
    let reservation_mgr = reservations::ReservationManager::new(config);
    let reservation_id = reservation_mgr
        .create_reservation(&user_info.login, gpus, hours, name)
        .await?;
    
    if let Some(id) = reservation_id {
        println!("{} Reservation created: {}", "✅".green(), id);
        println!("{} Reserved {} GPU(s) for {} hours", "📋".blue(), gpus, hours);
    } else {
        eprintln!("{} Failed to create reservation", "❌".red());
    }
    
    Ok(())
}

async fn handle_list(
    config: Config,
    user: Option<String>,
    status: Option<String>,
) -> anyhow::Result<()> {
    // Authenticate user
    let _user_info = auth::authenticate_user(&config).await?;
    
    let reservation_mgr = reservations::ReservationManager::new(config);
    let reservations = reservation_mgr.list_reservations(user, status).await?;
    
    if reservations.is_empty() {
        println!("{} No reservations found", "📋".yellow());
        return Ok(());
    }
    
    // Print table header
    println!("\n{}", "GPU Reservations".bold().underline());
    println!(
        "{:<10} {:<15} {:<6} {:<10} {:<20} {:<20}",
        "ID", "User", "GPUs", "Status", "Created", "Expires"
    );
    println!("{}", "-".repeat(80));
    
    // Print reservations
    for reservation in reservations {
        println!(
            "{:<10} {:<15} {:<6} {:<10} {:<20} {:<20}",
            &reservation.reservation_id[..8],
            reservation.user_id,
            reservation.gpu_count,
            reservation.status,
            reservation.created_at.unwrap_or_else(|| "N/A".to_string()),
            reservation.expires_at.unwrap_or_else(|| "N/A".to_string())
        );
    }
    
    Ok(())
}

async fn handle_cancel(config: Config, reservation_id: String) -> anyhow::Result<()> {
    // Authenticate user
    let user_info = auth::authenticate_user(&config).await?;
    
    let reservation_mgr = reservations::ReservationManager::new(config);
    let success = reservation_mgr
        .cancel_reservation(&reservation_id, &user_info.login)
        .await?;
    
    if success {
        println!("{} Reservation {} cancelled", "✅".green(), reservation_id);
    } else {
        eprintln!("{} Failed to cancel reservation {}", "❌".red(), reservation_id);
    }
    
    Ok(())
}

async fn handle_connect(config: Config, reservation_id: String) -> anyhow::Result<()> {
    // Authenticate user
    let user_info = auth::authenticate_user(&config).await?;
    
    let reservation_mgr = reservations::ReservationManager::new(config);
    let connection_info = reservation_mgr
        .get_connection_info(&reservation_id, &user_info.login)
        .await?;
    
    if let Some(info) = connection_info {
        println!("\n{}", "🚀 Connection Details".bold().green());
        println!("{}", "=".repeat(50));
        println!("{}: {}", "SSH Command".bold(), info.ssh_command);
        println!("{}: {}", "Pod Name".bold(), info.pod_name);
        println!("{}: {}", "Namespace".bold(), info.namespace);
        println!("{}: {}", "GPUs".bold(), info.gpu_count);
    } else {
        eprintln!("{} Could not get connection info for {}", "❌".red(), reservation_id);
    }
    
    Ok(())
}

async fn handle_status(config: Config) -> anyhow::Result<()> {
    // Authenticate user
    let _user_info = auth::authenticate_user(&config).await?;
    
    let reservation_mgr = reservations::ReservationManager::new(config);
    let status = reservation_mgr.get_cluster_status().await?;
    
    if let Some(cluster_status) = status {
        println!("\n{}", "GPU Cluster Status".bold().green());
        println!("{}", "=".repeat(40));
        println!("{:<20}: {}", "Total GPUs", cluster_status.total_gpus);
        println!("{:<20}: {}", "Available GPUs", cluster_status.available_gpus);
        println!("{:<20}: {}", "Reserved GPUs", cluster_status.reserved_gpus);
        println!("{:<20}: {}", "Active Reservations", cluster_status.active_reservations);
        println!("{:<20}: {}", "Queue Length", cluster_status.queue_length);
    } else {
        eprintln!("{} Could not get cluster status", "❌".red());
    }
    
    Ok(())
}

async fn handle_config(config: Config) -> anyhow::Result<()> {
    println!("\n{}", "⚙️  Current Configuration".bold().green());
    println!("{}", "=".repeat(40));
    println!("{:<20}: {}", "Region", config.aws_region);
    println!("{:<20}: {}", "Queue URL", config.queue_url);
    println!("{:<20}: {}", "Cluster", config.cluster_name);
    println!("{:<20}: {}", "GitHub Org", config.github_org);
    
    Ok(())
}