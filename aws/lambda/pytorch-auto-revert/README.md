# PyTorch Auto Revert

A tool for detecting autorevert patterns in PyTorch CI workflows.

## Installation

1. Navigate to the project directory:
```bash
cd test-infra/aws/lambda/pytorch-auto-revert
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

## Configuration

Set the following environment variables or pass them as command-line arguments:

### Required:
- **ClickHouse connection:**
  - `CLICKHOUSE_HOST` (or `--clickhouse-host`)
  - `CLICKHOUSE_USERNAME` (or `--clickhouse-username`)
  - `CLICKHOUSE_PASSWORD` (or `--clickhouse-password`)

- **GitHub credentials (one of):**
  - `GITHUB_TOKEN` (or `--github-access-token`)
  - GitHub App credentials:
    - `GITHUB_APP_ID` (or `--github-app-id`)
    - `GITHUB_APP_SECRET` (or `--github-app-secret`)
    - `GITHUB_INSTALLATION_ID` (or `--github-installation-id`)

### Optional:
- `CLICKHOUSE_PORT` (default: 8443)
- `CLICKHOUSE_DATABASE` (default: default)
- `LOG_LEVEL` (default: INFO)

## Usage

Run the autorevert checker from the project directory:

```bash
python -m pytorch_auto_revert autorevert-checker <workflows> [options]
```

### Parameters:
- `workflows`: One or more workflow names (space separated)
- `--hours`: Lookback window in hours (default: 48)
- `--verbose` or `-v`: Show detailed output including commit summaries

### Examples:

1. **Single workflow with default 48-hour lookback:**
```bash
python -m pytorch_auto_revert autorevert-checker pull
```

2. **Single workflow with custom lookback:**
```bash
python -m pytorch_auto_revert autorevert-checker trunk --hours 72
```

3. **Multiple workflows (space separated):**
```bash
python -m pytorch_auto_revert autorevert-checker pull trunk inductor --hours 24
```

4. **With verbose output:**
```bash
python -m pytorch_auto_revert autorevert-checker pull --hours 48 --verbose
```

5. **With explicit credentials:**
```bash
python -m pytorch_auto_revert autorevert-checker pull \
  --clickhouse-host your-host \
  --clickhouse-username your-user \
  --clickhouse-password your-pass \
  --github-access-token your-token
```

## Other Commands

The tool also supports:
- `workflow-restart-checker`: Check for restarted workflows
- `do-restart`: Restart a workflow for a specific commit

Run with `--help` for more information:
```bash
python -m pytorch_auto_revert --help
```

## Rendering HUD HTML

- Add `--hud-html` (optionally with a filepath) to `autorevert-checker` to dump the
  run state as a HUD-style HTML grid alongside the regular ClickHouse logging:
  ```bash
  python -m pytorch_auto_revert autorevert-checker pull trunk --hud-html results.html
  ```

- Render historical runs from ClickHouse by timestamp with the `hud` subcommand:
  ```bash
  python -m pytorch_auto_revert hud "2025-09-17 20:29:15" --repo-full-name pytorch/pytorch --hud-html hud.html
  ```

- If you run multiple autorevert configs and want a specific one, filter by workflow name present in the stored run state:
  ```bash
  python -m pytorch_auto_revert hud --workflow trunk --repo-full-name pytorch/pytorch --hud-html hud.html
  ```
