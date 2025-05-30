from collections import defaultdict
import grp
import logging
import os
import pwd
from typing import List
import requests
import subprocess
import sys
import time

import docker
from github import Auth, Github, SelfHostedActionsRunner, PaginatedList


logger = logging.getLogger(__name__)


# The name of the container that should always be running
REQUIRED_CONTAINER_NAME = 'ghad-main-shared-instance-container'
DOCKER_REPOSITORY = '308535385114.dkr.ecr.us-east-1.amazonaws.com/multi-tenant-gpu'
DOCKER_TAG = 'latest'
_IMDSV2_TOKEN = ""
DRAIN_REQUESTED_LABEL="DrainRequested"
DRAIN_SUCCESS_LABEL="DrainSuccess"
DRAIN_STARTED_LABEL="DrainStarted"


class UserSocketsPath:
    def __init__(self, uid: int, socket_path: str, user_name: str):
        self._uid = uid
        self._socket_path = socket_path
        self._user_name = user_name
        self._docker_client = None

    @property
    def uid(self) -> int:
        return self._uid

    @property
    def socket_path(self) -> str:
        return self._socket_path

    @property
    def user_name(self) -> str:
        return self._user_name

    @property
    def docker_client(self) -> docker.DockerClient:
        if not self._docker_client:
            self._docker_client = get_docker_client(self.socket_path)
        return self._docker_client


def get_home_users() -> list[pwd.struct_passwd]:
    users = []
    for user in pwd.getpwall():
        if os.path.isdir(f'/home/{user.pw_name}') and user.pw_name != 'ubuntu':
            users.append(user)
    return users


def check_socket_for_users(timeout=10*60, check_interval=1) -> List[UserSocketsPath]:
    users = get_home_users()
    user_sockets = {user.pw_uid: (False, user.pw_name, ) for user in users}
    start_time = time.time()

    logger.info(f"Checking for Docker sockets for users: {', '.join([user.pw_name for user in users])}")

    while time.time() - start_time < timeout:
        for user in users:
            if user_sockets.get(user.pw_uid, (False, '', ))[0]:
                continue

            uid = user.pw_uid
            socket_path = f'/run/user/{uid}/docker.sock'

            if os.path.exists(socket_path):
                user_sockets[uid] = (True, user.pw_name, )

        if all(has_socket for has_socket, _ in user_sockets.values()):
            logger.info("All Docker sockets found. Starting manager...")
            break
        else:
            logger.debug(f"Still missing Docker sockets for users: {[uid for uid, has_socket in user_sockets.items() if not has_socket]}")

        time.sleep(check_interval)

    return [
        UserSocketsPath(uid, f'/run/user/{uid}/docker.sock', user_name)
        for (uid, (has_socket, user_name, ), ) in user_sockets.items()
        if has_socket
    ]


def get_docker_client(socket_path: str) -> docker.DockerClient | None:
    try:
        logger.info(f"Connecting to Docker socket {socket_path}")
        client = docker.DockerClient(base_url=f'unix://{socket_path}')
        return client
    except Exception as e:
        logger.info(f"Error connecting to Docker socket {socket_path}: {str(e)}")
        return None


def is_container_running(client: docker.DockerClient, container_name: str) -> bool:
    try:
        containers = client.containers.list(filters={"name": container_name}, all=True)
        for container in containers:
            if container.name == container_name and container.status == 'running':
                return True
        return False
    except Exception as e:
        logger.warning(f"Error checking containers: {str(e)}")
        return False


def stop_all_containers(client: docker.DockerClient, uid: int) -> None:
    logger.info(f"Stopping all containers for user {uid}")
    try:
        containers = client.containers.list(all=True)
        for container in containers:
            try:
                container.stop()
                container.remove()
            except Exception as e:
                logger.warning(f"Error stopping container {container.name}: {str(e)}")
    except Exception as e:
        logger.warning(f"Error stopping all containers: {str(e)}")


def prune_images(client: docker.DockerClient, uid: int) -> None:
    logger.info(f"Pruning images for {uid}, so that we don't run out of disk space.")
    client.images.prune({'dangling': False})


