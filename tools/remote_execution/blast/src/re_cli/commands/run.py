"""Run commands: run (single step) and run-steps (multi step)."""

import json
import os
import re
import sys
from typing import Optional

import click

from ..core.core_types import build_step_configs, console, StepConfig
from ..core.git_patch import check_uncommitted_changes
from ..core.job_runner import JobRunner
from ..core.k8s_client import K8sClient
from ..core.log_stream import _prompt_cancel_action
from . import get_client
from .query import save_to_history


# =============================================================================
# PR URL helpers
# =============================================================================


def resolve_pr_url(pr_url: str) -> tuple[str, str]:
    """Parse a GitHub PR URL and return (repo_url, head_commit_sha).

    Accepts URLs like:
        https://github.com/pytorch/pytorch/pull/12345

    Calls the GitHub API to get the head branch's latest commit SHA.
    Uses GH_TOKEN/GITHUB_TOKEN env var for authentication if available.
    """
    match = re.match(r"https?://github\.com/([^/]+)/([^/]+)/pull/(\d+)", pr_url)
    if not match:
        console.print(
            f"[red]Error: invalid PR URL: {pr_url}[/red]\n"
            "[dim]Expected format: https://github.com/owner/repo/pull/NUMBER[/dim]"
        )
        sys.exit(1)

    owner, repo_name, pr_number = match.group(1), match.group(2), match.group(3)
    api_url = f"https://api.github.com/repos/{owner}/{repo_name}/pulls/{pr_number}"

    import requests

    headers = {"Accept": "application/vnd.github.v3+json"}
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"token {token}"

    resp = requests.get(api_url, headers=headers, timeout=15)
    if resp.status_code != 200:
        console.print(
            f"[red]Error: GitHub API returned {resp.status_code} for PR #{pr_number}[/red]\n"
            f"[dim]{api_url}[/dim]"
        )
        if resp.status_code == 404:
            console.print(
                "[dim]PR not found. If this is a private repo, set GH_TOKEN.[/dim]"
            )
        sys.exit(1)

    data = resp.json()
    head_sha = data["head"]["sha"]
    head_repo = data["head"]["repo"]
    if head_repo is None:
        console.print(
            "[red]Error: PR head repo is unavailable (fork may have been deleted)[/red]"
        )
        sys.exit(1)
    repo_url = head_repo["clone_url"]
    # Strip .git suffix for consistency
    if repo_url.endswith(".git"):
        repo_url = repo_url[:-4]

    console.print(
        f"[dim]PR #{pr_number}: {data['title']}[/dim]\n"
        f"[dim]  repo: {repo_url}  commit: {head_sha[:12]}[/dim]"
    )
    return repo_url, head_sha


# =============================================================================
# Config file helpers
# =============================================================================


def load_config_file(config_path: str) -> dict:
    """Load a JSON config file for run/run-steps."""
    with open(config_path) as f:
        return json.load(f)


def build_step_configs_from_json(steps_json: list) -> list[StepConfig]:
    """Build StepConfig list from JSON config, using build_step_configs."""
    steps = []
    scripts = []
    commands = []
    types = []
    images = []
    env_vars_list = []
    depends_on = []
    additional = []

    for s in steps_json:
        steps.append(s.get("name", "step"))
        scripts.append(s.get("script", ""))
        commands.append(s.get("command", ""))
        types.append(s.get("type", "default"))
        images.append(s.get("image", ""))

        # Convert env dict to "KEY=VALUE,KEY2=VALUE2" string
        env = s.get("env", {})
        if isinstance(env, dict) and env:
            env_vars_list.append(",".join(f"{k}={v}" for k, v in env.items()))
        elif isinstance(env, str):
            env_vars_list.append(env)
        else:
            env_vars_list.append("")

        depends_on.append(s.get("depends_on", ""))
        additional.append(s.get("additional", ""))

    configs = build_step_configs(
        tuple(steps),
        tuple(scripts),
        tuple(commands),
        tuple(types),
        tuple(images),
        tuple(env_vars_list),
        tuple(depends_on),
        tuple(additional),
    )
    # Attach files from JSON config and validate they exist
    for i, s in enumerate(steps_json):
        if i < len(configs) and s.get("files"):
            for p in s["files"]:
                expanded = os.path.expanduser(p)
                if not os.path.isfile(expanded):
                    console.print(
                        f"[red]Error: file not found: {p} "
                        f"(step '{configs[i].name}')[/red]"
                    )
                    sys.exit(1)
            configs[i].files = s["files"]
    return configs


