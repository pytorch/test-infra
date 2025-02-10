from typing import Any, Dict, List, NamedTuple
import argparse
import datetime
import logging
import os
import socket
import time

from github import Auth, Github, SelfHostedActionsRunner, PaginatedList
import boto3
import paramiko


DRAIN_REQUESTED_LABEL="DrainRequested"
DRAIN_SUCCESS_LABEL="DrainSuccess"
DRAIN_STARTED_LABEL="DrainStarted"

GH_APP_ID = 1007062
GH_APP_INSTALATION_ID = 55231883
GH_APP_PK_ENVIRON = 'A100_GH_APP_PK'

INSTANCE_NAMES=[
    # TODO: Update those values to gh-ci-
    # Reason not to: fear of not being able to acquire back released resources
    "gi-ci-benchmark-pet-action-runner",
    "gi-ci-benchmark-h100-pet-action-runner",
]
INSTANCE_REGIONS=['us-east-1', 'us-east-2', 'us-west-2']

DRAIN_START_TIMEOUT=5*60
DRAIN_SUCCESS_TIMEOUT=9*60*60 - DRAIN_START_TIMEOUT - 5*60

LOGGING_LEVEL_MAP = {
    'CRITICAL': logging.CRITICAL,
    'FATAL': logging.FATAL,
    'ERROR': logging.ERROR,
    'WARNING': logging.WARNING,
    'WARN': logging.WARNING,
    'INFO': logging.INFO,
    'DEBUG': logging.DEBUG,
}

class InstanceInfo(NamedTuple):
    instance_id: str
    instance_type: str
    public_ips: List[str]
    region: str
    volume_creation_date: datetime.datetime
    volume_id: str


logger = logging.getLogger(__name__)


def from_human_str_to_bool(i: str) -> bool:
    if i.lower() in ['true', '1', 'yes', 'y', 'enabled']:
        return True
    elif i.lower() in ['false', '0', 'no', 'n', 'disabled']:
        return False
    raise ValueError(f"Invalid boolean value: {i}")


def get_ec2_instances_by_tag(tag_name: str, tag_value: str, regions: List[str]) -> List[InstanceInfo]:
    def get_volume_creation_date(volume_id: str, ec2_client: Any) -> datetime.datetime:
        response = ec2_client.describe_volumes(VolumeIds=[volume_id])
        volume = response['Volumes'][0]
        return volume['CreateTime']

    instances_info: List[InstanceInfo] = []

    for region in regions:
        ec2_client = boto3.client('ec2', region_name=region)

        response = ec2_client.describe_instances(
            Filters=[
                {'Name': f'tag:{tag_name}', 'Values': [tag_value]}
            ]
        )

        for reservation in response['Reservations']:
            for instance in reservation['Instances']:
                instance_id = instance['InstanceId']
                volumes = instance.get('BlockDeviceMappings', [])

                for volume in volumes:
                    volume_id = volume['Ebs']['VolumeId']
                    volume_creation_date = get_volume_creation_date(volume_id, ec2_client)

                    instances_info.append(InstanceInfo(
                        instance_id=instance_id,
                        instance_type=instance['InstanceType'],
                        volume_id=volume_id,
                        volume_creation_date=volume_creation_date,
                        region=region,
                        public_ips=[
                            address
                            for address in (
                                interface.get('Association', {}).get('PublicIp', '')
                                for interface in instance.get('NetworkInterfaces', [])
                            )
                            if address != ''
                        ]
                    ))

    instances_info.sort(key=lambda x: x.volume_creation_date)

    return instances_info


def wait_for_tag(client: boto3.client, instance_id: str, tag_name: str, tag_value: str, check_interval: int = 10, timeout: int = 300) -> bool:
    start_time = time.time()

    while True:
        response = client.describe_instances(InstanceIds=[instance_id])
        instance = response['Reservations'][0]['Instances'][0]

        if 'Tags' in instance:
            for tag in instance['Tags']:
                if tag['Key'] == tag_name and tag['Value'] == tag_value:
                    return True

        elapsed_time = time.time() - start_time
        if elapsed_time > timeout:
            if timeout <= 0:
                break
            else:
                raise TimeoutError(f"Timeout reached: Tag '{tag_name}' with value '{tag_value}' was not found on instance '{instance_id}' within {timeout} seconds.")

        time.sleep(check_interval)

    return False


