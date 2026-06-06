# hud CLI

CLI over the PyTorch HUD APIs, for humans (tables) and agents (`--json`).

## Setup

```bash
gh auth login
ln -s "$(pwd)/hud" ~/.local/bin/hud
hud login              # also sets up gcx for dashboards (optional)
```

Reuses your GitHub token (`gh auth token`) against the authed shim
(`/api/authed/*`).

## Commands

```bash
hud trunk --days 1
hud pr 12345
hud user wdvr
hud query <name> -p key=value      # any saved ClickHouse query
```

Add `--json` to any command for agent output.

## Authed shim

`pages/api/authed/[...path].ts` mirrors `/api/*`: it validates the GitHub token
(bad token -> 401), then forwards with the internal bypass header. Requires two
Vercel firewall bypass rules: path `/api/authed/`, and header
`x-hud-internal-bot`.
