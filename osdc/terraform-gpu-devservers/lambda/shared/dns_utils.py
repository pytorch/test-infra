"""
DNS utilities for Route53 record management
"""

import logging
import os
import random
import time
from typing import List, Optional

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

# Environment variables
DOMAIN_NAME = os.environ.get("DOMAIN_NAME", "")
HOSTED_ZONE_ID = os.environ.get("HOSTED_ZONE_ID", "")

# Route53 client
route53_client = boto3.client("route53")

# Name generation lists
ADJECTIVES = [
    "brave", "clever", "swift", "mighty", "gentle", "bright", "calm", "bold",
    "cheerful", "eager", "quick", "wise", "kind", "loyal", "proud", "strong",
    "happy", "lucky", "smart", "noble", "keen", "agile", "sharp", "witty",
    "fierce", "steady", "quiet", "wild", "free", "rare", "pure", "cool",
    "warm", "fresh", "crisp", "smooth", "solid", "grand", "fine", "neat",
    "tough", "light", "dark", "deep", "high", "fast", "slow", "old", "new",
    # Additional adjectives for more variety
    "silent", "stormy", "sunny", "misty", "foggy", "snowy", "windy", "cloudy",
    "golden", "silver", "copper", "bronze", "crystal", "diamond", "ruby", "emerald",
    "scarlet", "crimson", "azure", "violet", "amber", "jade", "coral", "ivory",
    "velvet", "silk", "satin", "leather", "marble", "granite", "steel", "iron",
    "ancient", "modern", "cosmic", "stellar", "lunar", "solar", "arctic", "desert",
    "mountain", "valley", "forest", "ocean", "river", "lake", "meadow", "prairie",
    "mystic", "magic", "electric", "atomic", "cyber", "digital", "quantum", "neural"
]

ANIMALS = [
    "bear", "wolf", "fox", "eagle", "hawk", "lion", "tiger", "panda",
    "owl", "raven", "deer", "elk", "moose", "bison", "otter", "seal",
    "whale", "dolphin", "shark", "turtle", "penguin", "falcon", "sparrow",
    "robin", "blue", "cardinal", "jay", "crow", "finch", "wren",
    "cat", "dog", "horse", "rabbit", "squirrel", "chipmunk", "beaver",
    "raccoon", "skunk", "possum", "bat", "mouse", "rat", "hamster",
    "ferret", "mink", "stoat", "weasel", "badger", "wolverine",
    "leopard", "cheetah", "lynx", "bobcat", "cougar", "jaguar",
    "zebra", "giraffe", "elephant", "rhino", "hippo", "buffalo",
    "antelope", "gazelle", "impala", "kudu", "oryx", "springbok",
    # Additional animals for more variety
    "kangaroo", "koala", "platypus", "echidna", "wallaby", "wombat", "dingo", "tasmanian",
    "mongoose", "meerkat", "lemur", "sloth", "armadillo", "anteater", "capybara", "chinchilla",
    "hedgehog", "porcupine", "pangolin", "aardvark", "okapi", "tapir", "manatee", "dugong",
    "narwhal", "beluga", "orca", "walrus", "seahorse", "starfish", "octopus", "squid",
    "crab", "lobster", "shrimp", "jellyfish", "barracuda", "marlin", "swordfish", "tuna",
    "salmon", "trout", "bass", "pike", "carp", "catfish", "goldfish", "angelfish",
    "butterfly", "dragonfly", "firefly", "beetle", "mantis", "cricket", "grasshopper", "ant",
    "bee", "wasp", "hornet", "spider", "scorpion", "gecko", "iguana", "chameleon"
]


def generate_random_name() -> str:
    """Generate a random name like 'grumpy_bear' or 'clever_fox'."""
    adjective = random.choice(ADJECTIVES)
    animal = random.choice(ANIMALS)
    return f"{adjective}_{animal}"