def remove_tags_from_instance(client: boto3.client, instance_id: str, tag_keys: list) -> bool:
    client.delete_tags(
        Resources=[instance_id],
        Tags=[{'Key': key} for key in tag_keys]  # List of tags to delete (only key is required)
    )

    logging.info(f"Tags {tag_keys} removed from instance: {instance_id}")
    return True


def restart_instance(client: boto3.client, instance_id: str, check_interval: int = 10, timeout: int = 300) -> bool:
    logging.info(f"Requesting reboot for instance: {instance_id}")
    client.reboot_instances(InstanceIds=[instance_id])

    logging.info(f"Reboot requested for instance {instance_id}, waiting 2 minutes before checking instance state")
    time.sleep(2*60)

    start_time = time.time()

    current_instance_status = ""

    while True:
        elapsed_time = time.time() - start_time
        if elapsed_time > timeout:
            raise TimeoutError(f"Timeout: Instance '{instance_id}' did not reach 'running' state within {timeout} seconds.")

        try:
            response = client.describe_instance_status(InstanceIds=[instance_id])
            statuses = response.get('InstanceStatuses', [])
        except Exception as e:
            logging.error(f"Error while checking instance status: {e}")
            continue

        if statuses:
            instance_status = statuses[0]['InstanceState']['Name']

            if instance_status != current_instance_status:
                current_instance_status = instance_status
                logging.info(f"Current instance status: {instance_status}")

            if instance_status == 'running':
                logging.info(f"Instance '{instance_id}' is now running.")
                return True
            elif instance_status in ['stopping', 'stopped', 'terminated']:
                raise Exception(f"Instance '{instance_id}' is in '{instance_status}' state, unable to complete reboot.")

        time.sleep(check_interval)


def wait_ssh_alive(ipv4_address: str, username: str, check_interval: int = 10, timeout: int = 300) -> None:
    ssh_client = paramiko.SSHClient()
    ssh_client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    start_time = time.time()

    while True:
        elapsed_time = time.time() - start_time

        if elapsed_time > timeout:
            raise Exception(f"SSH connection attempts to {ipv4_address} exceeded {timeout} seconds")

        try:
            ssh_client.connect(ipv4_address, username=username, timeout=check_interval)
            logging.info(f"SSH connection successful to {ipv4_address}")
            return

        except paramiko.ssh_exception.BadHostKeyException as e:
            logging.info(f"ERROR: BadHostKeyException: {e}")
            return
        except paramiko.ssh_exception.AuthenticationException as e:
            logging.info(f"ERROR: AuthenticationException: {e}")
            return
        except paramiko.ssh_exception.UnableToAuthenticate as e:
            logging.info(f"ERROR: UnableToAuthenticate: {e}")
            return
        except socket.error as e:
            logging.info(f"ERROR: Socket error: {e}")
        except paramiko.ssh_exception.NoValidConnectionsError:
            logging.info(f"ERROR: NoValidConnectionsError")
        except paramiko.ssh_exception.SSHException as e:
            logging.info(f"ERROR: SSHException")
            return
        except EOFError as e:
            logging.info(f"ERROR: EOFError: {e}")
        except TimeoutError:
            logging.info(f"ERROR: Timed out while trying to connect to {ipv4_address}")
        except Exception as e:
            logging.info(f"ERROR: {e}")
            return

        finally:
            try:
                ssh_client.close()
            except:
                pass

        time.sleep(check_interval)