def start_container_if_not_running(
        runner_url: str, instance_label: str, instance_id: str, uid: int, client: docker.DockerClient,
        docker_group_id: int, container_name: str, user_name: str, docker_tag: str
        ) -> None:
    if not is_container_running(client, container_name):
        stop_all_containers(client, uid)
        prune_images(client, uid)
        login_to_ecr(client)

        logger.info(f"Container {container_name} for user {uid} is not running, attempting to start it.")
        logger.info("Getting GH token")
        gh_token = get_gh_runner_token()
        logger.info(f"GH token obtained, starting container.")
        try:
            subprocess.run(["rm", "-rf", f"/home/{user_name}/_work"])
            subprocess.run(["mkdir", "-p", f"/hone/{user_name}/_work"])
            subprocess.run(["chown", "-R", f"1000:1000", f"/home/{user_name}/_work"])
        except Exception as e:
            logger.warning(f"Error setting up container environment on host user {container_name}: {str(e)}")
        try:
            response = client.containers.run(
                image=f"{DOCKER_REPOSITORY}:{docker_tag}",
                name=container_name,
                command=f'/bin/bash /multi-tenant-gpu-main.sh "{user_name}" "{docker_group_id}" "{runner_url}" "{gh_token}" "{instance_id}" "{uid}" "{instance_label}"',
                volumes={
                    f'/run/user/{uid}/docker.sock': {'bind': '/var/run/docker.sock', 'mode': 'rw'},
                    f'/home/{user_name}/_work': {'bind': f'/home/{user_name}/_work', 'mode': 'rw'},
                    '/etc/gha-runner-config/multi-tenant-gpu-main.sh': {'bind': '/multi-tenant-gpu-main.sh', 'mode': 'ro'},
                },
                device_requests=[
                    docker.types.DeviceRequest(count=-1, capabilities=[['gpu']])
                ],
                remove=True,
                detach=True
            )
            logger.info(f"the response from the docker daemon: {response}")
        except Exception as e:
            logger.warning(f"Error starting container {container_name}: {str(e)}")


def drain_all_containers(instance_id: str, instance_az: str, instance_region: str, uid_sockets_list: List[UserSocketsPath]) -> None:
    logger.warning(f"Instance {instance_id} {instance_az} {instance_region} is marked to drain, stopping all idle containers.")

    gh = get_github_app_client()
    gh_org = gh.get_organization("pytorch")

    not_found_count = defaultdict(int)

    while True:
        terminated_all = True

        gh_runners = {
            runner.name: runner
            for runner in get_self_hosted_runners_org(gh_org)
        }

        for uid_sockets in uid_sockets_list:
            logger.debug(f"Checking container for user {uid_sockets.user_name}")

            if not is_container_running(uid_sockets.docker_client, REQUIRED_CONTAINER_NAME):
                logger.info(f"Container {REQUIRED_CONTAINER_NAME} for user {uid_sockets.user_name} is not running, skipping.")
                continue

            runner_gh_name = f"{instance_id}-{uid_sockets.uid}"

            if runner_gh_name in gh_runners:
                if runner_gh_name in not_found_count:
                    logger.info(f"Runner {runner_gh_name} found after {not_found_count[runner_gh_name]} consecutive not founds.")
                    del not_found_count[runner_gh_name]
                else:
                    logger.info(f"Runner {runner_gh_name} found, checking if it's busy.")

                if gh_runners[runner_gh_name].busy:
                    logger.info(f"Runner {runner_gh_name} is busy, not stopping container.")
                    terminated_all = False
                    continue

                if not remove_self_hosted_runner_org(gh_org, gh_runners[runner_gh_name]):
                    logger.error(f"Error removing runner {runner_gh_name}")
                    terminated_all = False
                    continue

                logger.info(f"Runner {runner_gh_name} removed.")
            else:
                # It is possible that the runner is not returned by the API but it should and it is running
                # This is a known issue with the GitHub API
                # There is no way to check if the runner is busy or not unless we have the runner ID, but we don't keep track of it
                # So, we check multiple times, and if we can't find it after 5 tries, we assume it is not running
                not_found_count[runner_gh_name] += 1

                if not_found_count[runner_gh_name] < 5:
                    logger.info(f"Runner {runner_gh_name} not found. Count of 'not founds': {not_found_count[runner_gh_name]}. Will check again.")
                    terminated_all = False
                    continue

                logger.info(f"Runner {runner_gh_name} not found after 5 consecutive not founds. Stopping container.")

            try:
                container = uid_sockets.docker_client.containers.get(REQUIRED_CONTAINER_NAME)
                container.stop()
                try:
                    container.remove()
                except Exception as e:
                    logger.warning(f"Error removing container {REQUIRED_CONTAINER_NAME}: {str(e)}")
                logger.info(f"Container {REQUIRED_CONTAINER_NAME} for user {uid_sockets.user_name} stopped and removed.")
            except Exception as e:
                logger.error(f"Error stopping container {REQUIRED_CONTAINER_NAME}: {str(e)}")
                terminated_all = False

        if terminated_all:
            logger.debug("All containers stopped.")
            break

        time.sleep(20)


def trap_stuck_inactive_daemon() -> None:
    while True:
        logger.debug("Trapping stuck inactive daemon")
        time.sleep(120)


