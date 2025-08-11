"""
GPU Developer CLI - Main entry point
Reserve and manage GPU development servers
"""

import click
import json
from typing import Optional
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich import print as rprint

from .auth import authenticate_user
from .reservations import ReservationManager
from .config import Config, load_config
from .test_state import TestStateManager

console = Console()

@click.group()
@click.option('--test', is_flag=True, help='Run in test mode with dummy state')
@click.version_option()
@click.pass_context
def main(ctx: click.Context, test: bool) -> None:
    """GPU Developer CLI - Reserve and manage GPU development servers"""
    ctx.ensure_object(dict)
    ctx.obj['test_mode'] = test
    if test:
        rprint("[yellow]🧪 Running in TEST MODE - using dummy state[/yellow]")

@main.command()
@click.option('--gpus', '-g', type=click.Choice(['1', '2', '4', '8', '16']), default='1', 
              help='Number of GPUs to reserve (16 = 2x8 GPU setup)')
@click.option('--hours', '-h', type=float, default=8.0, 
              help='Reservation duration in hours (supports decimals, max 24)')
@click.option('--name', '-n', type=str, 
              help='Optional name for the reservation')
@click.option('--dry-run', is_flag=True, 
              help='Show what would be reserved without actually reserving')
@click.pass_context
def reserve(ctx: click.Context, gpus: str, hours: float, name: Optional[str], dry_run: bool) -> None:
    """Reserve GPU development server(s)"""
    try:
        test_mode = ctx.obj.get('test_mode', False)
        gpu_count = int(gpus)
        
        # Validate parameters
        if hours > 24:
            rprint("[red]❌ Maximum reservation time is 24 hours[/red]")
            return
        
        if hours < 0.0833:  # Less than 5 minutes
            rprint("[red]❌ Minimum reservation time is 5 minutes (0.0833 hours)[/red]")
            return
        
        if test_mode:
            # Test mode with dummy auth
            user_info = {'login': 'test-user'}
            test_mgr = TestStateManager()
            
            if dry_run:
                rprint(f"[yellow]🔍 TEST DRY RUN: Would reserve {gpu_count} GPU(s) for {hours} hours[/yellow]")
                rprint(f"[yellow]User: {user_info['user_id']}[/yellow]")
                return
            
            reservation_id = test_mgr.create_reservation(
                user_id=user_info['user_id'],
                gpu_count=gpu_count,
                duration_hours=hours,
                name=name
            )
        else:
            # Production mode - zero config!
            config = load_config()
            
            # Authenticate using AWS credentials - if you can call AWS, you're authorized
            try:
                user_info = authenticate_user(config)
            except RuntimeError as e:
                rprint(f"[red]❌ {str(e)}[/red]")
                return
            
            if dry_run:
                rprint(f"[yellow]🔍 DRY RUN: Would reserve {gpu_count} GPU(s) for {hours} hours[/yellow]")
                rprint(f"[yellow]User: {user_info['user_id']} ({user_info['arn']})[/yellow]")
                return
            
            # Submit reservation
            reservation_mgr = ReservationManager(config)
            reservation_id = reservation_mgr.create_reservation(
                user_id=user_info['user_id'],
                gpu_count=gpu_count,
                duration_hours=hours,
                name=name,
                github_user=user_info['github_user']
            )
        
        if reservation_id:
            rprint(f"[green]✅ Reservation request submitted: {reservation_id[:8]}...[/green]")
            
            # Poll for completion with spinner and status updates
            if test_mode:
                # In test mode, simulate immediate completion
                rprint(f"[green]✅ TEST: Reservation complete![/green]")
                rprint(f"[cyan]📋 Reservation ID:[/cyan] {reservation_id}")
                rprint(f"[cyan]⏰ Valid for:[/cyan] {hours} hours")
                rprint(f"[cyan]🖥️  Connect with:[/cyan] ssh test-user@test-server")
            else:
                # Production mode - poll for real completion
                completed_reservation = reservation_mgr.wait_for_reservation_completion(
                    reservation_id=reservation_id,
                    timeout_minutes=10
                )
                
                if not completed_reservation:
                    rprint(f"[yellow]💡 Use 'gpu-dev connect {reservation_id[:8]}' to check connection details later[/yellow]")
        else:
            rprint("[red]❌ Failed to create reservation[/red]")
            
    except Exception as e:
        rprint(f"[red]❌ Error: {str(e)}[/red]")