def replace_root_volume(client: boto3.client, instance_id: str, check_interval: int = 10, timeout: int = 600) -> bool:
    response = client.create_replace_root_volume_task(
        InstanceId=instance_id,
        DeleteReplacedRootVolume=True
    )

    task_id = response['ReplaceRootVolumeTask']['ReplaceRootVolumeTaskId']
    logging.info(f"Started root volume replacement task: {task_id}")

    start_time = time.time()
    curr_state = ""

    while True:
        elapsed_time = time.time() - start_time
        if elapsed_time > timeout:
            raise TimeoutError(f"Timeout: The root volume replacement for instance '{instance_id}' did not complete within {timeout} seconds.")

        task_response = client.describe_replace_root_volume_tasks(ReplaceRootVolumeTaskIds=[task_id])
        task_status = task_response['ReplaceRootVolumeTasks'][0]['TaskState']

        if task_status != curr_state:
            curr_state = task_status
            logging.info(f"Current task state: {task_status}")

        if task_status == 'succeeded':
            logging.info(f"Root volume replacement succeeded for task: {task_id}")
            return True
        elif task_status in ['failed', 'failing']:
            raise Exception(f"Root volume replacement failed for task: {task_id}, status: {task_status}")

        time.sleep(check_interval)


def create_instance_tag(ec2_client: boto3.client, instance_id: str, tag_key: str, tag_value: str) -> bool:
    logging.info(f"Tagging instance {instance_id} with tag {tag_key}={tag_value}...")

    response = ec2_client.create_tags(
        Resources=[instance_id],
        Tags=[
            {
                'Key': tag_key,
                'Value': tag_value
            }
        ]
    )

    if response['ResponseMetadata']['HTTPStatusCode'] != 200:
        raise Exception(f"Failed to tag instance {instance_id} with tag {tag_key}={tag_value}")

    logging.info(f"Tagged instance {instance_id} with tag {tag_key}")
    return True


def kindly_ask_instance_to_drain_and_wait_start(instance_info: InstanceInfo, ec2_client: Any) -> None:
    create_instance_tag(ec2_client, instance_info.instance_id, DRAIN_REQUESTED_LABEL, 'true')

    logging.info(f"Waiting for instance {instance_info.instance_id} to be tagged with {DRAIN_STARTED_LABEL} with timeout of {DRAIN_START_TIMEOUT}...")
    wait_for_tag(ec2_client, instance_info.instance_id, DRAIN_STARTED_LABEL, 'true', timeout=DRAIN_START_TIMEOUT)
    logging.info(f"Instance {instance_info.instance_id} tagged with {DRAIN_STARTED_LABEL}")


def wait_instance_to_be_fully_drained(instance_info: InstanceInfo, ec2_client: Any) -> None:
    logging.info(f"Waiting for instance {instance_info.instance_id} to be tagged with {DRAIN_SUCCESS_LABEL} with timeout of {DRAIN_SUCCESS_TIMEOUT}...")
    wait_for_tag(ec2_client, instance_info.instance_id, DRAIN_SUCCESS_LABEL, 'true', timeout=DRAIN_SUCCESS_TIMEOUT)
    logging.info(f"Instance {instance_info.instance_id} tagged with {DRAIN_SUCCESS_LABEL}")


def kindly_ask_instance_to_drain_and_wait(instance_info: InstanceInfo, force_on_drain_timeout: bool, ec2_client: Any) -> None:
    create_instance_tag(ec2_client, instance_info.instance_id, DRAIN_REQUESTED_LABEL, 'true')

    try:
        kindly_ask_instance_to_drain_and_wait_start(instance_info, ec2_client)
        wait_instance_to_be_fully_drained(instance_info, ec2_client)
    except Exception as e:
        logging.error(f"Error while refreshing EBS volume for instance {instance_info.instance_id}: {e}")
        if not force_on_drain_timeout:
            logging.warning("Force on drain timeout is disabled, skipping EBS volume refresh...")
            raise