def add_instance_tag(instance_id: str, instance_region: str, label: str, value: str) -> None:
    try:
        subprocess.run(["/usr/bin/aws", "ec2", "create-tags", "--region", instance_region, "--resources", instance_id, "--tags", f"Key={label},Value={value}"])
    except Exception as e:
        logger.warning(f"Error adding drain label to instance {instance_id}: {str(e)}")


def add_drained_label(instance_id: str, instance_region: str) -> None:
    add_instance_tag(instance_id, instance_region, DRAIN_SUCCESS_LABEL, 'true')


def add_drain_started_label(instance_id: str, instance_region: str) -> None:
    add_instance_tag(instance_id, instance_region, DRAIN_STARTED_LABEL, 'true')


def get_self_hosted_runners_org(org: any) -> PaginatedList.PaginatedList[SelfHostedActionsRunner.SelfHostedActionsRunner]:
    return PaginatedList.PaginatedList(
        SelfHostedActionsRunner.SelfHostedActionsRunner,
        org._requester,
        f"https://api.github.com/orgs/{org.login}/actions/runners",
        None,
        list_item="runners",
    )


def remove_self_hosted_runner_org(org: any, runner: any) -> bool:
    status, _, _ = org._requester.requestJson(
        "DELETE", f"/orgs/{org.login}/actions/runners/{runner.id}"
    )
    return status == 204