@main.command()
@click.option('--user', '-u', type=str, help='Filter by user (optional)')
@click.option('--status', '-s', type=click.Choice(['active', 'expired', 'cancelled']), 
              help='Filter by status (optional)')
@click.pass_context
def list(ctx: click.Context, user: Optional[str], status: Optional[str]) -> None:
    """List GPU reservations"""
    try:
        test_mode = ctx.obj.get('test_mode', False)
        
        if test_mode:
            test_mgr = TestStateManager()
            reservations = test_mgr.list_reservations(user_filter=user, status_filter=status)
        else:
            config = load_config()
            
            # Authenticate using AWS credentials
            try:
                user_info = authenticate_user(config)
                reservation_mgr = ReservationManager(config)
                reservations = reservation_mgr.list_reservations(user_filter=user, status_filter=status)
            except RuntimeError as e:
                rprint(f"[red]❌ {str(e)}[/red]")
                return
        
        if not reservations:
            rprint("[yellow]📋 No reservations found[/yellow]")
            return
        
        # Create table
        table = Table(title="GPU Reservations")
        table.add_column("ID", style="cyan", no_wrap=True)
        table.add_column("User", style="green")
        table.add_column("GPUs", style="magenta")
        table.add_column("Status", style="yellow")
        table.add_column("Created", style="blue")
        table.add_column("Expires", style="red")
        
        for reservation in reservations:
            table.add_row(
                reservation['reservation_id'][:8],
                reservation['user_id'],
                str(reservation['gpu_count']),
                reservation['status'],
                reservation.get('created_at', 'N/A'),
                reservation.get('expires_at', 'N/A')
            )
        
        console.print(table)
        
    except Exception as e:
        rprint(f"[red]❌ Error: {str(e)}[/red]")

@main.command()
@click.argument('reservation_id')
@click.pass_context
def cancel(ctx: click.Context, reservation_id: str) -> None:
    """Cancel a GPU reservation"""
    try:
        test_mode = ctx.obj.get('test_mode', False)
        
        if test_mode:
            test_mgr = TestStateManager()
            success = test_mgr.cancel_reservation(reservation_id, 'test-user')
        else:
            config = load_config()
            
            # Authenticate using AWS credentials
            try:
                user_info = authenticate_user(config)
                reservation_mgr = ReservationManager(config)
                success = reservation_mgr.cancel_reservation(reservation_id, user_info['user_id'])
            except RuntimeError as e:
                rprint(f"[red]❌ {str(e)}[/red]")
                return
        
        if success:
            rprint(f"[green]✅ Reservation {reservation_id} cancelled[/green]")
        else:
            rprint(f"[red]❌ Failed to cancel reservation {reservation_id}[/red]")
            
    except Exception as e:
        rprint(f"[red]❌ Error: {str(e)}[/red]")

@main.command()
@click.argument('reservation_id')
@click.pass_context
def connect(ctx: click.Context, reservation_id: str) -> None:
    """Get SSH connection details for a reservation"""
    try:
        test_mode = ctx.obj.get('test_mode', False)
        
        if test_mode:
            test_mgr = TestStateManager()
            connection_info = test_mgr.get_connection_info(reservation_id, 'test-user')
        else:
            config = load_config()
            
            # Authenticate using AWS credentials
            try:
                user_info = authenticate_user(config)
                reservation_mgr = ReservationManager(config)
                connection_info = reservation_mgr.get_connection_info(reservation_id, user_info['user_id'])
            except RuntimeError as e:
                rprint(f"[red]❌ {str(e)}[/red]")
                return
        
        if connection_info:
            panel = Panel.fit(
                f"[green]SSH Connection Info[/green]\n\n"
                f"[blue]Command:[/blue] {connection_info['ssh_command']}\n"
                f"[blue]Pod Name:[/blue] {connection_info['pod_name']}\n"
                f"[blue]Namespace:[/blue] {connection_info['namespace']}\n"
                f"[blue]GPUs:[/blue] {connection_info['gpu_count']}",
                title="🚀 Connection Details"
            )
            console.print(panel)
        else:
            rprint(f"[red]❌ Could not get connection info for {reservation_id}[/red]")
            
    except Exception as e:
        rprint(f"[red]❌ Error: {str(e)}[/red]")