def do_refresh_ebs_instance(instance_info: InstanceInfo, force_on_drain_timeout: bool) -> None:
    logging.info(f"Refreshing EBS volume for instance {instance_info.instance_id} in region {instance_info.region}...")

    ec2_client = boto3.client('ec2', region_name=instance_info.region)

    kindly_ask_instance_to_drain_and_wait(instance_info, force_on_drain_timeout, ec2_client)
    replace_root_volume(ec2_client, instance_info.instance_id)
    remove_tags_from_instance(ec2_client, instance_info.instance_id, [DRAIN_REQUESTED_LABEL, DRAIN_STARTED_LABEL, DRAIN_SUCCESS_LABEL])
    restart_instance(ec2_client, instance_info.instance_id)

    logging.info("Sleeping for 2 minutes to allow the instance to fully restart...")
    time.sleep(2*60)

    if instance_info.public_ips:
        logging.info("Trying to SSH to the instance, as so to wait for it to restart and become ready for ansible...")
        wait_ssh_alive(instance_info.public_ips[0], 'ubuntu')
    else:
        logging.error("Instance does not have a public IP (Seems something is wrong here...), skipping SSH check...")

    logging.info("Instance restarted and SSH is live, EBS volume refresh completed.")


def get_github_app_client() -> Github:
    auth = Auth.AppAuth(GH_APP_ID, os.environ[GH_APP_PK_ENVIRON]).get_installation_auth(GH_APP_INSTALATION_ID)
    return Github(auth=auth)


def get_self_hosted_runners_org(gh_org: Any) -> PaginatedList.PaginatedList:
    return PaginatedList.PaginatedList(
        SelfHostedActionsRunner.SelfHostedActionsRunner,
        gh_org._requester,
        f"https://api.github.com/orgs/{gh_org.login}/actions/runners",
        None,
        list_item="runners",
    )


def check_instance_is_registered(instance_id: str) -> bool:
    logging.info(f"Checking if instance {instance_id} is registered as gha runner...")

    try:
        gh = get_github_app_client()
        gh_org = gh.get_organization("pytorch")
        for runner in get_self_hosted_runners_org(gh_org):
            if runner.name.lower().startswith(instance_id.lower()):
                logging.info(f"Instance {instance_id} is registered as gha runner")
                return True

    except Exception as e:
        logging.error(f"Error while checking if instance {instance_id} is registered as gha runner: {e}")

    logging.info(f"Instance {instance_id} is not registered as gha runner")
    return False


def create_refresh_inventory_file(instance_info: InstanceInfo) -> None:
    logging.info(f"Creating inventory file (inventory/refresh_inventory) for instance {instance_info.instance_id}...")

    with open('inventory/refresh_inventory', 'w') as f:
        f.write(f"{instance_info.instance_id}-{instance_info.region}-{instance_info.instance_type} ansible_host={instance_info.public_ips[0]}")

    logging.info("Inventory file created.")


def get_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Reset the oldest EBS volume of the instances with the specified tag.')

    parser.add_argument('--instance-name', action='store', type=str, default=INSTANCE_NAMES[0], choices=INSTANCE_NAMES, help='The tag value of the instances to reset the EBS volume.')
    parser.add_argument('--instance-regions', type=str, nargs='+', default=INSTANCE_REGIONS, help='The regions to search for the instances.')
    parser.add_argument('--logging-level', action='store', type=str, choices=list(LOGGING_LEVEL_MAP.keys()), default='DEBUG', help='The logging level.')
    parser.add_argument('--force-on-drain-timeout', action='store', type=from_human_str_to_bool, default=True, help='Force the EBS volume refresh even if the drain timeout is reached.')

    subparsers = parser.add_subparsers(title='subcommands', dest='subcommand')
    subparsers.required = True

    subparsers.add_parser(refresh_oldest_ebs_volume.__doc__, help='Reset the oldest EBS volume of the instances with the specified tag.')
    subparsers.add_parser(check_last_ebs_connection.__doc__, help='Check if the last instance that had its EBS volume refreshed is registered as gha runner.')

    safely_restart_all_instances_parser = subparsers.add_parser(safely_restart_all_instances.__doc__, help='Reboot ALL the instances, safely waiting then for properly drain.')
    safely_restart_all_instances_parser.add_argument('--max-simultaneous-draining', action='store', type=int, default=3, help='The maximum number of instances to drain simultaneously.')
    safely_restart_all_instances_parser.add_argument('--dry-run', action='store', type=from_human_str_to_bool, default=False, help='Do not actually restart the instances, just print the actions.')

    return parser.parse_args()


