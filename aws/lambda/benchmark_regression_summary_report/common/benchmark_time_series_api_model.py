import datetime as dt
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import requests



# The data class to provide api response model from get_time_series api


@dataclass
class TimeRange:
    start: str
    end: str


@dataclass
class BenchmarkTimeSeriesItem:
    group_info: Dict[str, Any]
    num_of_dp: int
    data: List[Dict[str, Any]] = field(default_factory=list)
    # catch-all for unknown/extra keys
    extra: Dict[str, Any] = field(default_factory=dict)

    def __init__(self, **kwargs):
        # separate known vs unknown
        known_fields = {f.name for f in self.__dataclass_fields__.values() if f.init}
        init_args = {k: v for k, v in kwargs.items() if k in known_fields}
        object.__setattr__(
            self, "extra", {k: v for k, v in kwargs.items() if k not in known_fields}
        )
        for k, v in init_args.items():
            object.__setattr__(self, k, v)


@dataclass
class BenchmarkTimeSeriesApiData:
    time_series: List[BenchmarkTimeSeriesItem]
    time_range: TimeRange


@dataclass
class BenchmarkTimeSeriesApiResponse:
    data: BenchmarkTimeSeriesApiData

    @classmethod
    def from_request(
        cls, url: str, query: dict, access_token: str, timeout: int = 180
    ) -> "BenchmarkTimeSeriesApiResponse":
        """
        Send a POST request and parse into BenchmarkTimeSeriesApiResponse.

        Args:
            url: API endpoint
            query: JSON payload must
            timeout: max seconds to wait for connect + response (default: 30)
        Returns:
            ApiResponse
        Raises:
            requests.exceptions.RequestException if network/timeout/HTTP error
            RuntimeError if the API returns an "error" field or malformed data
        """

        headers = {
            "x-hud-internal-bot": access_token,
        }
        resp = requests.post(url, json=query, timeout=timeout, headers=headers)
        resp.raise_for_status()
        payload = resp.json()

        if "error" in payload:
            raise RuntimeError(f"API error: {payload['error']}")
        try:
            tr = TimeRange(**payload["data"]["time_range"])
            ts = [
                BenchmarkTimeSeriesItem(**item)
                for item in payload["data"]["data"]["time_series"]
            ]
        except Exception as e:
            raise RuntimeError(f"Malformed API payload: {e}")
        return cls(data=BenchmarkTimeSeriesApiData(time_series=ts, time_range=tr))


def get_latest_meta_info(
    time_series: List[BenchmarkTimeSeriesItem],
) -> Optional[dict[str, Any]]:
    if not time_series:
        return None

    pts = [p for s in time_series for p in s.data]
    latest = max(
        pts,
        key=lambda p: dt.datetime.fromisoformat(
            p["granularity_bucket"].replace("Z", "+00:00")
        ),
    )
    return {
        "commit": latest.get("commit", ""),
        "branch": latest.get("branch", ""),
        "timestamp": latest.get("granularity_bucket", ""),
        "workflow_id": latest.get("workflow_id", ""),
    }
