from typing import Any, Dict, List
from collections import defaultdict

"""
{
    "queue_s": 21824,
    "repo": "pytorch/pytorch",
    "workflow_name": "trunk",
    "job_name": "macos-py3-arm64-mps / test (mps, 1, 1, macos-m2-15)",
    "html_url": "https://github.com/pytorch/pytorch/actions/runs/14231407191/job/39883073374",
    "queue_start_at": 1743636376,
    "queue_stop_at": 1743636376,
    "machine_type": "macos-m2-15",
    "time": 1743658200,
    "tags": [
        "queued"
    ],
    "runner_labels": [
        "pet",
        "macos",
        "all",
        "meta",
        "other"
    ]
}
"""

"""
(
    `created_time` DateTime64(9),
    `type` String,
    `repo` String,
    `workflow_name` String,
    `job_name` String,
    `machine_type` String,
    `histogram_version` String,
    `histogram` Array(UInt64),
    `max_queue_time` UInt64,
    `avg_queue_time` UInt64,
    `total_count` UInt64,
    `time` DateTime64(9),
    `runner_labels` Array(String),
    `extra_info` Map(String, String)
)

"""


# class QueueTimeHistogramGenerator:
def generate(results: List[Dict[str, Any]]):
    groupByJobNames = group_by(results)
    return


def group_by(results: List[Dict[str, Any]], created_time: str) -> List[Dict[str, Any]]:
    queues_dict = defaultdict(list)
    metadata_dict = defaultdict(dict)
    for result in results:
        queues_dict[result["job_name"]].append(result["queue_s"])
        if result["job_name"] not in metadata_dict:
            metadata_dict[result["job_name"]] = {
                "created_time": created_time,
                "repo": result["repo"],
                "workflow_name": result["workflow_name"],
                "job_name": result["job_name"],
                "machine_type": result["machine_type"],
                "time": result["time"],
            }

    return [metadata_dict, queues_dict]


def generate_histogram_by_group(data: List[Dict[str, Any]]):
    if len(data) == 0:
        return {}