# =============================================================================
# Job execution
# =============================================================================


def execute_job(
    client: K8sClient,
    step_configs: list[StepConfig],
    name: str,
    follow: bool,
    patch: bool,
    repo_path: Optional[str],
    repo_cache: Optional[str],
    commit: Optional[str],
    repo: Optional[str],
    raw: bool,
    dry_run: bool,
    as_json: bool = False,
    no_submodule: bool = False,
    interactive: Optional[int] = None,
) -> None:
    """Shared execution logic for run and run-steps commands."""
    if patch and raw:
        console.print("[red]Error: --raw mode cannot upload patch[/red]")
        sys.exit(1)
    if patch and not repo_path:
        console.print(
            "[red]Error: --patch requires --repo-path or export LOCAL_REPO [/red]"
        )
        sys.exit(1)
    if patch and check_uncommitted_changes(repo_path):
        sys.exit(1)

    if patch and not as_json:
        console.print(
            f"[white]Patch mode with repo:[white][yellow]: {repo_path}[/yellow]"
        )

    # If --no-submodule, set runner_modules on each step to skip git_submodule
    if no_submodule:
        from ..core.script_builder import RunnerScriptBuilder

        modules_without_submodule = [
            m for m in RunnerScriptBuilder.DEFAULT_MODULES if m != "git_submodule"
        ]
        for cfg in step_configs:
            if not cfg.runner_modules:
                cfg.runner_modules = modules_without_submodule

    # If --interactive, add debug_session module and IDLE_TIMEOUT env var
    if interactive is not None:
        from ..core.script_builder import RunnerScriptBuilder

        idle_minutes = interactive if interactive > 0 else 60
        if idle_minutes > 240:
            console.print(
                "[red]Error: --interactive max is 240 minutes (4 hours)[/red]"
            )
            sys.exit(1)

        last_cfg = step_configs[-1]
        modules = last_cfg.runner_modules or list(RunnerScriptBuilder.DEFAULT_MODULES)
        # Insert debug_session before exit (after upload_outputs)
        if "debug_session" not in modules:
            idx = modules.index("exit") if "exit" in modules else len(modules)
            modules.insert(idx, "debug_session")
        last_cfg.runner_modules = modules
        last_cfg.env_vars["IDLE_TIMEOUT"] = str(idle_minutes * 60)

    runner = JobRunner(
        client=client,
        name=name,
        step_configs=step_configs,
    )
    try:
        runner.run(
            raw=raw,
            patch=patch,
            repo_path=repo_path,
            commit=commit,
            repo=repo,
            repo_cache=repo_cache,
            follow=follow if not as_json else False,
            dry_run=dry_run,
            as_json=as_json,
        )
        # JSON output after successful submission (non-dry-run)
        if as_json and not dry_run and runner.run_id:
            print(
                json.dumps(
                    {
                        "run_id": runner.run_id,
                        "name": name,
                        "artifacts_path": runner.artifacts_path,
                        "tasks": [
                            {
                                "task_id": t.task_id,
                                "step_name": t.step_name,
                                "step_index": t.step_index,
                                "task_type": t.task_type,
                                "env_vars": runner.task_requests[i].get("env_vars", {}),
                                "files": step_configs[i].files
                                if i < len(step_configs)
                                else [],
                            }
                            for i, t in enumerate(runner.tasks_info)
                        ],
                    },
                    indent=2,
                )
            )
    except KeyboardInterrupt:
        action: str = _prompt_cancel_action()
        if action == "cancel" and runner.run_id:
            try:
                client.cancel_run(runner.run_id)
                console.print(f"[yellow]○ Run {runner.run_id} cancelled[/yellow]")
            except Exception as e:
                console.print(f"[red]Failed to cancel: {e}[/red]")
        elif action == "exit":
            console.print(f"[dim]Run {runner.run_id} continues in background[/dim]")
    finally:
        # Save to history as soon as run_id exists (job submitted)
        if not dry_run and runner.run_id:
            save_to_history(runner.run_id, name, runner.tasks_info)