def get_imdsv2_token() -> str:
    try:
        return requests.put("http://169.254.169.254/latest/api/token", headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"}).text
    except Exception as e:
        logger.error(f"Error getting IMDSv2 token: {str(e)}")
        raise


def do_imdsv2_request_w_token(url: str) -> str:
    global _IMDSV2_TOKEN

    def _do_request() -> str:
        global _IMDSV2_TOKEN
        response = requests.get(url, headers={"X-aws-ec2-metadata-token": _IMDSV2_TOKEN})

        if response.status_code != 200:
            raise Exception(f"Error getting IMDSv2 data: {response.text}")

        return response.text

    if not _IMDSV2_TOKEN:
        _IMDSV2_TOKEN = get_imdsv2_token()

    try:
        return _do_request()
    except Exception as e:
        _IMDSV2_TOKEN = get_imdsv2_token()
        try:
            return _do_request()
        except Exception as e:
            logger.error(f"Error getting IMDSv2 data: {str(e)}")
            raise


def get_instance_az() -> str:
    return do_imdsv2_request_w_token("http://169.254.169.254/latest/meta-data/placement/availability-zone")


def get_instance_region() -> str:
    return do_imdsv2_request_w_token("http://169.254.169.254/latest/meta-data/placement/region")


def get_instance_id() -> str:
    return do_imdsv2_request_w_token("http://169.254.169.254/latest/meta-data/instance-id")


def get_instance_labels() -> List[str]:
    response = do_imdsv2_request_w_token("http://169.254.169.254/latest/meta-data/tags/instance")
    return [x for x in [x.strip() for x in response.split("\n")] if x]


def get_instance_label_value(label: str) -> str:
    response = do_imdsv2_request_w_token(f"http://169.254.169.254/latest/meta-data/tags/instance/{label}")
    return response.strip()


def login_to_ecr(client: docker.DockerClient) -> None:
    logger.info("Logging into ECR")
    token = subprocess.check_output(["aws", "ecr", "get-login-password", "--region", "us-east-1", ], text=True).strip()
    try:
        response = client.login(username='AWS', password=token, registry=DOCKER_REPOSITORY)
        if 'Status' in response and response['Status'] == 'Login Succeeded':
            logger.debug("Login to ECR succeeded.")
        else:
            msg = f"Login to ECR failed: {response}"
            logger.error(f"Login to ECR failed: {response}")
            raise Exception(msg)
    except Exception as e:
        logger.error(f"Error logging into ECR: {str(e)}")
        # sometimes, after while, aws ecr commands starts giving invalid tokens
        # I hope that this will fix the issue
        sys.exit(1)


def get_github_app_client() -> Github:
    auth = Auth.AppAuth(get_github_app_id(), get_private_key()).get_installation_auth(get_github_app_installation_id())
    return Github(auth=auth)


def get_gh_runner_token() -> str:
    gh_client = get_github_app_client()
    org = gh_client.get_organization('pytorch')
    _, data = org._requester.requestJsonAndCheck(
        "POST",
        f"/orgs/{org.login}/actions/runners/registration-token",
    )
    return data['token']


def read_from_file(file_path: str) -> str:
    try:
        with open(file_path, 'r') as f:
            return f.read().strip()
    except Exception as e:
        logger.info(f"Error reading file {file_path}: {str(e)}")
        raise


def get_instance_label_from_file() -> str:
    return read_from_file('/etc/gha-runner-config/instance-label')


def get_runner_url_from_file() -> str:
    return read_from_file('/etc/gha-runner-config/runner-url')


def get_private_key() -> str:
    return read_from_file('/etc/gha-runner-config/private-key')


def get_github_app_id() -> str:
    return int(read_from_file('/etc/gha-runner-config/app-id'))


def get_github_app_installation_id() -> str:
    return int(read_from_file('/etc/gha-runner-config/installation-id'))


def get_docker_tag_from_file() -> str:
    return read_from_file('/etc/gha-runner-config/image-tag-version')


def lock_nvidia_gpu_clock() -> None:
    with_a100 = False
    with_h100 = False

    try:
        result = subprocess.run(["nvidia-smi"], stdout=subprocess.PIPE)
        if "A100-SXM4-40GB" in result.stdout.decode():
            logger.info("Detected A100-SXM4-40GB GPU")
            with_a100 = True
        elif "H100 80GB HBM3" in result.stdout.decode():
            logger.info("Detected H100 80GB HBM3 GPU")
            with_h100 = True
    except Exception as e:
        logger.warning(f"Error checking GPU model: {str(e)}")

    if with_a100:
        logger.info("Locking GPU clock to 1410 MHz (40GiB A100)")
        try:
            subprocess.run(["nvidia-smi", "-pm", "1"], check=True)
            subprocess.run(["nvidia-smi", "-ac", "1215,1410"], check=True)
            subprocess.run(["nvidia-smi", "-pl", "250"], check=True)
        except Exception as e:
            logger.warning(f"Error locking GPU clock: {str(e)}")
    elif with_h100:
        logger.info("Locking GPU clock to 1410 MHz (40GiB A100)")
        try:
            subprocess.run(["nvidia-smi", "-pm", "1"], check=True)
            subprocess.run(["nvidia-smi", "-ac", "1980,2619"], check=True)
            subprocess.run(["nvidia-smi", "-pl", "700"], check=True)
        except Exception as e:
            logger.warning(f"Error locking GPU clock: {str(e)}")


def check_should_drain(instance_id: str) -> bool:
    try:
        logger.debug("Checking if instance should drain")
        labels = get_instance_labels()
        logger.debug(f"Instance {instance_id} labels: {', '.join(labels)}")
        if DRAIN_REQUESTED_LABEL in labels:
            logger.debug(f"Instance {instance_id} has label {DRAIN_REQUESTED_LABEL}.")
            value = get_instance_label_value(DRAIN_REQUESTED_LABEL)
            logger.debug(f"Instance {instance_id} has label {DRAIN_REQUESTED_LABEL} with value {value}.")
            if value == 'true':
                logger.info(f"Instance {instance_id} is marked for drain, exiting.")
                return True
    except Exception as e:
        logger.warning(f"Error checking drain label: {str(e)}")
        return False


def monitor_containers() -> None:
    logger.info(f"Starting container monitor on instance daemon...")

    uid_sockets_list = check_socket_for_users()
    instance_id = get_instance_id()
    instance_az = get_instance_az()
    instance_region = get_instance_region()

    logger.info(f"Container monitor on instance {instance_id} {instance_az} {instance_region}")
    user_name_print = ', '.join([uid_socket.user_name for uid_socket in uid_sockets_list])
    logger.info(f"Users to monitor: {user_name_print}")

    docker_group_id = grp.getgrnam('docker').gr_gid
    valid_uid_sockets_list = [uid_socket for uid_socket in uid_sockets_list if uid_socket.docker_client]

    instance_label = get_instance_label_from_file()
    runner_url = get_runner_url_from_file()

    try:
        docker_tag = get_docker_tag_from_file()
    except Exception as e:
        docker_tag = DOCKER_TAG
        logger.warning(f"Error reading Docker tag from file: {str(e)}, using default {DOCKER_TAG}")

    logger.info(f"Container monitor for instance {instance_id} {instance_az} {instance_region} with label {instance_label} and runner URL {runner_url}")

    while not check_should_drain(instance_id):
        for uid_sockets in valid_uid_sockets_list:
            logger.debug(f"Checking container for user {uid_sockets.user_name}")
            start_container_if_not_running(
                runner_url, instance_label, instance_id, uid_sockets.uid, uid_sockets.docker_client,
                docker_group_id, REQUIRED_CONTAINER_NAME, uid_sockets.user_name, docker_tag
            )
        logger.debug("Sleeping for 20 seconds")
        time.sleep(20)

    add_drain_started_label(instance_id, instance_region)
    drain_all_containers(instance_id, instance_az, instance_region, valid_uid_sockets_list)
    add_drained_label(instance_id, instance_region)
    trap_stuck_inactive_daemon()


if __name__ == "__main__":
    logging.basicConfig(filename='/var/log/ghad-manager.log', level=logging.INFO, format='%(asctime)s %(message)s')
    lock_nvidia_gpu_clock()
    monitor_containers()
