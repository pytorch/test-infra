"""
Server Initializer Lambda
Initializes the gpu-servers DynamoDB table with current EKS node information
"""

import json
import os
import boto3
import logging
from typing import Dict, Any, List

# Setup logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# AWS clients
dynamodb = boto3.resource('dynamodb')
eks_client = boto3.client('eks')
ec2_client = boto3.client('ec2')

# Environment variables
SERVERS_TABLE = os.environ['SERVERS_TABLE']
EKS_CLUSTER_NAME = os.environ['EKS_CLUSTER_NAME']
REGION = os.environ['REGION']


def handler(event, context):
    """Main Lambda handler"""
    try:
        logger.info(f"Initializing servers table with event: {json.dumps(event)}")

        # Get EKS node groups
        node_groups = get_node_groups()
        logger.info(f"Found {len(node_groups)} node groups")

        # Get EC2 instances from node groups
        instances = get_gpu_instances_from_nodegroups(node_groups)
        logger.info(f"Found {len(instances)} GPU instances")

        # Initialize servers table
        servers_table = dynamodb.Table(SERVERS_TABLE)
        initialized_count = 0

        for instance in instances:
            server_record = create_server_record(instance, context)

            # Use put_item to create or update the server record
            servers_table.put_item(Item=server_record)
            initialized_count += 1
            logger.info(f"Initialized server: {server_record['server_id']}")

        logger.info(f"Successfully initialized {initialized_count} servers")

        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': f'Successfully initialized {initialized_count} servers',
                'servers': initialized_count
            })
        }

    except Exception as e:
        logger.error(f"Error initializing servers: {str(e)}")
        raise


def get_node_groups() -> List[Dict[str, Any]]:
    """Get EKS node groups for the cluster"""
    try:
        response = eks_client.list_nodegroups(clusterName=EKS_CLUSTER_NAME)
        node_groups = []

        for ng_name in response['nodegroups']:
            ng_detail = eks_client.describe_nodegroup(
                clusterName=EKS_CLUSTER_NAME,
                nodegroupName=ng_name
            )
            node_groups.append(ng_detail['nodegroup'])

        return node_groups

    except Exception as e:
        logger.error(f"Error getting node groups: {str(e)}")
        return []


def get_gpu_instances_from_nodegroups(node_groups: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Get GPU instances from EKS node groups"""
    gpu_instances = []

    try:
        for node_group in node_groups:
            # Check if this is a GPU node group (contains gpu in name or uses GPU instance types)
            ng_name = node_group.get('nodegroupName', '')
            instance_types = node_group.get('instanceTypes', [])

            # If using launch template, get instance type from there
            if not instance_types and 'launchTemplate' in node_group:
                launch_template = node_group['launchTemplate']
                lt_id = launch_template.get('id')
                lt_version = launch_template.get('version', '$Latest')

                if lt_id:
                    try:
                        lt_response = ec2_client.describe_launch_template_versions(
                            LaunchTemplateId=lt_id,
                            Versions=[lt_version]
                        )
                        if lt_response['LaunchTemplateVersions']:
                            lt_data = lt_response['LaunchTemplateVersions'][0]['LaunchTemplateData']
                            if 'InstanceType' in lt_data:
                                instance_types = [lt_data['InstanceType']]
                                logger.info(f"Found instance type in launch template: {instance_types}")
                    except Exception as e:
                        logger.warning(f"Could not get launch template details: {e}")

            # Skip if we still have no instance types or if node group name suggests it's GPU
            if not instance_types:
                if 'gpu' in ng_name.lower():
                    logger.warning(f"GPU node group {ng_name} has no detectable instance types, assuming GPU")
                    # Continue processing as GPU node group
                else:
                    logger.info(f"Skipping node group with no instance types: {ng_name}")
                    continue

            # Filter for GPU instance types (g4dn, p3, p4, p5, etc.)
            gpu_instance_types = [it for it in instance_types
                                  if any(gpu_family in it.lower() for gpu_family in ['g4dn', 'g4ad', 'g5', 'p3', 'p4', 'p5'])]

            if not gpu_instance_types and 'gpu' not in ng_name.lower():
                logger.info(f"Skipping non-GPU node group: {ng_name} (types: {instance_types})")
                continue

            logger.info(f"Processing GPU node group: {ng_name} with types: {gpu_instance_types or 'inferred GPU'}")

            # Get Auto Scaling Group name from node group
            asg_name = None
            if 'resources' in node_group and 'autoScalingGroups' in node_group['resources']:
                for asg in node_group['resources']['autoScalingGroups']:
                    asg_name = asg['name']
                    break

            if not asg_name:
                logger.warning(f"No ASG found for node group: {ng_name}")
                continue

            # Get EC2 instances from ASG by using tags
            instances = ec2_client.describe_instances(
                Filters=[
                    {
                        'Name': 'tag:aws:autoscaling:groupName',
                        'Values': [asg_name]
                    },
                    {
                        'Name': 'instance-state-name',
                        'Values': ['running', 'pending']
                    }
                ]
            )

            for reservation in instances['Reservations']:
                for instance in reservation['Instances']:
                    instance_type = instance['InstanceType']
                    if any(gpu_family in instance_type.lower() for gpu_family in ['g4dn', 'g4ad', 'g5', 'p3', 'p4', 'p5']):
                        gpu_instances.append({
                            'instance_id': instance['InstanceId'],
                            'instance_type': instance_type,
                            'private_ip': instance.get('PrivateIpAddress'),
                            'state': instance['State']['Name'],
                            'node_group': ng_name
                        })

        return gpu_instances

    except Exception as e:
        logger.error(f"Error getting GPU instances: {str(e)}")
        return []


def create_server_record(instance: Dict[str, Any], context=None) -> Dict[str, Any]:
    """Create a server record for DynamoDB"""
    instance_type = instance['instance_type']

    # Map instance types to GPU counts
    gpu_count_map = {
        'g4dn.xlarge': 1,
        'g4dn.2xlarge': 1,
        'g4dn.4xlarge': 1,
        'g4dn.8xlarge': 1,
        'g4dn.12xlarge': 4,
        'g4dn.16xlarge': 1,
        'g5.xlarge': 1,
        'g5.2xlarge': 1,
        'g5.4xlarge': 1,
        'g5.8xlarge': 1,
        'g5.12xlarge': 4,
        'g5.16xlarge': 1,
        'g5.24xlarge': 4,
        'g5.48xlarge': 8,
        'p3.2xlarge': 1,
        'p3.8xlarge': 4,
        'p3.16xlarge': 8,
        'p3dn.24xlarge': 8,
        'p4d.24xlarge': 8,
        'p5.48xlarge': 8
    }

    gpu_count = gpu_count_map.get(instance_type, 1)

    return {
        'server_id': instance['instance_id'],
        'instance_type': instance_type,
        'private_ip': instance.get('private_ip', 'unknown'),
        'node_group': instance.get('node_group', 'unknown'),
        'status': 'available',
        'gpu_count': gpu_count,
        'available_gpus': gpu_count,  # Initially all GPUs are available
        'allocated_gpus': 0,
        'state': instance.get('state', 'unknown'),
        'last_updated': context.aws_request_id if context else 'unknown'
    }
