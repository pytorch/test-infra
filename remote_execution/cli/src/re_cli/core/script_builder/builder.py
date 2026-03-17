"""Modular runner script builder for Blast CLI.

Two main outputs:
1. Bootstrap script - constant, used by Kube Pod command (downloads inputs + sources runner.sh)
2. Runner script - customizable, uploaded to S3 (git clone, run script, upload outputs, etc.)
"""

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import List, Optional


class GitCloneMethod(Enum):
    """Git clone methods for caching."""

    REFERENCE = "reference"  # git clone --reference
    COPY = "copy"  # cp -r from cache
    FULL = "full"  # Full git clone (no cache)


@dataclass
class GitCloneConfig:
    """Configuration for git cloning strategy."""

    use_cache: bool = True
    method: GitCloneMethod = GitCloneMethod.REFERENCE
    submodule_sync: bool = True
    submodule_recursive: bool = True
    cache_path: str = "/var/cache/git/pytorch"
    cache_repo_pattern: str = "pytorch/pytorch"


@dataclass
class RunnerConfig:
    """Configuration for runner script generation."""

    script_name: str
    step_name: str
    git_config: GitCloneConfig = field(default_factory=GitCloneConfig)

    # Feature flags
    checkout_git_commit: bool = True
    apply_git_patch: bool = True
    upload_outputs: bool = True


# Template directory path
TEMPLATES_DIR = Path(__file__).parent / "templates"


def _load_template(name: str, subdir: str = "") -> str:
    """Load a template file from the templates directory."""
    if subdir:
        template_path = TEMPLATES_DIR / subdir / f"{name}.sh"
    else:
        template_path = TEMPLATES_DIR / f"{name}.sh"
    if not template_path.exists():
        raise FileNotFoundError(f"Template not found: {template_path}")
    return template_path.read_text()


def _render_template(template: str, **kwargs) -> str:
    """Render a template with variable substitution.

    Uses {{variable}} syntax for placeholders.
    """
    result = template
    for key, value in kwargs.items():
        result = result.replace(f"{{{{{key}}}}}", str(value))
    return result


# =============================================================================
# Bootstrap Script - Constant (used by Kube Pod command)
# =============================================================================


def create_bootstrap(artifacts_path: str) -> str:
    """Create bootstrap script for Kube Pod command.

    This is a constant script that:
    1. Downloads inputs.zip from S3
    2. Extracts to /tmp/artifacts
    3. Sources runner.sh from the extracted artifacts

    Args:
        artifacts_path: S3 path to artifacts (e.g., "s3://bucket/runs/123/")

    Returns:
        Bootstrap script content
    """
    template = _load_template("bootstrap")
    return "#!/bin/bash\nset -e\n\n" + _render_template(
        template,
        artifacts_path=artifacts_path,
    )


# =============================================================================
# Runner Script Builder - Customizable (uploaded to S3)
# =============================================================================


