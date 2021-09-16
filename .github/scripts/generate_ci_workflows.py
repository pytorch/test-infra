#!/usr/bin/env python3

from pathlib import Path

import jinja2
import os
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent.parent
GITHUB_DIR = REPO_ROOT / ".github"


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
        template="deploy_lambda.yml.j2", name="github_webhook_rds_sync", timeout=3
    ),
    CIWorkflow(template="deploy_lambda.yml.j2", name="checks-cron", timeout=3),
    CIWorkflow(template="deploy_lambda.yml.j2", name="rds-proxy", timeout=3),
    CIWorkflow(
        template="metrics_pytorch_org.yml.j2", name="metrics-pytorch-org", timeout=3
    ),
    CIWorkflow(
        template="update_grafana_dashboards.yml.j2",
        name="update-grafana-dashboards",
        timeout=3,
    ),
]


if __name__ == "__main__":
    jinja_env = jinja2.Environment(
        variable_start_string="!{{",
        loader=jinja2.FileSystemLoader(str(GITHUB_DIR / "templates")),
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