# =============================================================================
# Click commands
# =============================================================================


@click.command()
@click.option(
    "--config",
    "config_file",
    default=None,
    type=click.Path(exists=True),
    help="JSON config file (CLI flags override config values)",
)
@click.option("--script", "-s", default=None, help="Script file path")
@click.option(
    "--command",
    "-c",
    default=None,
    help="Direct command (alternative to --script)",
)
@click.option(
    "--type",
    "-t",
    "task_type",
    default="default",
    help="Task type: cpu, gpu, etc.",
)
@click.option("--image", "-i", default=None, help="Docker image")
@click.option(
    "--env",
    "-e",
    "env_vars",
    default=None,
    help="Environment variables (KEY=VALUE,KEY2=VALUE2)",
)
@click.option("--name", "-n", default=None, help="Job name")
@click.option("--follow", "-f", is_flag=True, help="Follow logs")
@click.option("--patch", "-p", is_flag=True, help="Include local git changes")
@click.option(
    "--no-submodule",
    is_flag=True,
    default=False,
    help="Skip git submodule update during checkout",
)
@click.option(
    "--repo-path",
    default=None,
    envvar="LOCAL_REPO",
    help="Path to local git repo",
)
@click.option(
    "--repo-cache",
    default=None,
    envvar="REPO_CACHE",
    help="Repo cache path on worker",
)
@click.option("--commit", default=None, help="Git commit SHA")
@click.option("--repo", "-r", default=None, help="Git repo URL")
@click.option(
    "--pr",
    "pr_url",
    default=None,
    help="GitHub PR URL (extracts repo + commit automatically)",
)
@click.option("--raw", is_flag=True, default=False, help="Raw mode: skip S3 upload")
@click.option("--dry-run", is_flag=True, default=False, help="Dry run")
@click.option(
    "--interactive",
    default=None,
    type=int,
    help="Keep container alive after job for N minutes (default: 60, max: 240)",
)
@click.option(
    "--files",
    multiple=True,
    type=click.Path(exists=True),
    help="Additional files to upload (available in script directory)",
)
@click.pass_context
def run_single(
    ctx,
    config_file,
    script,
    command,
    task_type,
    image,
    env_vars,
    name,
    follow,
    patch,
    no_submodule,
    repo_path,
    repo_cache,
    commit,
    repo,
    pr_url,
    raw,
    dry_run,
    interactive,
    files,
):
    """Run a single step.

    Examples:
        blast run --script build.sh --type cpu-44 --follow
        blast run --config single-step.json --follow
        blast run --pr https://github.com/pytorch/pytorch/pull/12345 -c 'python test.py' -f
    """
    as_json = ctx.obj.get("as_json", False)

    # Resolve --pr to --repo and --commit
    if pr_url:
        if repo or commit:
            console.print(
                "[red]Error: --pr cannot be used with --repo or --commit[/red]"
            )
            sys.exit(1)
        repo, commit = resolve_pr_url(pr_url)

    # Load from config file if provided
    steps_json = []
    if config_file:
        cfg = load_config_file(config_file)
        follow = follow or cfg.get("follow", False)
        patch = patch or cfg.get("patch", False)
        repo_path = repo_path or cfg.get("repo_path")
        repo_cache = repo_cache or cfg.get("repo_cache")
        commit = commit or cfg.get("commit")
        repo = repo or cfg.get("repo")
        raw = raw or cfg.get("raw", False)

        # Single step from config
        steps_json = cfg.get("steps", [])
        if steps_json:
            s = steps_json[0]
            script = script or s.get("script")
            command = command or s.get("command")
            task_type = (
                task_type if task_type != "default" else s.get("type", "default")
            )
            image = image or s.get("image")
            name = name or s.get("name")
            if not env_vars and s.get("env"):
                env_data = s["env"]
                if isinstance(env_data, dict):
                    env_vars = ",".join(f"{k}={v}" for k, v in env_data.items())

    if not script and not command:
        console.print("[red]Error: --script or --command is required[/red]")
        sys.exit(1)

    step_name = (
        name or os.path.splitext(os.path.basename(script))[0] if script else "step"
    )
    job_name = name or step_name

    step_configs = build_step_configs(
        steps=(step_name,),
        scripts=(script,) if script else (),
        commands=(command,) if command else (),
        types=(task_type,),
        images=(image,) if image else (),
        env_vars_list=(env_vars,) if env_vars else (),
        depends_on=(),
        additional=(),
    )
    # Attach files: JSON config first, then CLI --files on top
    config_files = []
    if config_file and steps_json:
        config_files = steps_json[0].get("files", [])
    all_files = config_files + list(files)
    if all_files:
        for p in all_files:
            expanded = os.path.expanduser(p)
            if not os.path.isfile(expanded):
                console.print(f"[red]Error: file not found: {p}[/red]")
                sys.exit(1)
        step_configs[0].files = all_files
    execute_job(
        get_client(ctx),
        step_configs,
        job_name,
        follow,
        patch,
        repo_path,
        repo_cache,
        commit,
        repo,
        raw,
        dry_run,
        as_json=as_json,
        no_submodule=no_submodule,
        interactive=interactive,
    )