def refresh_oldest_ebs_volume(args: argparse.Namespace) -> None:
    '''reset-oldest-ebs'''

    logging.info(f"Getting instances with the tag {args.instance_name} in the regions {args.instance_regions}...")
    instances = get_ec2_instances_by_tag('Name', args.instance_name, args.instance_regions)

    if not instances:
        raise Exception(f"No instances found with tag 'Name={args.instance_name}'")

    if not check_instance_is_registered(instances[-1].instance_id):
        logging.info(
            f"Last instance that had its EBS volume refreshed ({instances[-1].instance_id}) is"
            " not registered as gha runner, proceeding to refresh its EBS volume..."
        )
        do_refresh_ebs_instance(instances[-1], args.force_on_drain_timeout)
        create_refresh_inventory_file(instances[-1])
    else:
        logging.info(
            f"Last instance that had its EBS volume refreshed ({instances[-1].instance_id}) is "
            f"registered as gha runner, proceeding to refresh the oldest ({instances[0].instance_id}) "
            "instance's EBS volume..."
        )
        do_refresh_ebs_instance(instances[0], args.force_on_drain_timeout)
        create_refresh_inventory_file(instances[0])


def check_last_ebs_connection(args: argparse.Namespace) -> None:
    '''check-last-ebs-connection'''

    logging.info("Checking if the last instance that had its EBS volume refreshed is registered as gha runner...")

    logging.debug(f"Getting instances with the tag {args.instance_name} in the regions {args.instance_regions}...")
    instances = get_ec2_instances_by_tag('Name', args.instance_name, args.instance_regions)

    if not instances:
        raise Exception(f"No instances found with tag 'Name={args.instance_name}'")

    last_instance = instances[-1]
    logging.info(f"Last instance that had its EBS volume refreshed: {last_instance.instance_id} in region {last_instance.region}")

    logging.debug('Checking if the last instance is registered as gha runner...')
    if not check_instance_is_registered(last_instance.instance_id):
        raise Exception(f'Last instance {last_instance.instance_id} with Name tag {args.instance_name} on region {last_instance.region} that had its EBS volume refreshed is not registered as gha runner')

    logging.debug('Trying to connect to the instance via ssh...')
    try:
        wait_ssh_alive(last_instance.public_ips[0], 'ubuntu')
        logging.info('successfully connected to the instance via ssh')
    except:
        raise