class RunnerScriptBuilder:
    """Modular builder for runner scripts.

    The runner script is uploaded to S3 and sourced by the bootstrap script.
    It handles: git operations, running user script, uploading outputs.

    Example usage:
        # Default runner (all modules)
        script = RunnerScriptBuilder.create_default(
            script_name="build.sh",
            step_name="build",
        )

        # Custom runner with selected modules
        script = RunnerScriptBuilder.create_from_modules(
            modules=["header", "find_script", "run_script", "upload_outputs"],
            script_name="test.sh",
            step_name="test",
        )

        # Full manual control
        config = RunnerConfig(
            script_name="test.sh",
            step_name="test",
            git_config=GitCloneConfig(method=GitCloneMethod.COPY),
            apply_git_patch=False,
        )
        builder = RunnerScriptBuilder(config)
        script = (
            builder
            .add_header()
            .add_find_script()
            .add_run_script()
            .add_upload_outputs()
            .build()
        )
    """

    def __init__(self, config: RunnerConfig):
        self.config = config
        self._modules: List[str] = []

    def _add_module(
        self, name: str, subdir: str = "", **kwargs
    ) -> "RunnerScriptBuilder":
        """Load and add a template module."""
        template = _load_template(name, subdir=subdir)
        rendered = _render_template(template, **kwargs)
        self._modules.append(
            f"\n# {'=' * 44}\n# MODULE: {name}\n# {'=' * 44}\n{rendered}"
        )
        return self

    def add_header(self) -> "RunnerScriptBuilder":
        """Add script header and basic setup."""
        template = _load_template("header")
        rendered = _render_template(
            template,
            script_name=self.config.script_name,
        )
        self._modules.append(rendered)
        return self

    def add_find_script(self) -> "RunnerScriptBuilder":
        """Add module to find the user script."""
        return self._add_module("find_script")

    def add_read_config(self) -> "RunnerScriptBuilder":
        """Add module to read git config from job.json."""
        if not self.config.apply_git_patch:
            return self
        return self._add_module("read_config")

    def add_git_clone(self) -> "RunnerScriptBuilder":
        """Add module for git clone with configurable caching strategy."""
        if not self.config.apply_git_patch:
            return self

        cfg = self.config.git_config

        # Select git clone method template
        if cfg.use_cache:
            if cfg.method == GitCloneMethod.REFERENCE:
                template_name = "git_clone_reference"
            else:
                template_name = "git_clone_copy"

            method_template = _load_template(
                template_name, subdir="git_templates"
            )
            git_clone_method = _render_template(
                method_template,
                cache_path=cfg.cache_path,
                cache_repo_pattern=cfg.cache_repo_pattern,
            )
        else:
            # No cache - simple clone
            git_clone_method = """
echo "[Runner] Cloning $GIT_REPO..."
git clone "$GIT_REPO" repo
cd repo
REPO_DIR="$(pwd)"
export REPO_DIR
"""

        # Load git_clone template and render
        git_clone_template = _load_template(
            "git_clone", subdir="git_templates"
        )
        rendered = _render_template(
            git_clone_template,
            git_clone_method=git_clone_method,
        )

        self._modules.append(
            f"\n# {'=' * 44}\n# MODULE: git_clone\n# {'=' * 44}\n{rendered}"
        )
        return self

    def add_git_checkout(self) -> "RunnerScriptBuilder":
        """Add module to checkout specific commit."""
        if (
            not self.config.checkout_git_commit
            and not self.config.apply_git_patch
        ):
            return self
        return self._add_module("git_checkout", subdir="git_templates")

    def add_git_submodule(self) -> "RunnerScriptBuilder":
        """Add module to update submodules with cache support."""
        cfg = self.config.git_config

        # Build submodule commands for fallback (no cache)
        fallback_cmds = []
        if cfg.submodule_sync:
            fallback_cmds.append("        git submodule sync --recursive")
        fallback_cmd = "        git submodule update --init"
        if cfg.submodule_recursive:
            fallback_cmd += " --recursive"
        fallback_cmds.append(fallback_cmd)
        fallback_commands = "\n".join(fallback_cmds)

        template = _load_template("git_submodule")
        rendered = _render_template(
            template, submodule_commands=fallback_commands
        )

        self._modules.append(
            f"\n# {'=' * 44}\n# MODULE: git_submodule\n# {'=' * 44}\n{rendered}"
        )
        return self

    def add_git_apply_patch(self) -> "RunnerScriptBuilder":
        """Add module to apply git patch after clone."""
        if not self.config.apply_git_patch:
            return self
        return self._add_module("git_apply_patch", subdir="git_templates")

    def add_run_script(self) -> "RunnerScriptBuilder":
        """Add module to run the user script."""
        return self._add_module("run_script")

    def add_upload_outputs(self) -> "RunnerScriptBuilder":
        """Add module to upload outputs to S3."""
        if not self.config.upload_outputs:
            return self
        return self._add_module("upload_outputs")

    def build(self) -> str:
        """Build the complete runner script."""
        return "\n".join(self._modules)

    # All available modules in default order
    DEFAULT_MODULES = [
        "header",
        "find_script",
        "read_config",
        "git_clone",
        "git_checkout",
        "git_submodule",
        "git_apply_patch",
        "run_script",
        "upload_outputs",
    ]

    @classmethod
    def create_default(
        cls,
        script_name: str,
        step_name: str,
        git_config: Optional[GitCloneConfig] = None,
        apply_git_patch: bool = True,
    ) -> str:
        """Create a runner script with all default modules.

        Args:
            script_name: Name of the user script to run (e.g., "build.sh")
            step_name: Step name for logging
            git_config: Git clone configuration
            apply_git_patch: Whether to apply git patch

        Returns:
            Runner script content (to be uploaded to S3)
        """
        return cls.create_from_modules(
            modules=cls.DEFAULT_MODULES,
            script_name=script_name,
            step_name=step_name,
            git_config=git_config,
            apply_git_patch=apply_git_patch,
        )

    @classmethod
    def create_from_modules(
        cls,
        modules: list[str],
        script_name: str,
        step_name: str,
        git_config: Optional[GitCloneConfig] = None,
        apply_git_patch: bool = True,
    ) -> str:
        """Create a runner script with selected modules.

        Args:
            modules: List of module names to include (e.g. ["header", "run_script"])
            script_name: Name of the user script to run
            step_name: Step name for logging
            git_config: Git clone configuration
            apply_git_patch: Whether to apply git patch

        Returns:
            Runner script content (to be uploaded to S3)
        """
        config = RunnerConfig(
            script_name=script_name,
            step_name=step_name,
            git_config=git_config or GitCloneConfig(),
            apply_git_patch=apply_git_patch,
        )

        builder = cls(config)
        for module in modules:
            method = getattr(builder, f"add_{module}", None)
            if method is None:
                raise ValueError(
                    f"Unknown module '{module}'. "
                    f"Available: {cls.DEFAULT_MODULES}"
                )
            method()
        return builder.build()
