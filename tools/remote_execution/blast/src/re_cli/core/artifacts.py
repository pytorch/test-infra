"""Artifact building, packaging, and upload for the Remote Execution CLI."""

import time
from typing import Optional, Type

from .core_types import console, StepConfig, TaskInfo
from .script_builder import create_bootstrap, GitCloneConfig, RunnerScriptBuilder


def build_artifacts_metadata(
    run_id: str,
    name: str,
    artifacts_path: str,
    step_configs: list[StepConfig],
    tasks_info: list[TaskInfo],
    patch_metadata: Optional[dict] = None,
    commit: Optional[str] = None,
    repo: Optional[str] = None,
    script_builder_class: Optional[Type] = None,
) -> dict:
    """Build all artifact data for upload or dry-run preview.

    Returns:
        Dictionary with:
        - task_configs: list of task config dicts
        - job_info: job.json dict
        - scripts: list of (task_id, script_name, script_content, runner_content)
    """
    # Determine git info
    if patch_metadata:
        git_repo = patch_metadata.get("remote_url", "") or repo or ""
        git_commit = patch_metadata.get("base_commit", "") or commit or ""
    else:
        git_repo = repo or ""
        git_commit = commit or ""

    builder_cls = script_builder_class or RunnerScriptBuilder

    # Build task configs
    task_configs = []
    scripts: list[dict[str, Optional[str]]] = []
    for i, cfg in enumerate(step_configs):
        task_info = tasks_info[i]
        script_name = task_info.script_name or cfg.get_script_name(i)
        script_content = cfg.get_command()
        if cfg.runner_modules:
            runner_content = builder_cls.create_from_modules(
                modules=cfg.runner_modules,
                script_name=script_name,
                step_name=task_info.step_name,
            )
        else:
            runner_content = builder_cls.create_default(
                script_name=script_name,
                step_name=task_info.step_name,
            )

        task_configs.append(
            {
                "task_id": task_info.task_id,
                "run_id": run_id,
                "step_index": task_info.step_index,
                "step_name": task_info.step_name,
                "dependency": task_info.dependency,
                "task_type": task_info.task_type,
                "image": task_info.image,
                "script_name": script_name,
                "artifacts_path": artifacts_path,
            }
        )

        scripts.append(
            {
                "task_id": task_info.task_id,
                "script_name": script_name,
                "script_content": script_content,
                "runner_content": runner_content,
            }
        )

    # Build job info
    job_info = {
        "run_id": run_id,
        "name": name,
        "tasks": [
            {
                "task_id": t.task_id,
                "step_index": t.step_index,
                "step_name": t.step_name,
                "dependency": t.dependency,
                "task_type": t.task_type,
                "image": t.image,
                "script_name": t.script_name,
            }
            for t in tasks_info
        ],
        "artifacts_path": artifacts_path,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "pending",
        "git_repo": git_repo,
        "git_commit": git_commit,
        "patch_info": patch_metadata,
    }

    return {
        "task_configs": task_configs,
        "job_info": job_info,
        "scripts": scripts,
    }


def upload_artifacts_to_s3(
    client,
    run_id: str,
    artifacts_path: str,
    artifact_data: dict,
    patch_metadata: Optional[dict] = None,
    signed_url: Optional[str] = None,
):
    """Upload scripts and job data to S3 as a single ZIP.

    Args:
        client: CRD client
        run_id: Run ID
        artifacts_path: S3 path for artifacts
        artifact_data: Pre-built data from build_artifacts_metadata()
        patch_metadata: Optional patch metadata dict (for patch file)
        signed_url: Optional pre-existing signed URL (avoids extra CRD call)
    """
    import json
    import os
    import tempfile
    import zipfile

    console.print("[blue]Packing scripts and metadata...[/blue]")

    # Create a temporary directory to organize files
    with tempfile.TemporaryDirectory() as temp_dir:
        # Create directory structure in temp dir
        scripts_dir = os.path.join(temp_dir, "scripts")
        tasks_dir = os.path.join(temp_dir, "tasks")
        os.makedirs(scripts_dir)
        os.makedirs(tasks_dir)

        # Write scripts
        for script_data in artifact_data["scripts"]:
            task_id = script_data["task_id"]
            task_scripts_dir = os.path.join(scripts_dir, str(task_id))
            os.makedirs(task_scripts_dir)

            # Write step script
            script_path = os.path.join(task_scripts_dir, script_data["script_name"])
            with open(script_path, "w") as f:
                f.write(script_data["script_content"])

            # Write runner.sh
            runner_path = os.path.join(task_scripts_dir, "runner.sh")
            with open(runner_path, "w") as f:
                f.write(script_data["runner_content"])

        # Write task configs
        for task_config in artifact_data["task_configs"]:
            task_json_path = os.path.join(
                tasks_dir, f"task_{task_config['task_id']}.json"
            )
            with open(task_json_path, "w") as f:
                json.dump(task_config, f, indent=2)

        # Write patch file if patch mode was used
        if patch_metadata and patch_metadata.get("patch_content"):
            git_changes_dir = os.path.join(temp_dir, "git-changes")
            os.makedirs(git_changes_dir, exist_ok=True)
            patch_file_path = os.path.join(git_changes_dir, "changes.patch")
            with open(patch_file_path, "w", encoding="utf-8") as f:
                f.write(patch_metadata["patch_content"])
            # Remove patch_content from metadata (don't store in job.json)
            del patch_metadata["patch_content"]

        # Write job.json
        job_json_path = os.path.join(temp_dir, "job.json")
        with open(job_json_path, "w") as f:
            json.dump(artifact_data["job_info"], f, indent=2)

        # Create ZIP file
        zip_path = os.path.join(temp_dir, "inputs.zip")
        zip_contents = []  # Track files for display
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            # Add all files from temp_dir to ZIP
            for root, _dirs, files in os.walk(temp_dir):
                for file in files:
                    if file == "inputs.zip":
                        continue  # Skip the zip itself
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, temp_dir)
                    zf.write(file_path, arcname)
                    zip_contents.append(arcname)

        # Display ZIP structure
        zip_size = os.path.getsize(zip_path)
        console.print(f"[cyan]inputs.zip[/cyan] ({zip_size:,} bytes):")

        zip_contents.sort()
        for i, path in enumerate(zip_contents):
            is_last = i == len(zip_contents) - 1
            prefix = "└── " if is_last else "├── "
            console.print(f"  [grey50]{prefix}{path}[/grey50]")

        # Upload single ZIP file
        console.print("[blue]Uploading...[/blue]")
        upload_file(
            zip_path,
            signed_url=signed_url,
        )
        console.print("  [green]✓[/green] inputs.zip uploaded")

    console.print(f"[blue]Artifacts:[/blue] {artifacts_path}")


