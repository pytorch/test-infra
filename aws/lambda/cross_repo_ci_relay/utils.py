WHITELIST_LEVELS = ("L1", "L2", "L3", "L4")


class RelayHTTPException(Exception):
    def __init__(self, status_code: int, detail):
        self.status_code = status_code
        self.detail = detail


def parse_allowlist_info_map(raw: dict) -> dict[str, dict]:
    if not isinstance(raw, dict):
        raise RuntimeError(
            f"Invalid whitelist: expected dict (with L1-L4), got {type(raw).__name__}"
        )

    mapping: dict[str, dict] = {}

    for level in WHITELIST_LEVELS:
        entries = raw.get(level) or []
        if not isinstance(entries, list):
            raise RuntimeError(
                f"Invalid whitelist: key {level} must map to a list, got {type(entries).__name__}"
            )
        for idx, entry in enumerate(entries):
            if not isinstance(entry, dict):
                raise RuntimeError(
                    f"Invalid whitelist: {level}[{idx}] must be a dict, got {type(entry).__name__}"
                )
            device = entry.get("device")
            if not device or not isinstance(device, str):
                raise RuntimeError(
                    f"Invalid whitelist: {level}[{idx}].device is required and must be a string"
                )

            repo = entry.get("repo")
            if not repo or not isinstance(repo, str):
                raise RuntimeError(
                    f"Invalid whitelist: {level}[{idx}].repo is required and must be a string"
                )

            url = entry.get("url")
            if not url or not isinstance(url, str):
                raise RuntimeError(
                    f"Invalid whitelist: {level}[{idx}].url is required and must be a string"
                )

            norm_url = url.rstrip("/")
            prev = mapping.get(device)
            if prev and prev.get("url") != norm_url:
                raise RuntimeError(
                    f"Invalid whitelist: device {device!r} has conflicting urls: {prev.get('url')!r} vs {norm_url!r}"
                )

            mapping[device] = {
                "level": level,
                "repo": repo,
                "url": norm_url,
                "oncall": entry.get("oncall") or [],
            }

    return mapping


def pick_repo_full_name_by_allowlist(repos, allow_url: str):
    allow_url_n = allow_url.rstrip("/") if allow_url else None
    matches = [
        repo for repo in repos
        if (repo.get("html_url").rstrip("/") if repo.get("html_url") else None) == allow_url_n
    ]
    if not matches:
        return None
    if len(matches) == 1:
        return matches[0].get("full_name")
    return {"ambiguous": [repo.get("full_name") for repo in matches]}
