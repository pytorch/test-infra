"""Core data types and utility functions for the Remote Execution CLI."""

import os
import sys
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

from rich.console import Console


# centralized console for all CLI output
console = Console()

STATUS_COLORS = {
    "created": "yellow",
    "preparing": "yellow",
    "queued": "yellow",
    "scheduling": "blue",
    "running": "blue",
    "completed": "green",
    "failed": "red",
    "cancelled": "red",
    "cancelling": "yellow",
}


def get_status_color(status: str) -> str:
    """Get the display color for a task status."""
    return STATUS_COLORS.get(status, "white")


@dataclass
class StepConfig:
    """Configuration for a single step."""

    name: str
    script: Optional[str] = None
    command: Optional[str] = None
    task_type: str = "default"
    image: Optional[str] = None
    env_vars: dict = field(default_factory=dict)
    depends_on: Optional[str] = None
    additional: Optional[str] = None
    runner_modules: Optional[list[str]] = None  # e.g. ["header", "run_script"]

    def get_command(self, raw_mode: bool = False) -> str:
        """Get the command to run for this step.
        Args:
            raw_mode: If True and script is not a file, use script as command
        """
        if self.script:
            script_path = os.path.expanduser(self.script)
            if os.path.isfile(script_path):
                with open(script_path, "r") as f:
                    return f.read()
            elif raw_mode:
                # In raw mode, use script as command directly
                return self.script
            else:
                # Not raw mode and not a file - error
                raise FileNotFoundError(f"Script file not found: {self.script}")
        return self.command or ""

    def get_script_name(self, index: int) -> str:
        """Get the script name for this step."""
        if self.script:
            return os.path.basename(self.script)
        return f"step_{index}_{self.name}.sh"


@dataclass
class TaskInfo:
    """Information about a task in a multi-step job."""

    task_id: str
    step_index: int
    step_name: str
    dependency: int
    task_type: str
    image: Optional[str] = None
    command: Optional[str] = None
    script_name: Optional[str] = None


@dataclass
class JobInfo:
    """Information about a multi-step job (stored in S3 as job.json)."""

    run_id: str  # Use run_id as the job identifier
    name: str
    tasks: List[TaskInfo]
    artifacts_path: str
    created_at: str
    patch_info: Optional[Dict[str, Any]] = None
    status: str = "pending"

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "run_id": self.run_id,
            "name": self.name,
            "tasks": [asdict(t) for t in self.tasks],
            "artifacts_path": self.artifacts_path,
            "created_at": self.created_at,
            "patch_info": self.patch_info,
            "status": self.status,
        }


def compute_topo_deps(num_steps: int) -> list:
    """Compute topological dependencies for sequential steps.

    For sequential execution (step 0 -> step 1 -> step 2):
    - step 0: ready immediately (dep = 0)
    - step 1: waits for step 0 (dep = 1)
    - step 2: waits for step 1 (dep = 1)

    Each step depends on exactly the previous step completing.
    We only queue step 0 initially, and each completion queues the next.
    """
    if num_steps == 1:
        return [0]
    return [0 if i == 0 else 1 for i in range(num_steps)]


def parse_env_var(env_str: str) -> dict:
    """Parse KEY=VALUE environment variable string.

    Supports multiple env vars separated by comma:
    - Single: "KEY=VALUE"
    - Multiple: "KEY1=VALUE1,KEY2=VALUE2"
    - With quotes: "KEY='value with spaces'" or 'KEY="value"'

    Note: Values can contain spaces. Quotes around values are stripped.
    """
    result = {}
    for part in env_str.split(","):
        part = part.strip()
        if "=" in part:
            key, value = part.split("=", 1)
            key = key.strip()
            value = value.strip()
            # Strip surrounding quotes from value
            if (value.startswith("'") and value.endswith("'")) or (
                value.startswith('"') and value.endswith('"')
            ):
                value = value[1:-1]
            result[key] = value
    return result


def build_step_configs(
    steps: tuple,
    scripts: tuple,
    commands: tuple,
    types: tuple,
    images: tuple,
    env_vars_list: tuple,
    depends_on: tuple,
    additional: tuple,
) -> list[StepConfig]:
    """Build step configurations from CLI arguments.
    Args:
        steps: Tuple of step names
        scripts: Tuple of script paths
        commands: Tuple of command strings
        types: Tuple of task types
        images: Tuple of Docker images
        env_vars_list: Tuple of environment variable strings (KEY=VALUE)
        depends_on: Tuple of dependency specifications
        additional: Tuple of additional artifact paths
    Returns:
        List of StepConfig objects

    Note on env_vars_list:
        Each -e flag corresponds to one step (in order).
        Multiple env vars can be specified in one -e using comma separation:
        -e "KEY1=VALUE1,KEY2=VALUE2,KEY3=VALUE3"
    """
    step_configs = []

    for i, step_name in enumerate(steps):
        script_path = scripts[i] if i < len(scripts) else None
        command_str = commands[i] if i < len(commands) else None
        task_type = types[i] if i < len(types) else types[0] if types else "default"
        image = images[i] if i < len(images) else images[0] if images else None

        # Parse env vars for this step (one -e per step, comma-separated)
        step_env = {}
        if i < len(env_vars_list):
            step_env = parse_env_var(env_vars_list[i])

        # Get depends_on for this step
        step_depends_on = None
        if i < len(depends_on):
            step_depends_on = depends_on[i] if depends_on[i] else None

        # Get additional dependencies for this step
        step_additional = None
        if i < len(additional):
            step_additional = additional[i] if additional[i] else None

        if not script_path and not command_str:
            console.print(
                f"[red]Error: Step '{step_name}' needs either --script or --command[/red]"
            )
            sys.exit(1)

        config = StepConfig(
            name=step_name,
            script=script_path,
            command=command_str,
            task_type=task_type,
            image=image,
            env_vars=step_env,
            depends_on=step_depends_on,
            additional=step_additional,
        )
        step_configs.append(config)

    return step_configs
