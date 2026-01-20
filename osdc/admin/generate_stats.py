#!/usr/bin/env python3
"""
GPU Dev Server Usage Analytics
Generates statistics and visualizations from DynamoDB reservation data
"""

import argparse
import boto3
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import seaborn as sns
from datetime import datetime, timedelta
from collections import defaultdict
import json
import os

# Set style
sns.set_style("whitegrid")
plt.rcParams['figure.figsize'] = (12, 6)
plt.rcParams['font.size'] = 10

# AWS Configuration
REGION = os.environ.get('AWS_REGION', 'us-east-2')
TABLE_NAME = os.environ.get(
    'RESERVATIONS_TABLE', 'pytorch-gpu-dev-reservations')

# Output directory
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), 'output')
os.makedirs(OUTPUT_DIR, exist_ok=True)


def fetch_all_reservations():
    """Fetch all reservations from DynamoDB"""
    print("Fetching reservations from DynamoDB...")
    dynamodb = boto3.resource('dynamodb', region_name=REGION)
    table = dynamodb.Table(TABLE_NAME)

    reservations = []
    last_evaluated_key = None

    while True:
        if last_evaluated_key:
            response = table.scan(ExclusiveStartKey=last_evaluated_key)
        else:
            response = table.scan()

        reservations.extend(response.get('Items', []))

        last_evaluated_key = response.get('LastEvaluatedKey')
        if not last_evaluated_key:
            break

    print(f"Fetched {len(reservations)} reservations")
    return reservations


def parse_reservation_data(reservations):
    """Parse reservation data into a DataFrame"""
    print("Parsing reservation data...")

    data = []
    for res in reservations:
        try:
            # A reservation is not valid without a creation date.
            created_at_raw = res.get('created_at', '')
            if not created_at_raw:
                continue

            # Parse created_at (can be ISO string or timestamp)
            if isinstance(created_at_raw, str):
                # ISO 8601 format: "2025-10-03T03:09:06.002555"
                created_at = datetime.fromisoformat(
                    created_at_raw.replace('Z', '+00:00'))
            else:
                # Numeric timestamp
                created_at = datetime.fromtimestamp(float(created_at_raw))

            # Parse expired_at (preferred) or expires_at (fallback)
            expires_at_raw = res.get(
                'expired_at', '') or res.get('expires_at', '')
            expires_at = None
            if expires_at_raw:
                if isinstance(expires_at_raw, str):
                    expires_at = datetime.fromisoformat(
                        expires_at_raw.replace('Z', '+00:00'))
                else:
                    expires_at = datetime.fromtimestamp(float(expires_at_raw))

            # Calculate duration
            duration_hours = 0
            if expires_at and expires_at > created_at:
                duration_hours = (
                    expires_at - created_at).total_seconds() / 3600

            data.append({
                'reservation_id': res.get('reservation_id', ''),
                'user_id': res.get('user_id', ''),
                # Normalize to lowercase
                'gpu_type': res.get('gpu_type', '').lower(),
                'gpu_count': int(res.get('gpu_count', 1)),
                'status': res.get('status', ''),
                'created_at': created_at,
                'expires_at': expires_at,
                'duration_hours': duration_hours,
            })
        except Exception as e:
            print(f"Warning: Failed to parse reservation: {e}")
            continue

    df = pd.DataFrame(data)
    print(f"Parsed {len(df)} valid reservations")
    return df


def fetch_gpu_availability():
    """Fetch total available GPUs for each type from DynamoDB"""
    print("\nFetching GPU availability...")
    availability_table_name = os.environ.get(
        'AVAILABILITY_TABLE', 'pytorch-gpu-dev-availability')
    try:
        dynamodb = boto3.resource('dynamodb', region_name=REGION)
        table = dynamodb.Table(availability_table_name)
        response = table.scan()
        items = response.get('Items', [])

        while 'LastEvaluatedKey' in response:
            response = table.scan(
                ExclusiveStartKey=response['LastEvaluatedKey'])
            items.extend(response.get('Items', []))

        availability = defaultdict(int)
        for item in items:
            gpu_type = item.get('gpu_type', 'unknown').lower()
            # Assuming the attribute for total count is 'total_capacity'
            count = int(item.get('total_capacity', 0))
            availability[gpu_type] += count

        print(f"  Fetched availability for {len(availability)} GPU types.")
        return dict(availability)
    except Exception as e:
        print(
            f"Warning: Could not fetch GPU availability from table '{availability_table_name}'. This is expected if the table does not exist.")
        print(f"  Full error: {e}")
        print("  Max capacity line will be omitted from usage charts.")
        return {}


