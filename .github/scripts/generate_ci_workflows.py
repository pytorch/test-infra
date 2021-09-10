#!/usr/bin/env python3

from dataclasses import asdict, dataclass
from pathlib import Path

import jinja2
import os
from typing import Dict


DOCKER_REGISTRY = "308535385114.dkr.ecr.us-east-1.amazonaws.com"
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
GITHUB_DIR = REPO_ROOT / ".github"


@dataclass
class CIWorkflow:
    name: str

    def generate_workflow_file(self, workflow_template: jinja2.Template) -> None:
        output_file_path = (
            GITHUB_DIR / f"workflows/generated-{self.name}.yml"
        )
        with open(output_file_path, "w") as output_file:
            generated = "generated"  # Note that please keep the variable generated otherwise phabricator will hide the whole file

            filename = Path(workflow_template.filename).relative_to(REPO_ROOT)
            output_file.write(f"# @{generated} DO NOT EDIT MANUALLY\n")
            output_file.write(f"# Generated from {filename}\n")
            output_file.write(workflow_template.render(asdict(self)))
            output_file.write("\n")
        print(output_file_path)


@dataclass
class ZipLambda(CIWorkflow):
    timeout: int


ZIP_LAMBDAS = [
    ZipLambda(name="github_webhook_rds_sync", timeout=3),
    ZipLambda(name="checks-cron", timeout=3),
    ZipLambda(name="rds-proxy", timeout=3),
]


if __name__ == "__main__":
    jinja_env = jinja2.Environment(
        variable_start_string="!{{",
        loader=jinja2.FileSystemLoader(str(GITHUB_DIR.joinpath("templates"))),
    )
    template_and_workflows = [
        (jinja_env.get_template("deploy_lambda.yml.j2"), ZIP_LAMBDAS),
    ]
    # Delete the existing generated files first, this should align with .gitattributes file description.
    existing_workflows = GITHUB_DIR.glob("workflows/generated-*")
    for w in existing_workflows:
        try:
            os.remove(w)
        except Exception as e:
            print(f"Error occurred when deleting file {w}: {e}")

    for template, workflows in template_and_workflows:
        for workflow in workflows:
            workflow.generate_workflow_file(workflow_template=template)