def sanitize_name(name: str) -> str:
    """Sanitize a user-provided name to be DNS-safe."""
    if not name:
        return ""

    # Convert to lowercase
    name = name.lower()

    # Replace invalid characters with hyphens, but keep underscores
    sanitized = ""
    for char in name:
        if char.islower() or char.isdigit() or char == '_':
            sanitized += char
        elif char in [' ', '.', '-']:
            sanitized += '-'

    # Remove consecutive hyphens
    while '--' in sanitized:
        sanitized = sanitized.replace('--', '-')

    # Remove leading/trailing hyphens and underscores
    sanitized = sanitized.strip('-_')

    # Truncate to 63 characters
    if len(sanitized) > 63:
        sanitized = sanitized[:63].rstrip('-_')

    return sanitized if sanitized else generate_random_name()


def is_reserved_name(name: str) -> bool:
    """
    Check if a name is reserved and cannot be used.

    Args:
        name: The name to check

    Returns:
        bool: True if the name is reserved
    """
    reserved_names = ["www", "api", "admin", "root", "mail", "ftp", "ns", "ns1", "ns2"]

    # Get domain name to check if we're in prod
    domain_name = os.environ.get("DOMAIN_NAME", "")
    is_prod_domain = domain_name == "devservers.io"

    # In production, 'test' is reserved to prevent conflicts with test.devservers.io
    if is_prod_domain and name.lower() == "test":
        logger.warning(f"Name 'test' is reserved in production to prevent conflict with test.devservers.io")
        return True

    # Other reserved names apply to all environments
    if name.lower() in reserved_names:
        logger.warning(f"Name '{name}' is reserved")
        return True

    return False


def get_existing_dns_names() -> List[str]:
    """Get list of existing DNS names from active reservations only."""
    # Import here to avoid circular imports
    import boto3
    import os

    if not DOMAIN_NAME or not HOSTED_ZONE_ID:
        return []

    # Get active reservations from DynamoDB instead of scanning Route53
    # This ensures we only consider active reservations for duplicate checking
    table_name = os.environ.get("SSH_DOMAIN_MAPPINGS_TABLE", "")
    if not table_name:
        return []

    try:
        dynamodb = boto3.resource("dynamodb")
        table = dynamodb.Table(table_name)

        # Scan for all active domain mappings
        response = table.scan()
        existing_names = []

        for item in response.get('Items', []):
            # Check if the reservation is still active
            reservation_id = item.get('reservation_id')
            if reservation_id:
                # Quick check: if expires_at is in the future, consider it active
                # The exact status will be verified during actual reservation creation
                expires_at = item.get('expires_at', 0)
                if expires_at > time.time():
                    existing_names.append(item.get('domain_name'))

        return existing_names
    except Exception as e:
        logger.warning(f"Failed to get existing domain names from mappings: {str(e)}")

        # Fallback to Route53 scan if DynamoDB fails
        try:
            existing_names = []
            paginator = route53_client.get_paginator('list_resource_record_sets')

            for page in paginator.paginate(HostedZoneId=HOSTED_ZONE_ID):
                for record in page['ResourceRecordSets']:
                    if record['Type'] == 'A' and record['Name'].endswith(f'.{DOMAIN_NAME}.'):
                        # Extract subdomain name
                        name = record['Name'].replace(f'.{DOMAIN_NAME}.', '')
                        existing_names.append(name)

            return existing_names
        except Exception as fallback_error:
            logger.warning(f"Route53 fallback also failed: {str(fallback_error)}")
            return []