def calculate_statistics(df):
    """Calculate key statistics"""
    print("\nCalculating statistics...")

    stats = {
        'total_reservations': len(df),
        'unique_users': df['user_id'].nunique(),
        'date_range': {
            'first': df['created_at'].min(),
            'last': df['created_at'].max(),
        },
        'gpu_types': df['gpu_type'].value_counts().to_dict(),
        'status_breakdown': df['status'].value_counts().to_dict(),
        'total_gpu_hours': (df['duration_hours'] * df['gpu_count']).sum(),
    }

    return stats


def plot_daily_active_reservations(df, weeks=4):
    """Plot daily active reservation counts for last N weeks"""
    print("\nGenerating daily active reservations plot...")

    # Get last N weeks
    end_date = datetime.now()
    start_date = end_date - timedelta(weeks=weeks)

    # Filter to last N weeks
    df_recent = df[df['created_at'] >= start_date].copy()

    # Create date range for last N weeks
    date_range = pd.date_range(start=start_date, end=end_date, freq='D')

    # Count active reservations per day
    daily_active = []
    for date in date_range:
        active = df_recent[
            (df_recent['created_at'] <= date) &
            ((df_recent['expires_at'].isna()) |
             (df_recent['expires_at'] >= date))
        ]
        daily_active.append(len(active))

    # Plot
    plt.figure(figsize=(14, 6))
    plt.plot(date_range, daily_active, marker='o', linewidth=2, markersize=4)
    plt.title(f'Daily Active Reservations (Last {weeks} Weeks)',
              fontsize=16, fontweight='bold')
    plt.xlabel('Date', fontsize=12)
    plt.ylabel('Number of Active Reservations', fontsize=12)
    plt.grid(True, alpha=0.3)
    plt.gca().xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
    plt.gca().xaxis.set_major_locator(mdates.DayLocator(interval=max(1, weeks // 4)))
    plt.xticks(rotation=45)
    plt.tight_layout()
    plt.savefig(os.path.join(
        OUTPUT_DIR, 'daily_active_reservations.png'), dpi=300, bbox_inches='tight')
    print(f"  Saved: {OUTPUT_DIR}/daily_active_reservations.png")
    plt.close()


def plot_hourly_gpu_usage(df, weeks=4):
    """Plot hourly active GPU count for last N weeks"""
    print("\nGenerating hourly GPU usage plot...")

    # Get last N weeks
    end_date = datetime.now()
    start_date = end_date - timedelta(weeks=weeks)

    # Filter to last N weeks
    df_recent = df[df['created_at'] >= start_date].copy()

    # Create hourly range for last N weeks
    hour_range = pd.date_range(start=start_date, end=end_date, freq='H')

    # Count active GPUs per hour
    hourly_gpus = []
    for hour in hour_range:
        active = df_recent[
            (df_recent['created_at'] <= hour) &
            ((df_recent['expires_at'].isna()) |
             (df_recent['expires_at'] >= hour))
        ]
        total_gpus = (active['gpu_count']).sum()
        hourly_gpus.append(total_gpus)

    # Plot
    plt.figure(figsize=(16, 6))
    plt.plot(hour_range, hourly_gpus, linewidth=1, alpha=0.8)
    plt.fill_between(hour_range, hourly_gpus, alpha=0.3)
    plt.title(f'Hourly Active GPU Count (Last {weeks} Weeks)',
              fontsize=16, fontweight='bold')
    plt.xlabel('Date', fontsize=12)
    plt.ylabel('Number of Active GPUs', fontsize=12)
    plt.grid(True, alpha=0.3)
    plt.gca().xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
    plt.gca().xaxis.set_major_locator(mdates.DayLocator(interval=max(1, weeks // 2)))
    plt.xticks(rotation=45)
    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'hourly_gpu_usage.png'),
                dpi=300, bbox_inches='tight')
    print(f"  Saved: {OUTPUT_DIR}/hourly_gpu_usage.png")
    plt.close()


def plot_gpu_type_distribution(df):
    """Plot GPU type distribution"""
    print("\nGenerating GPU type distribution plot...")

    gpu_counts = df['gpu_type'].value_counts()

    plt.figure(figsize=(10, 6))
    colors = sns.color_palette("husl", len(gpu_counts))
    plt.bar(range(len(gpu_counts)), gpu_counts.values, color=colors)
    plt.xticks(range(len(gpu_counts)), gpu_counts.index,
               rotation=45, ha='right')
    plt.title('Reservations by GPU Type', fontsize=16, fontweight='bold')
    plt.xlabel('GPU Type', fontsize=12)
    plt.ylabel('Number of Reservations', fontsize=12)
    plt.grid(True, alpha=0.3, axis='y')
    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'gpu_type_distribution.png'),
                dpi=300, bbox_inches='tight')
    print(f"  Saved: {OUTPUT_DIR}/gpu_type_distribution.png")
    plt.close()


def plot_top_users(df, top_n=10):
    """Plot top users by reservation count"""
    print("\nGenerating top users plot...")

    user_counts = df['user_id'].value_counts().head(top_n)

    plt.figure(figsize=(12, 6))
    colors = sns.color_palette("viridis", len(user_counts))
    plt.barh(range(len(user_counts)), user_counts.values, color=colors)
    plt.yticks(range(len(user_counts)), [
               u.split('@')[0] for u in user_counts.index])
    plt.title(f'Top {top_n} Users by Reservation Count',
              fontsize=16, fontweight='bold')
    plt.xlabel('Number of Reservations', fontsize=12)
    plt.ylabel('User', fontsize=12)
    plt.grid(True, alpha=0.3, axis='x')
    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'top_users.png'),
                dpi=300, bbox_inches='tight')
    print(f"  Saved: {OUTPUT_DIR}/top_users.png")
    plt.close()


