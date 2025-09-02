
from dataclasses import dataclass, field
from os import error
from typing import Any, Dict, List, Optional


@dataclass
class TimeRange:
    start: str
    end: str

@dataclass
class TimeSeriesItem:
    group_info: Dict[str, Any]  # flexible, could make a stricter dataclass if schema is known
    num_of_dp: int
    data: List[Dict[str, Any]] = field(default_factory=list)

@dataclass
class ApiData:
    time_series: List[TimeSeriesItem]
    time_range: TimeRange


@dataclass
class ApiResponse:
    data: Optional[ApiData] = None   # present if success
    error: Optional[str] = None      # present if failure