def generate_unique_name(preferred_name: Optional[str] = None) -> str:
    """Generate a unique DNS name, avoiding conflicts and reserved names."""
    existing_names = get_existing_dns_names()

    if preferred_name:
        base_name = sanitize_name(preferred_name)
        if not base_name:
            base_name = generate_random_name()

        # Check if the name is reserved
        if is_reserved_name(base_name):
            logger.warning(f"Name '{base_name}' is reserved, generating alternative")
            # Generate a variation of the reserved name
            base_name = f"{base_name}-alt"
    else:
        base_name = generate_random_name()

    # Check if base name is available and not reserved
    if base_name not in existing_names and not is_reserved_name(base_name):
        return base_name

    # Try numbered variations
    for i in range(2, 1000):
        candidate = f"{base_name}-{i}"
        if len(candidate) <= 63 and candidate not in existing_names and not is_reserved_name(candidate):
            return candidate

    # If we can't find a unique variation, generate completely random names
    for _ in range(100):  # Try 100 random names
        random_name = generate_random_name()
        if random_name not in existing_names and not is_reserved_name(random_name):
            return random_name

    # Last resort: use timestamp-based name
    timestamp_name = f"dev-{int(time.time())}"
    return timestamp_name


def create_dns_record(subdomain: str, target_ip: str, target_port: int) -> bool:
    """
    Create DNS CNAME record pointing to ALB for a reservation.

    Args:
        subdomain: The subdomain name (e.g., 'grumpybear')
        target_ip: Unused (kept for backwards compatibility)
        target_port: The port number (stored in TXT record for reference)

    Returns:
        bool: True if successful, False otherwise
    """
    import os

    if not DOMAIN_NAME or not HOSTED_ZONE_ID:
        logger.info("Domain name not configured, skipping DNS record creation")
        return True  # Not an error if DNS is not configured

    # Get ALB DNS name from environment
    alb_dns = os.environ.get("JUPYTER_ALB_DNS", "")
    if not alb_dns:
        logger.error("JUPYTER_ALB_DNS not configured, cannot create DNS record")
        return False

    try:
        fqdn = f"{subdomain}.{DOMAIN_NAME}"

        # Create CNAME record pointing to ALB
        change_batch = {
            'Changes': [
                {
                    'Action': 'CREATE',
                    'ResourceRecordSet': {
                        'Name': fqdn,
                        'Type': 'CNAME',
                        'TTL': 60,  # 1 minute TTL
                        'ResourceRecords': [{'Value': alb_dns}]
                    }
                },
                {
                    'Action': 'CREATE',
                    'ResourceRecordSet': {
                        'Name': f"_port.{fqdn}",
                        'Type': 'TXT',
                        'TTL': 60,
                        'ResourceRecords': [{'Value': f'"{target_port}"'}]
                    }
                }
            ]
        }

        response = route53_client.change_resource_record_sets(
            HostedZoneId=HOSTED_ZONE_ID,
            ChangeBatch=change_batch
        )

        change_id = response['ChangeInfo']['Id']
        logger.info(f"Created DNS CNAME record {fqdn} -> {alb_dns} (Change ID: {change_id})")
        return True

    except ClientError as e:
        error_code = e.response['Error']['Code']
        if error_code == 'InvalidChangeBatch':
            logger.warning(f"DNS record {subdomain}.{DOMAIN_NAME} may already exist")
        else:
            logger.error(f"Failed to create DNS record: {str(e)}")
        return False
    except Exception as e:
        logger.error(f"Unexpected error creating DNS record: {str(e)}")
        return False