def plot_top_users_by_gpu_hours(df, top_n=10):
    """Plot top users by GPU hours, grouped by GPU type (stacked bar)"""
    print("\nGenerating top users by GPU hours plot...")

    # Calculate GPU hours per user per GPU type
    df['gpu_hours'] = df['duration_hours'] * df['gpu_count']

    # Get top N users by total GPU hours
    top_users = df.groupby('user_id')['gpu_hours'].sum().nlargest(top_n).index

    # Filter to top users and pivot for stacking
    df_top = df[df['user_id'].isin(top_users)].copy()
    user_gpu_type_hours = df_top.groupby(['user_id', 'gpu_type'])[
        'gpu_hours'].sum().unstack(fill_value=0)

    # Sort by total GPU hours
    user_gpu_type_hours['total'] = user_gpu_type_hours.sum(axis=1)
    user_gpu_type_hours = user_gpu_type_hours.sort_values(
        'total', ascending=True)
    user_gpu_type_hours = user_gpu_type_hours.drop('total', axis=1)

    # Plot stacked horizontal bar chart
    plt.figure(figsize=(12, 8))
    colors = sns.color_palette("Set2", len(user_gpu_type_hours.columns))

    user_gpu_type_hours.plot(
        kind='barh',
        stacked=True,
        color=colors,
        figsize=(12, 8)
    )

    # Format y-axis labels (remove @domain.com)
    labels = [u.split('@')[0] for u in user_gpu_type_hours.index]
    plt.yticks(range(len(labels)), labels)

    plt.title(f'Top {top_n} Users by GPU Hours (by GPU Type)',
              fontsize=16, fontweight='bold')
    plt.xlabel('GPU Hours', fontsize=12)
    plt.ylabel('User', fontsize=12)
    plt.legend(title='GPU Type', bbox_to_anchor=(1.05, 1), loc='upper left')
    plt.grid(True, alpha=0.3, axis='x')
    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'top_users_gpu_hours.png'),
                dpi=300, bbox_inches='tight')
    print(f"  Saved: {OUTPUT_DIR}/top_users_gpu_hours.png")
    plt.close()