@click.command()
@click.option(
    "--config",
    "config_file",
    default=None,
    type=click.Path(exists=True),
    help="JSON config file (CLI flags override config values)",
)
@click.option(
    "--step",
    "-S",
    "steps",
    multiple=True,
    help="Step name (use multiple times for each step)",
)
@click.option(
    "--script",
    "-s",
    "scripts",
    multiple=True,
    help="Script file path for each step (in order)",
)
@click.option(
    "--command",
    "-c",
    "commands",
    multiple=True,
    help="Direct command for each step (in order, alternative to --script)",
)
@click.option(
    "--type",
    "-t",
    "types",
    multiple=True,
    default=["default"],
    help="Task type for each step: default, cpu, gpu, gpu-l6, gpu-a10g, gpu-h100",
)
@click.option(
    "--depends-on",
    "-d",
    "depends_on",
    multiple=True,
    help="Dependency for each step: 'none' or S3 path (default: previous step)",
)
@click.option(
    "--additional",
    "-a",
    "additional",
    multiple=True,
    help="Additional artifact dependencies (task IDs or S3 paths), comma-separated",
)
@click.option(
    "--image",
    "-i",
    "images",
    multiple=True,
    help="Docker image for each step (in order)",
)
@click.option(
    "--env",
    "-e",
    "env_vars_list",
    multiple=True,
    help="Environment variable for each step in format KEY=VALUE (in order)",
)
@click.option("--name", "-n", default="multi_step_job", help="Job name")
@click.option("--follow", "-f", is_flag=True, help="Follow logs of first step")
@click.option(
    "--patch",
    "-p",
    is_flag=True,
    help="Include local git changes",
)
@click.option(
    "--no-submodule",
    is_flag=True,
    default=False,
    help="Skip git submodule update during checkout",
)
@click.option(
    "--repo-path",
    default=None,
    envvar="LOCAL_REPO",
    help="Path to local git repo for --patch",
)
@click.option(
    "--repo-cache",
    default=None,
    envvar="REPO_CACHE",
    help="Path to repo cache on worker (EFS/daemonset mounted)",
)
@click.option(
    "--commit",
    default=None,
    help="Git commit SHA to checkout",
)
@click.option(
    "--repo",
    "-r",
    default=None,
    help="Git repo URL",
)
@click.option(
    "--pr",
    "pr_url",
    default=None,
    help="GitHub PR URL (extracts repo + commit automatically)",
)
@click.option(
    "--raw",
    is_flag=True,
    default=False,
    help="Raw mode: put script content directly in command, skip S3 upload",
)
@click.option(
    "--dry-run",
    is_flag=True,
    default=False,
    help="Dry run: show what would be uploaded without executing",
)
@click.option(
    "--interactive",
    default=None,
    type=int,
    help="Keep container alive after job for N minutes (default: 60, max: 240)",
)
@click.option(
    "--files",
    "files_list",
    multiple=True,
    help="Files for each step (comma-separated, in order). e.g. --files 'a.txt,b.txt' --files 'c.txt'",
)
@click.pass_context
def run_steps(
    ctx,
    config_file,
    steps,
    scripts,
    commands,
    types,
    images,
    env_vars_list,
    name,
    follow,
    patch,
    no_submodule,
    repo_path,
    repo_cache,
    commit,
    repo,
    pr_url,
    raw,
    dry_run,
    depends_on,
    additional,
    interactive,
    files_list,
):
    """Run multiple steps in sequence.

    Examples:
        blast run-steps --config job.json --follow
        blast run-steps \\
            --step build --script ./build.sh --type cpu \\
            --step test --script ./test.sh --type gpu-l6 \\
            --follow
        blast run-steps --pr https://github.com/pytorch/pytorch/pull/12345 --config job.json
    """
    as_json = ctx.obj.get("as_json", False)

    # Resolve --pr to --repo and --commit
    if pr_url:
        if repo or commit:
            console.print(
                "[red]Error: --pr cannot be used with --repo or --commit[/red]"
            )
            sys.exit(1)
        repo, commit = resolve_pr_url(pr_url)

    # Load from config file if provided, and override CLI flags if present
    if config_file:
        cfg = load_config_file(config_file)
        # CLI flags override config values
        follow = follow or cfg.get("follow", False)
        patch = patch or cfg.get("patch", False)
        repo_path = repo_path or cfg.get("repo_path")
        repo_cache = repo_cache or cfg.get("repo_cache")
        commit = commit or cfg.get("commit")
        repo = repo or cfg.get("repo")
        raw = raw or cfg.get("raw", False)
        name = name if name != "multi_step_job" else cfg.get("name", "multi_step_job")

    # Build step configs from config file or CLI flags
    if config_file and "steps" in cfg and not steps:
        step_configs = build_step_configs_from_json(cfg["steps"])
    elif steps:
        step_configs = build_step_configs(
            steps,
            scripts,
            commands,
            types,
            images,
            env_vars_list,
            depends_on,
            additional,
        )
    else:
        console.print("[red]Error: provide --step flags or --config with steps[/red]")
        sys.exit(1)

    # Attach --files to each step (comma-separated per step, in order)
    if files_list:
        for i, files_str in enumerate(files_list):
            if i >= len(step_configs):
                break
            paths = [p.strip() for p in files_str.split(",") if p.strip()]
            for p in paths:
                expanded = os.path.expanduser(p)
                if not os.path.isfile(expanded):
                    console.print(f"[red]Error: file not found: {p}[/red]")
                    sys.exit(1)
            step_configs[i].files.extend(paths)

    execute_job(
        get_client(ctx),
        step_configs,
        name,
        follow,
        patch,
        repo_path,
        repo_cache,
        commit,
        repo,
        raw,
        dry_run,
        as_json=as_json,
        no_submodule=no_submodule,
        interactive=interactive,
    )