def delete_dns_record(subdomain: str, target_ip: str, target_port: int) -> bool:
    """
    Delete DNS A record for a reservation.

    Args:
        subdomain: The subdomain name (e.g., 'grumpybear')
        target_ip: The IP address that was pointed to
        target_port: The port number

    Returns:
        bool: True if successful, False otherwise
    """
    if not DOMAIN_NAME or not HOSTED_ZONE_ID:
        logger.info("Domain name not configured, skipping DNS record deletion")
        return True  # Not an error if DNS is not configured

    try:
        fqdn = f"{subdomain}.{DOMAIN_NAME}"

        # Delete A record and TXT record
        change_batch = {
            'Changes': [
                {
                    'Action': 'DELETE',
                    'ResourceRecordSet': {
                        'Name': fqdn,
                        'Type': 'A',
                        'TTL': 60,
                        'ResourceRecords': [{'Value': target_ip}]
                    }
                },
                {
                    'Action': 'DELETE',
                    'ResourceRecordSet': {
                        'Name': f"_port.{fqdn}",
                        'Type': 'TXT',
                        'TTL': 60,
                        'ResourceRecords': [{'Value': f'"{target_port}"'}]
                    }
                }
            ]
        }

        response = route53_client.change_resource_record_sets(
            HostedZoneId=HOSTED_ZONE_ID,
            ChangeBatch=change_batch
        )

        change_id = response['ChangeInfo']['Id']
        logger.info(f"Deleted DNS record {fqdn} (Change ID: {change_id})")
        return True

    except ClientError as e:
        error_code = e.response['Error']['Code']
        if error_code == 'InvalidChangeBatch':
            logger.warning(f"DNS record {subdomain}.{DOMAIN_NAME} may not exist or values don't match")
        else:
            logger.error(f"Failed to delete DNS record: {str(e)}")
        return False
    except Exception as e:
        logger.error(f"Unexpected error deleting DNS record: {str(e)}")
        return False


def get_dns_enabled() -> bool:
    """Check if DNS is enabled (domain name configured)."""
    return bool(DOMAIN_NAME and HOSTED_ZONE_ID)


def format_ssh_command_with_domain(subdomain: str, target_port: int) -> str:
    """
    Format SSH command using domain name if available, otherwise return empty string.

    Args:
        subdomain: The subdomain name
        target_port: The SSH port

    Returns:
        str: SSH command with domain, or empty string if DNS not configured
    """
    if not DOMAIN_NAME:
        return ""

    return f"ssh -p {target_port} dev@{subdomain}.{DOMAIN_NAME}"


def store_domain_mapping(subdomain: str, target_ip: str, target_port: int, reservation_id: str, expires_at: int) -> bool:
    """
    Store domain mapping in DynamoDB for tracking purposes.

    Args:
        subdomain: The subdomain name
        target_ip: The target IP address
        target_port: The target port
        reservation_id: The reservation ID
        expires_at: Unix timestamp when mapping expires

    Returns:
        bool: True if successful, False otherwise
    """
    # Import DynamoDB client here to avoid circular imports
    import boto3
    import os

    table_name = os.environ.get("SSH_DOMAIN_MAPPINGS_TABLE", "")
    if not table_name:
        logger.info("SSH domain mappings table not configured")
        return True

    try:
        dynamodb = boto3.resource("dynamodb")
        table = dynamodb.Table(table_name)

        table.put_item(
            Item={
                'domain_name': subdomain,
                'node_ip': target_ip,  # Proxy expects 'node_ip'
                'node_port': target_port,  # Proxy expects 'node_port'
                'reservation_id': reservation_id,
                'expires_at': expires_at
            }
        )

        logger.info(f"Stored domain mapping: {subdomain} -> {target_ip}:{target_port}")
        return True

    except Exception as e:
        logger.error(f"Failed to store domain mapping: {str(e)}")
        return False


def delete_domain_mapping(subdomain: str) -> bool:
    """
    Delete domain mapping from DynamoDB.

    Args:
        subdomain: The subdomain name

    Returns:
        bool: True if successful, False otherwise
    """
    # Import DynamoDB client here to avoid circular imports
    import boto3
    import os

    table_name = os.environ.get("SSH_DOMAIN_MAPPINGS_TABLE", "")
    if not table_name:
        logger.info("SSH domain mappings table not configured")
        return True

    try:
        dynamodb = boto3.resource("dynamodb")
        table = dynamodb.Table(table_name)

        table.delete_item(Key={'domain_name': subdomain})

        logger.info(f"Deleted domain mapping: {subdomain}")
        return True

    except Exception as e:
        logger.error(f"Failed to delete domain mapping: {str(e)}")
        return False