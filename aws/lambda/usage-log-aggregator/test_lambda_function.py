import os
from unittest.mock import AsyncMock

import pytest
from lambda_function import (
    _get_usage_log_prefix,
    _process_raw_logs,
    ARTIFACTS_S3_BUCKET,
    get_usage_log,
    PYTORCH,
    RUN_ATTEMPT,
)

TEST_SAMPLES_DIR = "test_samples"
NUMBER_OF_SAMPLES = 2
TEST_PREFIX = "test_usage_log"


@pytest.mark.asyncio
async def test_get_usage_log_prefix():
    cases = [
        {
            "job_name": "win-vs2019-cpu-py3 / test (functorch, 2, 4, windows.4xlarge)",
            "expected": "usage-log-test-functorch-2-4-windows.4xlarge",
        },
        {
            "job_name": "not matched",
            "expected": "",
        },
    ]

    for case in cases:
        v = await _get_usage_log_prefix(case["job_name"])
        assert v == case["expected"]


@pytest.mark.asyncio
async def test_process_raw_logs():
    def _read_sample(job_id: int):
        filepath = os.path.join(TEST_SAMPLES_DIR, f"{TEST_PREFIX}_{job_id}.txt")

        if not os.path.exists(filepath):
            return str(job_id), str(job_id), ""
        else:
            with open(filepath) as f:
                return str(job_id), str(job_id), f.read()

    raw_logs = [_read_sample(i) for i in range(NUMBER_OF_SAMPLES)]
    r = await _process_raw_logs(raw_logs=raw_logs)
    assert r == {
        "timestamp": ["2022-09-27 23:05:00"],
        "cpu": [
            7.0,
        ],
        "mem": [
            31277056.0,
        ],
        "gpu": [
            48.0,
        ],
        "gpu_mem": [
            0.0,
        ],
        "jobs": {
            "0 / 0": {
                "start_time": 0,
                "stop_time": 0,
            },
            "1 / 1": {
                "start_time": "2022-09-27T23:05:31.560282Z",
                "stop_time": "2022-09-27T23:05:32.586222Z",
            },
        },
    }


@pytest.mark.asyncio
async def test_get_usage_log():
    def _effect(Bucket: str, Key: str):
        # Get the filename
        filename = Key.split("/")[-1]
        filepath = os.path.join(TEST_SAMPLES_DIR, filename)

        if not os.path.exists(filepath):
            return

        with open(filepath, "rb") as f:
            another_mock = AsyncMock()
            another_mock.read.return_value = f.read()
            return {"Body": another_mock}

    ids = [str(i) for i in range(NUMBER_OF_SAMPLES)]
    m = AsyncMock()
    m.get_object.side_effect = _effect

    async for (_, job_id, content) in get_usage_log(
        s3_client=m,
        owner=PYTORCH,
        repo=PYTORCH,
        prefix=TEST_PREFIX,
        workflow_ids=ids,
        job_ids=ids,
    ):
        expected_filepath = os.path.join(
            TEST_SAMPLES_DIR, f"{TEST_PREFIX}_{job_id}.txt"
        )

        if not os.path.exists(expected_filepath):
            assert content == ""
        else:
            with open(expected_filepath) as f:
                assert content == f.read()

    for i in range(NUMBER_OF_SAMPLES):
        key = f"{PYTORCH}/{PYTORCH}/{i}/{RUN_ATTEMPT}/artifact/{TEST_PREFIX}_{i}.zip"
        m.get_object.assert_any_call(Bucket=ARTIFACTS_S3_BUCKET, Key=key)