def safely_restart_all_instances(args: argparse.Namespace) -> None:
    '''safely-restart-all-instances'''

    logging.info("Will restart all instances with the tag {args.instance_name} in the regions {args.instance_regions}...")

    logging.info(f"Getting instances with the tag {args.instance_name} in the regions {args.instance_regions}...")
    instances = get_ec2_instances_by_tag('Name', args.instance_name, args.instance_regions)

    if not instances:
        raise Exception(f"No instances found with tag 'Name={args.instance_name}'")

    ec2_clients = {}
    to_drain = []
    wait_drain = []
    to_restart = []
    restarted = []

    for instance in instances:
        if check_instance_is_registered(instance.instance_id):
            to_drain.append(instance)
        else:
            logging.warning(f"Instance {instance.instance_id} is not registered as gha runner, skipping drain...")
            to_restart.append(instance)

    if to_drain:
        logging.info("Will proceed to safely drain the instances...")
        logging.info(f"Instances to drain: {', '.join([instance.instance_id for instance in to_drain])}")
    else:
        logging.info("No instances to drain, skipping drain...")

    while to_drain or wait_drain or to_restart:
        for instance in to_drain:
            if len(wait_drain) >= args.max_simultaneous_draining:
                break

            if instance.region not in ec2_clients:
                ec2_clients[instance.region] = boto3.client('ec2', region_name=instance.region)

            logging.info(f"Asking to drain instance {instance.instance_id}...")
            try:
                if not args.dry_run:
                    kindly_ask_instance_to_drain_and_wait_start(instance, ec2_clients[instance.region])
                logging.info(f"Instance {instance.instance_id} is now draining...")
                wait_drain.append(instance)
                logging.info(f"Instances to wait for: {', '.join([instance.instance_id for instance in wait_drain])}")
            except Exception as e:
                logging.error(f"Error while asking to drain instance {instance.instance_id}, will restart it anyways: {e}")
                to_restart.append(instance)
                logging.info(f"Instances to restart: {', '.join([instance.instance_id for instance in to_drain])}")

        # Lists should be fairly small, so no point on using sets
        to_drain = [instance for instance in to_drain if instance not in wait_drain and instance not in to_restart]

        for instance in wait_drain:
            if instance.region not in ec2_clients:
                ec2_clients[instance.region] = boto3.client('ec2', region_name=instance.region)

            try:
                if args.dry_run or wait_for_tag(ec2_clients[instance.region], instance.instance_id, DRAIN_SUCCESS_LABEL, 'true', 0, -1):
                    logging.info(f"Instance {instance.instance_id} is now fully drained.")
                    to_restart.append(instance)
                    logging.info(f"Instances to restart: {', '.join([instance.instance_id for instance in to_restart])}")
            except Exception as e:
                logging.error(f"Error while draining instance {instance.instance_id}: {e}")
                to_restart.append(instance)
                logging.info(f"Instances to restart: {', '.join([instance.instance_id for instance in to_restart])}")

        # Lists should be fairly small, so no point on using sets
        wait_drain = [instance for instance in wait_drain if instance not in to_restart]

        for instance in to_restart:
            if instance.region not in ec2_clients:
                ec2_clients[instance.region] = boto3.client('ec2', region_name=instance.region)

            logging.info(f"Removing drain tags from instance {instance.instance_id}...")
            try:
                if not args.dry_run:
                    remove_tags_from_instance(ec2_clients[instance.region], instance.instance_id, [DRAIN_REQUESTED_LABEL, DRAIN_STARTED_LABEL, DRAIN_SUCCESS_LABEL])
                    logging.info(f"Drain tags removed from instance {instance.instance_id}")
            except Exception as e:
                logging.error(f"Error while removing drain tags from instance {instance.instance_id}: {e}")
                try:
                    time.sleep(30)
                    remove_tags_from_instance(ec2_clients[instance.region], instance.instance_id, [DRAIN_REQUESTED_LABEL, DRAIN_STARTED_LABEL, DRAIN_SUCCESS_LABEL])
                    logging.info(f"Drain tags removed from instance {instance.instance_id}")
                except Exception as e:
                    logging.critical(f"Error while removing drain tags from instance {instance.instance_id}: {e}")

            logging.info(f"Restarting instance {instance.instance_id}...")
            try:
                if not args.dry_run:
                    ec2_clients[instance.region].reboot_instances(InstanceIds=[instance.instance_id])
                restarted.append(instance)
                logging.info(f"Instance {instance.instance_id} restarted.")
            except Exception as e:
                logging.error(f"Error while restarting instance {instance.instance_id}: {e}")

        # Lists should be fairly small, so no point on using sets
        to_restart = [instance for instance in to_restart if instance not in restarted]

        if to_drain or wait_drain or to_restart:
            time.sleep(10)

    logging.info(f"Instances restarted: {', '.join([instance.instance_id for instance in restarted])}")


def main() -> None:
    cmds = {
        check_last_ebs_connection.__doc__: check_last_ebs_connection,
        refresh_oldest_ebs_volume.__doc__: refresh_oldest_ebs_volume,
        safely_restart_all_instances.__doc__: safely_restart_all_instances,
    }
    args = get_args()
    logging.basicConfig(level=LOGGING_LEVEL_MAP[args.logging_level], format='%(asctime)s %(message)s')

    if GH_APP_PK_ENVIRON not in os.environ:
        raise Exception(f"Environment variable '{GH_APP_PK_ENVIRON}' not found")

    cmds[args.subcommand](args)


if __name__ == '__main__':
    main()
