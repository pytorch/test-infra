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


@dataclass
class BenchmarkTimeSeriesApiData:
    time_series: List[BenchmarkTimeSeriesItem]
    time_range: TimeRange


@dataclass
class BenchmarkTimeSeriesApiResponse:
    data: BenchmarkTimeSeriesApiData

    @classmethod
    def from_request(
        cls, url: str, query: dict, timeout: int = 180
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
        resp = requests.post(url, json=query, timeout=timeout)
        resp.raise_for_status()
        payload = resp.json()

        if "error" in payload:
            raise RuntimeError(f"API error: {payload['error']}")
        try:
            tr = TimeRange(**payload["data"]["time_range"])
            ts = [
                BenchmarkTimeSeriesItem(**item)
                for item in payload["data"]["time_series"]
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
