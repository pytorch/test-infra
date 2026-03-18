import json
import logging
import re
from pathlib import Path
from typing import Dict, Optional

import requests


# Cache configuration
CACHE_DIR = Path("cache")


class CacheManager:
    """Manages caching of GitHub API responses using URL as cache key."""

    def __init__(self, cache_dir: Path = CACHE_DIR):
        CACHE_DIR.mkdir(exist_ok=True)

        self.cache_dir = cache_dir
        self.cache_dir.mkdir(exist_ok=True)

    def _get_cache_key(self, url: str) -> str:
        """Generate a human-readable cache key from URL."""
        from urllib.parse import parse_qs, urlencode, urlparse

        # Parse the URL to separate path and query parameters
        parsed = urlparse(url)
        path = parsed.path
        query_params = parse_qs(parsed.query)

        # Remove the 'created' parameter from query params to avoid cache invalidation
        if "created" in query_params:
            del query_params["created"]

        # Reconstruct the query string without the 'created' parameter
        if query_params:
            # Flatten single-item lists (parse_qs returns lists)
            flat_params = {}
            for key, values in query_params.items():
                flat_params[key] = values[0] if len(values) == 1 else values
            query_string = urlencode(flat_params)
            # Reconstruct URL without the 'created' parameter
            url_without_created = (
                f"{parsed.scheme}://{parsed.netloc}{path}?{query_string}"
            )
        else:
            # If no query params remain, use the original URL
            url_without_created = url

        # Replace forward slashes with underscores
        key = url_without_created.replace("/", "_")

        # Remove protocol and domain
        key = key.replace("https___api.github.com_", "")

        # Handle illegal filename characters in query parameters
        # Replace characters that are problematic in filenames
        key = re.sub(r'[<>:"|?*]', "_", key)

        # Replace equals signs and ampersands in query params with underscores
        key = key.replace("=", "_").replace("&", "_")

        # Clean up multiple consecutive underscores
        key = re.sub(r"_+", "_", key)

        # Remove trailing underscore
        key = key.rstrip("_")

        return key

    def _get_cache_path(self, url: str) -> Path:
        """Get the cache file path for a given URL."""
        cache_key = self._get_cache_key(url)
        return self.cache_dir / f"{cache_key}.json"

    def get(self, url: str) -> Optional[Dict]:
        """Retrieve cached response for a URL."""
        cache_path = self._get_cache_path(url)
        if cache_path.exists():
            try:
                with open(cache_path, "r") as f:
                    cached_data = json.load(f)
                logging.debug(f"[CacheManager] Cache hit for URL: {url}")
                return cached_data
            except (json.JSONDecodeError, IOError) as e:
                logging.warning(f"[CacheManager] Failed to read cache for {url}: {e}")
                return None
        logging.debug(f"[CacheManager] Cache miss for URL: {url}")
        return None

    def set(self, url: str, data: Dict) -> None:
        """Cache response data for a URL."""
        cache_path = self._get_cache_path(url)
        try:
            with open(cache_path, "w") as f:
                json.dump(data, f, indent=2)
            logging.debug(f"[CacheManager] Cached response for URL: {url}")
        except IOError as e:
            logging.error(f"[CacheManager] Failed to write cache for {url}: {e}")


# Global cache manager instance
cache_manager = CacheManager()


def get_cache_stats():
    """Get statistics about the cache."""
    if not CACHE_DIR.exists():
        return {"total_files": 0, "total_size_mb": 0}

    cache_files = list(CACHE_DIR.glob("*.json"))
    total_size = sum(f.stat().st_size for f in cache_files)

    return {
        "total_files": len(cache_files),
        "total_size_mb": round(total_size / (1024 * 1024), 2),
    }


def clear_cache():
    """Clear all cached data."""
    import shutil

    if CACHE_DIR.exists():
        shutil.rmtree(CACHE_DIR)
        CACHE_DIR.mkdir(exist_ok=True)
        logging.info(f"[clear_cache] Cleared cache directory: {CACHE_DIR}")
    else:
        logging.info(f"[clear_cache] Cache directory does not exist: {CACHE_DIR}")


def make_cached_request(url: str, headers: Dict[str, str]) -> Optional[Dict]:
    """
    Make an HTTP request with caching. Returns the JSON response if successful.

    Args:
        url: The URL to request
        headers: Headers for the request (required)

    Returns:
        JSON response data if successful, None if failed
    """
    # Check cache first
    cached_response = cache_manager.get(url)
    if cached_response:
        logging.info(f"[make_cached_request] Using cached response for: {url}")
        return cached_response

    # Make actual HTTP request
    logging.info(f"[make_cached_request] Making HTTP request to: {url}")
    try:
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        data = response.json()

        # Cache successful response
        cache_manager.set(url, data)
        logging.info(f"[make_cached_request] Successfully cached response for: {url}")
        return data

    except requests.exceptions.RequestException as e:
        logging.error(f"[make_cached_request] HTTP request failed for {url}: {e}")
        return None
    except json.JSONDecodeError as e:
        logging.error(
            f"[make_cached_request] Failed to parse JSON response for {url}: {e}"
        )
        return None
