import json
import os
import re
import subprocess
import sys


def run_cmd_or_die(cmd):
    print(f"Running command: {cmd}")
    p = subprocess.Popen(
        "/bin/bash",
        stdout=subprocess.PIPE,
        stdin=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=1,
        universal_newlines=True,
    )
    p.stdin.write("set -e\n")
    p.stdin.write(cmd)
    p.stdin.write("\nexit $?\n")
    p.stdin.close()

    result = ""
    while p.poll() is None:
        line = p.stdout.readline()
        if line:
            print(line, end="")
        result += line

    # Read any remaining output
    for line in p.stdout:
        print(line, end="")
        result += line

    exit_code = p.returncode
    if exit_code != 0:
        raise RuntimeError(f"Command {cmd} failed with exit code {exit_code}")
    return result


def main():
    all_secrets = json.loads(os.environ["ALL_SECRETS"])
    secrets_names = [x for x in sys.argv[1].split(" ") if x]
    if not secrets_names:
        secrets_names = [x for x in all_secrets.keys()]
    secrets_u_names = [
        re.sub(r"[^a-zA-Z0-9_]", "", f"SECRET_{x.upper()}".replace("-", "_"))
        for x in secrets_names
    ]

    for sname, senv in zip(secrets_names, secrets_u_names):
        try:
            os.environ[senv] = str(all_secrets.get(sname, ""))
        except KeyError as e:
            print(f"Could not set {senv} from secret {sname}: {e}")

    container_name = (
        run_cmd_or_die(
            f"""
    docker run \
        -e PR_NUMBER \
        -e RUNNER_ARTIFACT_DIR=/artifacts \
        -e RUNNER_DOCS_DIR=/docs \
        -e RUNNER_TEST_RESULTS_DIR=/test-results \
        --env-file="{ os.environ.get('RUNNER_TEMP', '') }/github_env_{ os.environ.get('GITHUB_RUN_ID', '') }" \
        `# It is unknown why the container sees a different value for this.` \
        -e GITHUB_STEP_SUMMARY \
        { ' '.join([ f'-e {v}' for v in secrets_u_names ]) } \
        --cap-add=SYS_PTRACE \
        --detach \
        --ipc=host \
        --security-opt seccomp=unconfined \
        --shm-size=2g \
        --tty \
        --ulimit stack=10485760:83886080 \
        { os.environ.get('GPU_FLAG', '') } \
        -v "{ os.environ.get('GITHUB_WORKSPACE', '') }/{ os.environ.get('REPOSITORY', '') }:/work" \
        -v "{ os.environ.get('GITHUB_WORKSPACE', '') }/test-infra:/test-infra" \
        -v "{ os.environ.get('RUNNER_ARTIFACT_DIR', '') }:/artifacts" \
        -v "{ os.environ.get('RUNNER_DOCS_DIR', '') }:/docs" \
        -v "{ os.environ.get('RUNNER_TEST_RESULTS_DIR', '') }:/test-results" \
        -v "{ os.environ.get('RUNNER_TEMP', '') }/exec_script:/exec" \
        -v "{ os.environ.get('GITHUB_STEP_SUMMARY', '') }":"{ os.environ.get('GITHUB_STEP_SUMMARY', '') }" \
        -w /work \
        "{ os.environ.get('DOCKER_IMAGE', '') }"
    """
        )
        .replace("\n", "")
        .strip()
    )
    run_cmd_or_die(f"docker exec -t {container_name} /exec")


if __name__ == "__main__":
    main()
