# GPU Dev Server Analytics

Admin tools for generating usage statistics and dashboards.

## Setup

```bash
cd admin
pip install -r requirements.txt
```

## Usage

Generate analytics dashboard:

```bash
python generate_stats.py
```

This will:

1. Fetch all reservation data from DynamoDB
2. Generate statistics including:
   - Total number of reservations ever
   - Number of unique users
   - Daily active reservations (last 8 weeks)
   - Hourly GPU usage (last 8 weeks)
   - GPU type distribution
   - Top 10 users
3. Create visualizations (PNG files)
4. Generate an HTML dashboard

## Output

All output is saved to `admin/output/`:

- `dashboard.html` - Main dashboard (open in browser)
- `daily_active_reservations.png` - Daily active reservation chart
- `hourly_gpu_usage.png` - Hourly GPU usage chart
- `gpu_type_distribution.png` - GPU type breakdown
- `top_users.png` - Top users by reservation count

## Configuration

Set these environment variables if needed:

- `AWS_REGION` - AWS region (default: us-east-2)
- `RESERVATIONS_TABLE` - DynamoDB table name (default: pytorch-gpu-dev-reservations)

Your AWS credentials must have read access to the DynamoDB reservations table.
