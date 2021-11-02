#!/usr/bin/env python3

from pathlib import Path

import jinja2
import os
from dataclasses import dataclass
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent.parent
GITHUB_DIR = REPO_ROOT / ".github"

CRONS = {
    "5 minutes": "*/5 * * * *",
    "1 hour": "0 * * * *",
}


@dataclass
class Branch:
    branch: str
    cron: str = CRONS["1 hour"]
    fetch_size: int = 4
    history_size: int = 100


HUD_JOBS = {
    "pytorch": {
        "pytorch": [
            Branch(branch="master", fetch_size=2, cron=CRONS["5 minutes"]),
            Branch(branch="nightly", fetch_size=2),
            Branch(branch="release/1.10", fetch_size=2),
            Branch(branch="viable/strict", fetch_size=2),
        ],
        "vision": [Branch(branch="main"), Branch(branch="release/0.11")],
        "audio": [Branch(branch="main"), Branch(branch="release/0.10")],
        "text": [Branch(branch="main"), Branch(branch="release/0.11")],
        "examples": [Branch(branch="master")],
        "tutorials": [Branch(branch="master")],
        "torchx": [Branch(branch="main")],
    },
    "PyTorchLightning": {"pytorch-lightning": [Branch(branch="master")]},
}


class CIWorkflow:
    name: str
    template: str

    def __init__(self, name: str, template: str, **kwargs: Any) -> None:
        self.name = name
        self.template = template
        for key, value in kwargs.items():
            setattr(self, key, value)

    def generate_workflow_file(self, workflow_template: jinja2.Template) -> None:
        output_file_path = GITHUB_DIR / f"workflows/generated-{self.name}.yml"
        with open(output_file_path, "w") as output_file:
            filename = Path(workflow_template.filename).relative_to(REPO_ROOT)
            output_file.write("# @generated DO NOT EDIT MANUALLY\n")
            output_file.write(f"# Generated from {filename}\n")
            output_file.write(workflow_template.render(self.__dict__))
            output_file.write("\n")
        print("Wrote", output_file_path.relative_to(REPO_ROOT))


WORKFLOWS = [
    CIWorkflow(
        template="deploy_lambda.yml.j2",
        name="github-webhook-rds-sync",
        lambda_name="github-webhook-rds-sync-app",
        timeout=3,
    ),
    CIWorkflow(
        template="deploy_lambda.yml.j2",
        name="rds-proxy",
        lambda_name="rds-proxy",
        timeout=3,
    ),
    # This can't be deployed from GitHub's runners since it installs incompatible
    # binaries when downloading dependencies
    # CIWorkflow(
    #     template="deploy_lambda.yml.j2",
    #     name="github-status-sync",
    #     lambda_name="ossci-job-status-sync",
    #     timeout=5 * 60,
    # ),
    CIWorkflow(
        template="metrics_pytorch_org.yml.j2", name="metrics-pytorch-org", timeout=3
    ),
    CIWorkflow(
        template="update_grafana_dashboards.yml.j2",
        name="update-grafana-dashboards",
        timeout=3,
    ),
]

for user_name, repos in HUD_JOBS.items():
    for repo_name, branches in repos.items():
        for branch in branches:
            WORKFLOWS.append(
                CIWorkflow(
                    template="update_github_status.yml.j2",
                    repo=repo_name,
                    user=user_name,
                    branch=branch.branch,
                    name=f"update-github-status-{user_name}-{repo_name}-{branch.branch.replace('/', '_')}",
                    cron=branch.cron,
                    fetch_size=branch.fetch_size,
                    history_size=branch.history_size,
                )
            )


if __name__ == "__main__":
    jinja_env = jinja2.Environment(
        variable_start_string="!{{",
        loader=jinja2.FileSystemLoader(str(GITHUB_DIR / "templates")),
        undefined=jinja2.StrictUndefined,
    )

    # Delete the existing generated files first, this should align with .gitattributes file description.
    existing_workflows = GITHUB_DIR.glob("workflows/generated-*")
    for w in existing_workflows:
        try:
            os.remove(w)
        except Exception as e:
            print(f"Error occurred when deleting file {w}: {e}")

    for workflow in WORKFLOWS:
        template = jinja_env.get_template(workflow.template)
        workflow.generate_workflow_file(workflow_template=template)
