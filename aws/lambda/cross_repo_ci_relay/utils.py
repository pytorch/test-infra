from typing import TypedDict


class HTTPException(Exception):
    def __init__(self, status_code: int, detail):
        self.status_code = status_code
        self.detail = detail


class PRDispatchPayload(TypedDict):
    upstream_repo: str
    head_sha: str
    pr_number: int
    head_ref: str
    base_ref: str
