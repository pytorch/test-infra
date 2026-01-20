"""
Name utilities for GPU reservations
Provides name sanitization for user input
"""

from typing import List


def is_valid_name(name: str) -> bool:
    """
    Check if a name is valid for DNS hostnames.

    Args:
        name: The name to validate

    Returns:
        bool: True if the name is valid for DNS
    """
    if not name:
        return False

    # DNS hostname rules:
    # - 1-63 characters
    # - Only lowercase letters, numbers, and hyphens
    # - Cannot start or end with hyphen
    # - Cannot have consecutive hyphens

    if len(name) > 63 or len(name) < 1:
        return False

    if name.startswith('-') or name.endswith('-'):
        return False

    if '--' in name:
        return False

    # Check characters
    for char in name:
        if not (char.islower() or char.isdigit() or char == '-'):
            return False

    return True


def sanitize_name(name: str) -> str:
    """
    Sanitize a user-provided name to be DNS-safe.

    Args:
        name: The name to sanitize

    Returns:
        str: A DNS-safe version of the name
    """
    if not name:
        return ""

    # Convert to lowercase
    name = name.lower()

    # Replace invalid characters with hyphens
    sanitized = ""
    for char in name:
        if char.islower() or char.isdigit():
            sanitized += char
        elif char in [' ', '_', '.']:
            sanitized += '-'
        # Skip other invalid characters

    # Remove consecutive hyphens
    while '--' in sanitized:
        sanitized = sanitized.replace('--', '-')

    # Remove leading/trailing hyphens
    sanitized = sanitized.strip('-')

    # Truncate to 63 characters
    if len(sanitized) > 63:
        sanitized = sanitized[:63].rstrip('-')

    return sanitized  # Empty string if sanitization fails - Lambda will generate name


def generate_unique_name(existing_names: List[str], preferred_name: str = None) -> str:
    """
    Generate a unique name, avoiding conflicts with existing names.

    Args:
        existing_names: List of names already in use
        preferred_name: Preferred name (will try variations if taken)

    Returns:
        str: A unique name
    """
    if preferred_name:
        # Sanitize the preferred name
        base_name = sanitize_name(preferred_name)

        if not base_name:
            # If sanitization fails, this function shouldn't be called
            raise ValueError("Invalid preferred name and no fallback available")
    else:
        # This function shouldn't be called without a preferred name
        raise ValueError("generate_unique_name called without preferred_name - use Lambda instead")

    # Check if base name is available
    if base_name not in existing_names:
        return base_name

    # Try numbered variations
    for i in range(2, 1000):  # Try up to 999
        candidate = f"{base_name}-{i}"
        if len(candidate) <= 63 and candidate not in existing_names:
            return candidate

    # If we can't find a unique variation, this shouldn't happen in CLI context
    raise ValueError(f"Could not generate unique name for '{preferred_name}' after trying 999 variations")