def upload_file(file_path: str, signed_url: Optional[str]) -> None:
    """Upload a file to S3 using a presigned URL.

    Args:
        file_path: Local file path to upload
        signed_url: Presigned URL for S3 upload
    """
    import requests

    if not signed_url:
        raise RuntimeError("signed_url is required")

    with open(file_path, "rb") as f:
        response = requests.put(
            signed_url,
            data=f,
            headers={"Content-Type": "application/zip"},
        )
        response.raise_for_status()


def build_task_requests(
    artifacts_path: str,
    step_configs: list[StepConfig],
    tasks_info: list[TaskInfo],
    repo_cache: Optional[str] = "/var/cache/git/pytorch",
    raw_mode: bool = False,
    commit: Optional[str] = None,
    repo: Optional[str] = None,
    run_id: Optional[str] = None,
) -> list[dict]:
    """Build task update records with runner commands.

    Args:
        artifacts_path: S3 artifacts path
        step_configs: List of StepConfig objects
        tasks_info: List of TaskInfo objects
        repo_cache: Optional repo cache path
        raw_mode: If True, use command directly without runner script
        commit: Git commit SHA
        repo: Git repo URL
        run_id: Run ID

    Returns:
        List of task update dictionaries
    """
    num_tasks = len(tasks_info)
    task_requests = []

    for i, task_info in enumerate(tasks_info):
        if raw_mode:
            # Raw mode: use command directly
            command = task_info.command or step_configs[i].get_command(raw_mode=True)
        else:
            # Normal mode: use bootstrap script that downloads runner.sh from S3
            command = create_bootstrap(artifacts_path=artifacts_path)

        # Build env vars: all task config goes here
        env_vars = {
            "RUN_ID": str(run_id) if run_id else "<run_id>",
            "TASK_ID": str(task_info.task_id),
            "STEP_INDEX": str(task_info.step_index),
            "STEP_NAME": task_info.step_name,
            "TOTAL_STEPS": str(num_tasks),
        }
        if artifacts_path:
            env_vars["ARTIFACTS_PATH"] = artifacts_path
        if commit:
            env_vars["GIT_COMMIT"] = commit
        if repo:
            env_vars["GIT_REPO"] = repo
        if repo_cache:
            env_vars["REPO_CACHE"] = repo_cache

        # Handle depends_on:
        # - Default (None): depend on previous step if not first
        # - "none": no dependency on previous step
        # - S3 path: explicit cross-run dependency
        depends_on_value = step_configs[i].depends_on
        prev_task_id = None

        if depends_on_value and depends_on_value.lower() == "none":
            # Explicitly no dependency on previous step
            pass
        elif depends_on_value and depends_on_value.startswith("s3://"):
            # Explicit S3 path (cross-run dependency)
            env_vars["DEPENDENT_ARTIFACTS_PATH"] = depends_on_value
        elif i > 0:
            # Default: depend on previous step
            prev_task_id = tasks_info[i - 1].task_id
            dep_path = f"{artifacts_path}outputs/{prev_task_id}/"
            env_vars["DEPENDENT_ARTIFACTS_PATH"] = dep_path

        # Handle additional dependencies
        additional_value = step_configs[i].additional
        if additional_value:
            # Parse additional: must be S3 paths
            additional_paths = []
            for item in additional_value.split(","):
                item = item.strip()
                if item.startswith("s3://"):
                    additional_paths.append(item)
                else:
                    console.print(
                        f"[yellow]Warning: --additional '{item}' "
                        "is not an S3 path, skipping.[/yellow]"
                    )
                    console.print(
                        "[yellow]Use full S3 path like: "
                        "s3://bucket/runs/R123/outputs/T456/[/yellow]"
                    )
            if additional_paths:
                env_vars["ADDITIONAL_ARTIFACTS_PATHS"] = ",".join(additional_paths)

        # Add user-defined env vars (per step) - last so they can override
        env_vars.update(step_configs[i].env_vars)

        # Simplified task_update: only task_id, command, env_vars, prev_task_id
        task_update = {
            "task_id": task_info.task_id,
            "command": command,
            "env_vars": env_vars,
        }

        # prev_task_id is for job-watcher dependency management
        if prev_task_id:
            task_update["prev_task_id"] = prev_task_id

        task_requests.append(task_update)

    return task_requests


def create_runner_script(
    script_name: str,
    step_name: str,
    git_config: Optional[GitCloneConfig] = None,
) -> str:
    """Create the runner script that executes on the worker.

    This is a convenience wrapper around RunnerScriptBuilder.create_default().
    """
    return RunnerScriptBuilder.create_default(
        script_name=script_name,
        step_name=step_name,
        git_config=git_config,
    )
