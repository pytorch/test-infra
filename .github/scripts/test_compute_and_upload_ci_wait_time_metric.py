from unittest import main, TestCase

import numpy as np

import pandas as pd

from compute_and_upload_ci_wait_time_metric import (
    get_pr_level_stats,
    normalize_start_times,
    remove_cancelled_jobs,
    remove_irrelevant_failure_jobs,
    remove_irrelevant_success_jobs,
)


def normalize_workflow_runs(records: pd.DataFrame) -> pd.DataFrame:
    records["start_time"] = pd.to_datetime(records["start_time"])
    records["end_time"] = pd.to_datetime(records["end_time"])
    return records


class TestComputeAndUploadCiWaitTimeMetric(TestCase):
    def assertDataFramesAreEqual(self, df1: pd.DataFrame, df2: pd.DataFrame):
        # Validate the results. We use numpy because the indexes on the dataframes is expected to be different
        self.assertTrue(np.array_equal(df1.values, df2.values))

    def test_removing_cancelled_jobs(self):
        records = pd.json_normalize(
            [
                {
                    "conclusion": "cancelled",
                    "was_cancelled": True,
                    "duration_mins": 305,
                    "sha": "12345",
                },
                {
                    "conclusion": "cancelled",
                    "was_cancelled": True,
                    "duration_mins": 23,
                    "sha": "aaaaa",
                },
                {
                    "conclusion": "success",
                    "was_cancelled": False,
                    "duration_mins": 15,
                    "sha": "aaaaa",
                },
                {
                    "conclusion": "cancelled",
                    "was_cancelled": True,
                    "duration_mins": 23,
                    "sha": "bbbbb",
                },
                {
                    "conclusion": "failure",
                    "was_cancelled": False,
                    "duration_mins": 10,
                    "sha": "bbbbb",
                },
            ]
        )

        expected = pd.json_normalize(
            [
                {
                    "conclusion": "failure",
                    "was_cancelled": True,
                    "duration_mins": 305,
                    "sha": "12345",
                },
                {
                    "conclusion": "failure",
                    "was_cancelled": False,
                    "duration_mins": 10,
                    "sha": "bbbbb",
                },
            ]
        )

        actual = remove_cancelled_jobs(records)
        self.assertDataFramesAreEqual(actual, expected)

    def test_normalizing_start_times(self):
        records = pd.json_normalize(
            [
                {
                    "run_attempt": 1,
                    "workflow_run_id": 10,
                    "start_time": "2021-01-01T00:00:00Z",
                    "end_time": "2021-01-01T00:10:00Z",
                    "sha": "12345",
                },
                {
                    "run_attempt": 1,
                    "workflow_run_id": 10,
                    "start_time": "2021-01-01T00:05:00Z",
                    "end_time": "2021-01-01T00:15:00Z",
                    "sha": "12345",
                },
                {
                    "run_attempt": 2,
                    "workflow_run_id": 11,
                    "start_time": "2021-01-01T01:05:00Z",
                    "end_time": "2021-01-01T01:15:00Z",
                    "sha": "12345",
                },
                {
                    "run_attempt": 1,
                    "workflow_run_id": 12,
                    "start_time": "2021-02-01T00:00:00Z",
                    "end_time": "2021-02-01T00:10:00Z",
                    "sha": "6789",
                },
                {
                    "run_attempt": 1,
                    "workflow_run_id": 12,
                    "start_time": "2021-02-01T00:05:00Z",
                    "end_time": "2021-02-01T00:15:00Z",
                    "sha": "6789",
                },
            ]
        )

        expected = pd.json_normalize(
            [
                {
                    "run_attempt": 1,
                    "workflow_run_id": 10,
                    "start_time": "2021-01-01T00:00:00Z",
                    "end_time": "2021-01-01T00:10:00Z",
                    "sha": "12345",
                    "duration_mins": 10.0,
                },
                {
                    "run_attempt": 1,
                    "workflow_run_id": 10,
                    "start_time": "2021-01-01T00:00:00Z",
                    "end_time": "2021-01-01T00:15:00Z",
                    "sha": "12345",
                    "duration_mins": 15.0,
                },
                {
                    "run_attempt": 2,
                    "workflow_run_id": 11,
                    "start_time": "2021-01-01T01:05:00Z",
                    "end_time": "2021-01-01T01:15:00Z",
                    "sha": "12345",
                    "duration_mins": 10.0,
                },
                {
                    "run_attempt": 1,
                    "workflow_run_id": 12,
                    "start_time": "2021-02-01T00:00:00Z",
                    "end_time": "2021-02-01T00:10:00Z",
                    "sha": "6789",
                    "duration_mins": 10.0,
                },
                {
                    "run_attempt": 1,
                    "workflow_run_id": 12,
                    "start_time": "2021-02-01T00:00:00Z",
                    "end_time": "2021-02-01T00:15:00Z",
                    "sha": "6789",
                    "duration_mins": 15.0,
                },
            ]
        )

        records = normalize_workflow_runs(records)
        expected = normalize_workflow_runs(expected)

        # Rearrange the colums for the later comparison
        actual = normalize_start_times(records)[
            [
                "run_attempt",
                "workflow_run_id",
                "start_time",
                "end_time",
                "sha",
                "duration_mins",
            ]
        ]
        self.assertDataFramesAreEqual(actual, expected)

    def test_remove_irrelevant_success_jobs(self):
        records = normalize_workflow_runs(
            pd.json_normalize(
                [
                    {
                        "run_attempt": 1,
                        "workflow_run_id": 10,
                        "sha": "12345",
                        "conclusion": "success",
                        "start_time": "2021-01-01T00:00:00Z",
                        "end_time": "2021-01-01T01:50:00Z",
                    },
                    {
                        "run_attempt": 1,
                        "workflow_run_id": 10,
                        "sha": "12345",
                        "conclusion": "failure",
                        "start_time": "2021-01-01T00:05:00Z",
                        "end_time": "2021-01-01T00:25:00Z",
                    },
                    {
                        "run_attempt": 1,
                        "workflow_run_id": 11,
                        "sha": "4566",
                        "conclusion": "success",
                        "start_time": "2021-01-01T00:05:00Z",
                        "end_time": "2021-01-01T01:05:00Z",
                    },
                    {
                        "run_attempt": 1,
                        "workflow_run_id": 11,
                        "sha": "4566",
                        "conclusion": "success",
                        "start_time": "2021-01-01T00:15:00Z",
                        "end_time": "2021-01-01T00:50:00Z",
                    },
                ]
            )
        )

        expected = normalize_workflow_runs(
            pd.json_normalize(
                [
                    {
                        "run_attempt": 1,
                        "workflow_run_id": 10,
                        "sha": "12345",
                        "conclusion": "failure",
                        "start_time": "2021-01-01T00:00:00Z",
                        "end_time": "2021-01-01T00:25:00Z",
                        "duration_mins": 25.0,
                    },
                    {
                        "run_attempt": 1,
                        "workflow_run_id": 11,
                        "sha": "4566",
                        "conclusion": "success",
                        "start_time": "2021-01-01T00:05:00Z",
                        "end_time": "2021-01-01T01:05:00Z",
                        "duration_mins": 60.0,
                    },
                ]
            )
        )

        # Rearrange coluns for the comparison later
        actual = remove_irrelevant_success_jobs(records)[
            [
                "run_attempt",
                "workflow_run_id",
                "sha",
                "conclusion",
                "start_time",
                "end_time",
                "duration_mins",
            ]
        ]
        self.assertDataFramesAreEqual(actual, expected)

    def test_remove_irrelevant_failure_jobs(self):
        records = normalize_workflow_runs(
            pd.json_normalize(
                [
                    {
                        "run_attempt": 1,
                        "workflow_run_id": 10,
                        "sha": "12345",
                        "conclusion": "failure",
                        "start_time": "2021-01-01T00:00:00Z",
                        "end_time": "2021-01-01T01:50:00Z",
                    },
                    {
                        "run_attempt": 1,
                        "workflow_run_id": 10,
                        "sha": "12345",
                        "conclusion": "failure",
                        "start_time": "2021-01-01T00:05:00Z",
                        "end_time": "2021-01-01T00:25:00Z",
                    },
                ]
            )
        )

        expected = normalize_workflow_runs(
            pd.json_normalize(
                [
                    {
                        "run_attempt": 1,
                        "workflow_run_id": 10,
                        "sha": "12345",
                        "conclusion": "failure",
                        "start_time": "2021-01-01T00:05:00Z",
                        "end_time": "2021-01-01T00:25:00Z",
                    },
                ]
            )
        )

        actual = remove_irrelevant_failure_jobs(records)
        self.assertDataFramesAreEqual(actual, expected)

    def test_get_pr_level_stats(self):
        records = normalize_workflow_runs(
            pd.json_normalize(
                [
                    {
                        "pr_number": 1,
                        "run_attempt": 1,
                        "workflow_run_id": 10,
                        "sha": "12345",
                        "conclusion": "failure",
                        "start_time": "2021-01-01T00:00:00Z",
                        "end_time": "2021-01-01T01:05:00Z",
                        "duration_mins": 65.0,
                    },
                    {
                        "pr_number": 1,
                        "run_attempt": 1,
                        "workflow_run_id": 12,
                        "sha": "12345",
                        "conclusion": "failure",
                        "start_time": "2021-01-01T00:25:00Z",
                        "end_time": "2021-01-01T01:25:00Z",
                        "duration_mins": 60.0,
                    },
                ]
            )
        )

        expected = normalize_workflow_runs(
            pd.json_normalize(
                [
                    {
                        "pr_number": 1,
                        "start_time": "2021-01-01T00:00:00Z",
                        "end_time": "2021-01-01T01:25:00Z",
                        "duration_mins": 85,
                        "num_commits": 1.0,
                    }
                ]
            )
        )

        actual = get_pr_level_stats(records)[
            ["pr_number", "start_time", "end_time", "duration_mins", "num_commits"]
        ]
        self.assertDataFramesAreEqual(actual, expected)


if __name__ == "__main__":
    main()