@main.command()
@click.pass_context
def status(ctx: click.Context) -> None:
    """Show overall GPU cluster status"""
    try:
        test_mode = ctx.obj.get('test_mode', False)
        
        if test_mode:
            test_mgr = TestStateManager()
            cluster_status = test_mgr.get_cluster_status()
        else:
            config = load_config()
            
            # Authenticate using AWS credentials
            try:
                user_info = authenticate_user(config)
                reservation_mgr = ReservationManager(config)
                cluster_status = reservation_mgr.get_cluster_status()
            except RuntimeError as e:
                rprint(f"[red]❌ {str(e)}[/red]")
                return
        
        if cluster_status:
            table = Table(title="GPU Cluster Status")
            table.add_column("Metric", style="cyan")
            table.add_column("Value", style="green")
            
            table.add_row("Total GPUs", str(cluster_status['total_gpus']))
            table.add_row("Available GPUs", str(cluster_status['available_gpus']))
            table.add_row("Reserved GPUs", str(cluster_status['reserved_gpus']))
            table.add_row("Active Reservations", str(cluster_status['active_reservations']))
            table.add_row("Queue Length", str(cluster_status['queue_length']))
            
            console.print(table)
        else:
            rprint("[red]❌ Could not get cluster status[/red]")
            
    except Exception as e:
        rprint(f"[red]❌ Error: {str(e)}[/red]")

@main.group()
def config() -> None:
    """Manage configuration settings"""
    pass

@config.command()
def show() -> None:
    """Show current configuration"""
    try:
        config = load_config()
        identity = config.get_user_identity()
        github_user = config.get_github_username()
        
        config_text = (
            f"[green]Configuration (Zero-Config)[/green]\n\n"
            f"[blue]Region:[/blue] {config.aws_region}\n"
            f"[blue]Queue:[/blue] {config.queue_name}\n"
            f"[blue]Cluster:[/blue] {config.cluster_name}\n"
            f"[blue]User:[/blue] {identity['arn']}\n"
            f"[blue]Account:[/blue] {identity['account']}\n\n"
            f"[green]User Settings ({config.config_file})[/green]\n"
            f"[blue]GitHub User:[/blue] {github_user or '[red]Not set - run: gpu-dev config set github_user <username>[/red]'}"
        )
        
        panel = Panel.fit(config_text, title="⚙️  Configuration")
        console.print(panel)
        
    except Exception as e:
        rprint(f"[red]❌ Error: {str(e)}[/red]")

@config.command()
@click.argument('key')
@click.argument('value')
def set(key: str, value: str) -> None:
    """Set a configuration value (e.g., gpu-dev config set github_user myusername)"""
    try:
        config = load_config()
        
        # Validate known keys
        valid_keys = ['github_user']
        if key not in valid_keys:
            rprint(f"[red]❌ Unknown config key '{key}'. Valid keys: {', '.join(valid_keys)}[/red]")
            return
            
        config.save_user_config(key, value)
        rprint(f"[green]✅ Set {key} = {value}[/green]")
        rprint(f"[dim]Saved to {config.config_file}[/dim]")
        
    except Exception as e:
        rprint(f"[red]❌ Error: {str(e)}[/red]")

# Test utilities
@main.group()
def test() -> None:
    """Test utilities for the CLI"""
    pass

@test.command()
def reset() -> None:
    """Reset test state to defaults"""
    test_mgr = TestStateManager()
    test_mgr.reset_state()

@test.command()
def demo() -> None:
    """Run a demo scenario with test reservations"""
    test_mgr = TestStateManager()
    test_mgr.reset_state()
    
    rprint("[yellow]🧪 Creating demo test reservations...[/yellow]")
    
    # Create some demo reservations
    reservations = [
        ("alice", 2, 4, "ML training"),
        ("bob", 1, 8, None),
        ("charlie", 4, 2, "inference testing")
    ]
    
    for user, gpus, hours, name in reservations:
        res_id = test_mgr.create_reservation(user, gpus, hours, name)
        if res_id:
            rprint(f"[green]✅ Created demo reservation {res_id[:8]} for {user}[/green]")
    
    rprint("[blue]📋 Demo data created! Try: gpu-dev --test list[/blue]")

if __name__ == '__main__':
    main()