def plot_gpu_usage_by_type(df, gpu_availability, weeks=4, target_types=['h200', 'b200']):
    """Plot hourly usage for specific GPU types against total capacity."""
    print("\nGenerating GPU usage plots by type...")

    end_date = datetime.now()
    start_date = end_date - timedelta(weeks=weeks)
    hour_range = pd.date_range(start=start_date, end=end_date, freq='H')
    target_types = [t.lower() for t in target_types]
    generated_plots = []

    for gpu_type in target_types:
        print(f"  Processing {gpu_type}...")
        df_type = df[df['gpu_type'] == gpu_type].copy()

        if df_type.empty:
            print(f"    No data for {gpu_type}, skipping plot.")
            continue

        hourly_gpus = []
        for hour in hour_range:
            active = df_type[
                (df_type['created_at'] <= hour) &
                ((df_type['expires_at'].isna()) |
                 (df_type['expires_at'] >= hour))
            ]
            total_gpus = active['gpu_count'].sum()
            hourly_gpus.append(total_gpus)

        plt.figure(figsize=(14, 6))
        plt.plot(hour_range, hourly_gpus, linewidth=2,
                 label=f'GPUs in Use ({gpu_type})')
        plt.fill_between(hour_range, hourly_gpus, alpha=0.2)

        max_gpus = gpu_availability.get(gpu_type)
        if max_gpus is not None:
            plt.axhline(y=max_gpus, color='r', linestyle='--',
                        label=f'Max Capacity ({max_gpus} GPUs)')

        plt.title(f'{gpu_type.upper()} GPU Usage (Last {weeks} Weeks)',
                  fontsize=16, fontweight='bold')
        plt.xlabel('Date', fontsize=12)
        plt.ylabel('Number of Active GPUs', fontsize=12)
        plt.legend()
        plt.grid(True, alpha=0.3)
        plt.ylim(bottom=0)
        plt.gca().xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
        plt.gca().xaxis.set_major_locator(mdates.DayLocator(interval=max(1, weeks // 2)))
        plt.xticks(rotation=45)
        plt.tight_layout()

        filename = f'usage_{gpu_type}.png'
        filepath = os.path.join(OUTPUT_DIR, filename)
        plt.savefig(filepath, dpi=300, bbox_inches='tight')
        print(f"    Saved: {filepath}")
        plt.close()
        generated_plots.append(filename)

    return generated_plots


def plot_unique_users_per_day(df, weeks=4):
    """Plot unique users per day for last N weeks"""
    print("\nGenerating unique users per day plot...")

    # Get last N weeks
    end_date = datetime.now()
    start_date = end_date - timedelta(weeks=weeks)

    # Filter to last N weeks
    df_recent = df[df['created_at'] >= start_date].copy()

    # Create date range for last N weeks
    date_range = pd.date_range(start=start_date, end=end_date, freq='D')

    # Count unique users per day
    daily_unique_users = []
    for date in date_range:
        # Get reservations that were active on this day
        active = df_recent[
            (df_recent['created_at'] <= date) &
            ((df_recent['expires_at'].isna()) |
             (df_recent['expires_at'] >= date))
        ]
        # Count unique users
        unique_users = active['user_id'].nunique()
        daily_unique_users.append(unique_users)

    # Plot
    plt.figure(figsize=(14, 6))
    plt.plot(date_range, daily_unique_users, marker='o',
             linewidth=2, markersize=4, color='#2ecc71')
    plt.fill_between(date_range, daily_unique_users,
                     alpha=0.3, color='#2ecc71')
    plt.title(f'Unique Users Per Day (Last {weeks} Weeks)',
              fontsize=16, fontweight='bold')
    plt.xlabel('Date', fontsize=12)
    plt.ylabel('Number of Unique Users', fontsize=12)
    plt.grid(True, alpha=0.3)
    plt.gca().xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
    plt.gca().xaxis.set_major_locator(mdates.DayLocator(interval=max(1, weeks // 4)))
    plt.xticks(rotation=45)
    plt.ylim(bottom=0)
    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'unique_users_per_day.png'),
                dpi=300, bbox_inches='tight')
    print(f"  Saved: {OUTPUT_DIR}/unique_users_per_day.png")
    plt.close()


def plot_unique_users_per_week(df, weeks=4):
    """Plot unique users per week (users who had at least one reservation that week)"""
    print("\nGenerating unique users per week plot...")

    # Get last N weeks
    end_date = datetime.now()
    start_date = end_date - timedelta(weeks=weeks)

    # Filter to last N weeks
    df_recent = df[df['created_at'] >= start_date].copy()

    # Create week range
    week_starts = pd.date_range(start=start_date, end=end_date, freq='W-MON')
    if len(week_starts) == 0 or week_starts[0] > start_date:
        week_starts = pd.date_range(
            start=start_date, periods=weeks+1, freq='W')

    # Count unique users per week
    weekly_unique_users = []
    plot_weeks = []

    for i in range(len(week_starts)):
        week_start = week_starts[i]
        week_end = week_starts[i+1] if i < len(week_starts)-1 else end_date

        # Get users who created at least one reservation during this week
        week_reservations = df_recent[
            (df_recent['created_at'] >= week_start) &
            (df_recent['created_at'] < week_end)
        ]

        unique_users = week_reservations['user_id'].nunique()
        weekly_unique_users.append(unique_users)
        plot_weeks.append(week_start)

    # Plot
    plt.figure(figsize=(14, 6))
    plt.bar(plot_weeks, weekly_unique_users, width=5, color='#3498db',
            alpha=0.7, edgecolor='#2980b9', linewidth=1.5)
    plt.title(f'Unique Users Per Week (Last {weeks} Weeks)',
              fontsize=16, fontweight='bold')
    plt.xlabel('Week Starting', fontsize=12)
    plt.ylabel('Number of Unique Users', fontsize=12)
    plt.grid(True, alpha=0.3, axis='y')
    plt.gca().xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
    plt.xticks(rotation=45)
    plt.ylim(bottom=0)
    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'unique_users_per_week.png'),
                dpi=300, bbox_inches='tight')
    print(f"  Saved: {OUTPUT_DIR}/unique_users_per_week.png")
    plt.close()


def plot_gpu_hours_per_day_by_type(df, weeks=4, target_types=['h200', 'b200']):
    """Plot GPU hours consumed per day for specific GPU types with capacity changes"""
    print("\nGenerating GPU hours per day by type plot...")

    # Get last N weeks
    end_date = datetime.now()
    start_date = end_date - timedelta(weeks=weeks)

    # Filter to last N weeks and exclude failed reservations
    df_recent = df[
        (df['created_at'] >= start_date) &
        (df['status'] != 'failed')
    ].copy()

    # Create date range
    date_range = pd.date_range(start=start_date, end=end_date, freq='D')

    # Normalize target types
    target_types = [t.lower() for t in target_types]

    # Calculate GPU hours per day for each GPU type
    gpu_type_daily_hours = {}
    for gpu_type in target_types:
        df_type = df_recent[df_recent['gpu_type'] == gpu_type].copy()

        if df_type.empty:
            print(f"  No data for {gpu_type}, skipping from plot.")
            continue

        daily_hours = []
        for date in date_range:
            day_start = date
            day_end = date + timedelta(days=1)

            # Get reservations active during this day
            active = df_type[
                (df_type['created_at'] < day_end) &
                ((df_type['expires_at'].isna()) |
                 (df_type['expires_at'] >= day_start))
            ]

            # Calculate GPU hours for this day
            total_hours = 0
            for _, res in active.iterrows():
                # Calculate overlap between reservation and this day
                res_start = max(res['created_at'], day_start)
                res_end = min(res['expires_at'] if pd.notna(
                    res['expires_at']) else day_end, day_end)

                if res_end > res_start:
                    hours = (res_end - res_start).total_seconds() / 3600
                    gpu_hours = hours * res['gpu_count']
                    total_hours += gpu_hours

            daily_hours.append(total_hours)

        gpu_type_daily_hours[gpu_type] = daily_hours

    if not gpu_type_daily_hours:
        print("  No data for any target GPU types, skipping plot.")
        return

    # Plot
    fig, ax = plt.subplots(figsize=(14, 7))
    colors = {'h200': '#e74c3c', 'b200': '#9b59b6',
              'h100': '#3498db', 't4': '#2ecc71', 'l4': '#f39c12'}

    # Add weekend shading (Saturday=5, Sunday=6)
    for date in date_range:
        if date.weekday() in [5, 6]:  # Saturday or Sunday
            ax.axvspan(date, date + timedelta(days=1),
                       color='lightgray', alpha=0.3, zorder=0)

    # Plot GPU hours
    for gpu_type, hours in gpu_type_daily_hours.items():
        color = colors.get(gpu_type, '#95a5a6')
        ax.plot(date_range, hours, marker='o', linewidth=2, markersize=4,
                label=gpu_type.upper(), color=color, zorder=3)
        ax.fill_between(date_range, hours, alpha=0.2, color=color, zorder=2)

    # Add three-step capacity line
    # Phase 1: Before Oct 5 - 16 GPUs
    # Phase 2: Oct 5 to Oct 12 (7 days) - 32 GPUs
    # Phase 3: After Oct 12 - 24 GPUs
    step_date_1 = datetime(2025, 10, 5)
    step_date_2 = datetime(2025, 10, 12)

    capacity_phase1 = 24 * 16   # 384 GPU-hours/day
    capacity_phase2 = 24 * 32   # 768 GPU-hours/day
    capacity_phase3 = 24 * 24   # 576 GPU-hours/day

    # Split date range into three phases
    dates_phase1 = [d for d in date_range if d < step_date_1]
    dates_phase2 = [d for d in date_range if step_date_1 <= d < step_date_2]
    dates_phase3 = [d for d in date_range if d >= step_date_2]

    # Draw capacity lines for each phase
    if dates_phase1:
        ax.hlines(y=capacity_phase1, xmin=dates_phase1[0], xmax=step_date_1,
                  color='red', linestyle='--', linewidth=2, alpha=0.7, zorder=2)

    if dates_phase2:
        ax.hlines(y=capacity_phase2, xmin=step_date_1, xmax=step_date_2,
                  color='red', linestyle='--', linewidth=2, alpha=0.7, zorder=2)

    if dates_phase3:
        ax.hlines(y=capacity_phase3, xmin=step_date_2, xmax=dates_phase3[-1] + timedelta(days=1),
                  color='red', linestyle='--', linewidth=2, alpha=0.7, zorder=2)

    # Add label showing the capacity changes
    label_text = f'Max Available GPUs (16→32→24): {capacity_phase1}→{capacity_phase2}→{capacity_phase3} GPU-h/day)'
    ax.plot([], [], color='red', linestyle='--',
            linewidth=2, alpha=0.7, label=label_text)

    ax.set_title(f'GPU Hours Per Day by Type (Last {weeks} Weeks)',
                 fontsize=16, fontweight='bold')
    ax.set_xlabel('Date', fontsize=12)
    ax.set_ylabel('GPU Hours', fontsize=12)
    ax.legend(fontsize=10, loc='upper left')
    ax.grid(True, alpha=0.3, zorder=1)
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
    ax.xaxis.set_major_locator(mdates.DayLocator(interval=max(1, weeks // 4)))
    plt.xticks(rotation=45)
    ax.set_ylim(bottom=0)
    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'gpu_hours_per_day_by_type.png'),
                dpi=300, bbox_inches='tight')
    print(f"  Saved: {OUTPUT_DIR}/gpu_hours_per_day_by_type.png")
    plt.close()


def plot_reservations_per_user_over_time(df, weeks=4, top_n=10):
    """Plot reservations per week for top N users"""
    print("\nGenerating reservations per user over time plot...")

    # Get last N weeks
    end_date = datetime.now()
    start_date = end_date - timedelta(weeks=weeks)

    # Filter to last N weeks
    df_recent = df[df['created_at'] >= start_date].copy()

    # Get top N users by total reservation count in this period
    top_users = df_recent['user_id'].value_counts().head(top_n).index.tolist()

    # Create week range
    week_starts = pd.date_range(start=start_date, end=end_date, freq='W-MON')
    if len(week_starts) == 0 or week_starts[0] > start_date:
        week_starts = pd.date_range(
            start=start_date, periods=weeks+1, freq='W')

    # Count reservations per user per week
    user_weekly_data = {}
    for user in top_users:
        weekly_counts = []
        user_df = df_recent[df_recent['user_id'] == user]

        for i in range(len(week_starts)):
            week_start = week_starts[i]
            week_end = week_starts[i+1] if i < len(week_starts)-1 else end_date

            count = len(user_df[
                (user_df['created_at'] >= week_start) &
                (user_df['created_at'] < week_end)
            ])
            weekly_counts.append(count)

        user_weekly_data[user] = weekly_counts

    # Adjust week_starts for plotting (use the actual week ranges we calculated)
    plot_weeks = week_starts[:len(weekly_counts)]

    # Plot
    plt.figure(figsize=(14, 7))
    colors = sns.color_palette("tab10", top_n)

    for idx, (user, counts) in enumerate(user_weekly_data.items()):
        # Shorten username (remove @domain)
        display_name = user.split('@')[0]
        plt.plot(plot_weeks, counts, marker='o', linewidth=2,
                 markersize=6, label=display_name, color=colors[idx])

    plt.title(f'Reservations Per Week - Top {top_n} Users (Last {weeks} Weeks)',
              fontsize=16, fontweight='bold')
    plt.xlabel('Week Starting', fontsize=12)
    plt.ylabel('Number of Reservations', fontsize=12)
    plt.legend(bbox_to_anchor=(1.05, 1), loc='upper left', fontsize=10)
    plt.grid(True, alpha=0.3)
    plt.gca().xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
    plt.xticks(rotation=45)
    plt.ylim(bottom=0)
    plt.tight_layout()
    plt.savefig(os.path.join(OUTPUT_DIR, 'reservations_per_user_over_time.png'),
                dpi=300, bbox_inches='tight')
    print(f"  Saved: {OUTPUT_DIR}/reservations_per_user_over_time.png")
    plt.close()


def generate_html_dashboard(stats, df, gpu_usage_plots=[]):
    """Generate HTML dashboard"""
    print("\nGenerating HTML dashboard...")

    gpu_usage_cards = ""
    for plot_file in gpu_usage_plots:
        gpu_type = plot_file.replace('usage_', '').replace('.png', '').upper()
        gpu_usage_cards += f"""
            <div class="chart-card">
                <h2 class="chart-title">{gpu_type} GPU Usage (Last 4 Weeks)</h2>
                <img src="{plot_file}" alt="{gpu_type} GPU Usage">
            </div>
        """

    html = f"""
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GPU Dev Server Analytics Dashboard</title>
    <style>
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}

        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }}

        .container {{
            max-width: 1400px;
            margin: 0 auto;
        }}

        h1 {{
            color: white;
            text-align: center;
            margin-bottom: 10px;
            font-size: 2.5em;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
        }}

        .subtitle {{
            color: rgba(255,255,255,0.9);
            text-align: center;
            margin-bottom: 30px;
            font-size: 1.1em;
        }}

        .stats-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }}

        .stat-card {{
            background: white;
            padding: 25px;
            border-radius: 12px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            transition: transform 0.2s;
        }}

        .stat-card:hover {{
            transform: translateY(-5px);
            box-shadow: 0 6px 12px rgba(0,0,0,0.15);
        }}

        .stat-value {{
            font-size: 2.5em;
            font-weight: bold;
            color: #667eea;
            margin-bottom: 5px;
        }}

        .stat-label {{
            color: #666;
            font-size: 0.9em;
            text-transform: uppercase;
            letter-spacing: 1px;
        }}

        .charts {{
            display: grid;
            gap: 20px;
        }}

        .chart-card {{
            background: white;
            padding: 20px;
            border-radius: 12px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }}

        .chart-card img {{
            width: 100%;
            height: auto;
            border-radius: 8px;
        }}

        .chart-title {{
            font-size: 1.3em;
            color: #333;
            margin-bottom: 15px;
            font-weight: 600;
        }}

        .gpu-types {{
            background: white;
            padding: 20px;
            border-radius: 12px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            margin-bottom: 20px;
        }}

        .gpu-type-item {{
            display: flex;
            justify-content: space-between;
            padding: 10px;
            border-bottom: 1px solid #eee;
        }}

        .gpu-type-item:last-child {{
            border-bottom: none;
        }}

        .footer {{
            text-align: center;
            color: rgba(255,255,255,0.8);
            margin-top: 40px;
            padding: 20px;
        }}
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 GPU Dev Server Analytics</h1>
        <p class="subtitle">Generated on {datetime.now().strftime('%B %d, %Y at %H:%M:%S')}</p>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-value">{stats['total_reservations']:,}</div>
                <div class="stat-label">Total Reservations</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">{stats['unique_users']:,}</div>
                <div class="stat-label">Unique Users</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">{stats['total_gpu_hours']:,.0f}</div>
                <div class="stat-label">Total GPU Hours</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">{len(df[df['status'] == 'active']):,}</div>
                <div class="stat-label">Currently Active</div>
            </div>
        </div>

        <div class="charts">
            {gpu_usage_cards}
            <div class="chart-card">
                <h2 class="chart-title">Unique Users Per Day</h2>
                <img src="unique_users_per_day.png" alt="Unique Users Per Day">
            </div>

            <div class="chart-card">
                <h2 class="chart-title">Unique Users Per Week</h2>
                <img src="unique_users_per_week.png" alt="Unique Users Per Week">
            </div>

            <div class="chart-card">
                <h2 class="chart-title">Reservations Per Week - Top 10 Users</h2>
                <img src="reservations_per_user_over_time.png" alt="Reservations Per User Over Time">
            </div>

            <div class="chart-card">
                <h2 class="chart-title">GPU Hours Per Day - H200 & B200</h2>
                <img src="gpu_hours_per_day_by_type.png" alt="GPU Hours Per Day by Type">
            </div>

            <div class="chart-card">
                <h2 class="chart-title">Daily Active Reservations</h2>
                <img src="daily_active_reservations.png" alt="Daily Active Reservations">
            </div>

            <div class="chart-card">
                <h2 class="chart-title">Hourly Active GPU Count</h2>
                <img src="hourly_gpu_usage.png" alt="Hourly GPU Usage">
            </div>

            <div class="chart-card">
                <h2 class="chart-title">Reservations by GPU Type</h2>
                <img src="gpu_type_distribution.png" alt="GPU Type Distribution">
            </div>

            <div class="chart-card">
                <h2 class="chart-title">Top 10 Users by GPU Hours (by Type)</h2>
                <img src="top_users_gpu_hours.png" alt="Top Users by GPU Hours">
            </div>
        </div>

        <div class="footer">
            <p>Data spans from {stats['date_range']['first'].strftime('%B %d, %Y')} to {stats['date_range']['last'].strftime('%B %d, %Y')}</p>
        </div>
    </div>
</body>
</html>
    """

    output_path = os.path.join(OUTPUT_DIR, 'dashboard.html')
    with open(output_path, 'w') as f:
        f.write(html)

    print(f"  Saved: {output_path}")


def main():
    """Main execution"""
    # Parse command-line arguments
    parser = argparse.ArgumentParser(
        description='GPU Dev Server Usage Analytics - Generate statistics and visualizations from DynamoDB reservation data'
    )
    parser.add_argument(
        '--weeks',
        type=int,
        default=4,
        help='Number of weeks to analyze (default: 4)'
    )
    args = parser.parse_args()

    print("=" * 60)
    print("GPU Dev Server Usage Analytics")
    print(f"Analyzing last {args.weeks} weeks")
    print("=" * 60)

    # Fetch data
    reservations = fetch_all_reservations()
    df = parse_reservation_data(reservations)
    gpu_availability = fetch_gpu_availability()

    if df.empty:
        print("No reservation data found!")
        return

    # Calculate statistics
    stats = calculate_statistics(df)

    print("\n" + "=" * 60)
    print("KEY STATISTICS")
    print("=" * 60)
    print(f"Total Reservations: {stats['total_reservations']:,}")
    print(f"Unique Users: {stats['unique_users']:,}")
    print(f"Total GPU Hours: {stats['total_gpu_hours']:,.0f}")
    print(
        f"Date Range: {stats['date_range']['first'].strftime('%Y-%m-%d')} to {stats['date_range']['last'].strftime('%Y-%m-%d')}")
    print(f"\nGPU Types:")
    for gpu_type, count in stats['gpu_types'].items():
        print(f"  {gpu_type}: {count}")
    print(f"\nStatus Breakdown:")
    for status, count in stats['status_breakdown'].items():
        print(f"  {status}: {count}")

    # Generate plots
    print("\n" + "=" * 60)
    print("GENERATING VISUALIZATIONS")
    print("=" * 60)
    plot_unique_users_per_day(df, weeks=args.weeks)
    plot_unique_users_per_week(df, weeks=args.weeks)
    plot_reservations_per_user_over_time(df, weeks=args.weeks)
    plot_gpu_hours_per_day_by_type(
        df, weeks=args.weeks, target_types=['h200', 'b200'])
    plot_daily_active_reservations(df, weeks=args.weeks)
    plot_hourly_gpu_usage(df, weeks=args.weeks)
    plot_gpu_type_distribution(df)
    plot_top_users_by_gpu_hours(df)
    gpu_usage_plots = plot_gpu_usage_by_type(
        df, gpu_availability, weeks=args.weeks)

    # Generate dashboard
    generate_html_dashboard(stats, df, gpu_usage_plots)

    print("\n" + "=" * 60)
    print("✅ Complete! Open dashboard.html in your browser")
    print(f"   Location: {os.path.join(OUTPUT_DIR, 'dashboard.html')}")
    print("=" * 60)


if __name__ == '__main__':
    main()
