from typing import Dict, Any, List

from torchci.scripts.check_alerts import generate_failed_job_hud_link

ALERT_REGISTRY = {}

PENDING = "pending"
NEUTRAL = "neutral"
SKIPPED = "skipped"
SUCCESS = "success"
FAILURE = "failure"
CANCELED = "canceled"

def register(alert_type):
    if alert_type in ALERT_REGISTRY:
        raise ValueError(f"Alert type {alert_type} is already registered")
    def inner(func):
        ALERT_REGISTRY[alert_type] = func
        return func
    return inner

@register('Recurrently Failing Jobs')
def handle_recurrently_failing_jobs(alerts: List[Dict[str, Any]]) -> str:
    pass

def generate_failed_job_hud_link(failed_job: JobStatus) -> str:
    # TODO: I don't think minihud is universal across multiple repositories
    #       would be good to just replace this with something that is
    hud_link = "https://hud.pytorch.org/minihud?name_filter=" + urllib.parse.quote(
        failed_job.job_name
    )
    return f"[{failed_job.job_name}]({hud_link})"

def generate_failed_job_issue(
    repo: str, branch: str, failed_jobs: List[JobStatus]
) -> Any:
    failed_jobs.sort(key=lambda status: status.job_name)
    issue = {}
    issue[
        "title"
    ] = f"[Pytorch] There are {len(failed_jobs)} Recurrently Failing Jobs on {repo} {branch}"
    body = "Within the last 50 commits, there are the following failures on the main branch of pytorch: \n"
    for job in failed_jobs:
        failing_sha = job.failure_chain[-1]["sha"]
        body += (
            f"- {generate_failed_job_hud_link(job)} failed consecutively starting with "
        )
        body += f"commit [{failing_sha}](https://hud.pytorch.org/commit/{repo}/{failing_sha})"
        body += "\n\n"

    body += "Please review the errors and revert if needed."
    issue["body"] = body
    issue["labels"] = [PYTORCH_ALERT_LABEL]

    print("Generating alerts for: ", failed_jobs)
    return issue

def gen_update_comment(original_body: str, jobs: List[JobStatus]) -> str:
    """
    Returns empty string if nothing signficant changed. Otherwise returns a
    short string meant for updating the issue.
    """
    original_jobs = []
    for line in original_body.splitlines():
        match = re.match(FAILED_JOB_PATTERN, line.strip())
        if match is not None:
            original_jobs.append(match.group(1))

    new_jobs = [job.job_name for job in jobs]
    stopped_failing_jobs = [job for job in original_jobs if job not in new_jobs]
    started_failing_jobs = [job for job in new_jobs if job not in original_jobs]

    # TODO: Add real HUD links to these eventually since not having clickable links is bad
    s = ""
    if len(stopped_failing_jobs) > 0:
        s += "These jobs stopped failing:\n"
        for job in stopped_failing_jobs:
            s += f"* {job}\n"
        s += "\n"
    if len(started_failing_jobs) > 0:
        s += "These jobs started failing:\n"
        for job in started_failing_jobs:
            s += f"* {job}\n"
    return s