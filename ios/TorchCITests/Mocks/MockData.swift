import Foundation
@testable import TorchCI

enum MockData {

    // MARK: - HUD Response

    /// HUD response JSON with 3 rows: one success-heavy, one with failures, one pending.
    /// Job names correspond positionally to the jobs arrays in each row.
    static let hudResponseJSON: String = """
    {
        "shaGrid": [
            {
                "sha": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
                "commitTitle": "Fix flaky test_distributed_nccl (#98765)",
                "commitMessageBody": "The test was racy due to a missing barrier call.",
                "prNum": 98765,
                "author": "pytorch-dev",
                "authorUrl": "https://github.com/pytorch-dev",
                "time": "2025-01-15T10:30:00Z",
                "jobs": [
                    {
                        "id": 100001,
                        "name": "linux-jammy-py3.10-gcc9 / build",
                        "conclusion": "success",
                        "htmlUrl": "https://github.com/pytorch/pytorch/actions/runs/100001",
                        "logUrl": "https://ossci-raw-job-status.s3.amazonaws.com/log/100001",
                        "durationS": 1800,
                        "failureLines": [],
                        "failureCaptures": [],
                        "runnerName": "i-0abc123def456",
                        "unstable": false,
                        "failedPreviousRun": null,
                        "authorEmail": "pytorch-dev@meta.com"
                    },
                    {
                        "id": 100002,
                        "name": "linux-jammy-py3.10-gcc9 / test (default, 1, 3)",
                        "conclusion": "failure",
                        "htmlUrl": "https://github.com/pytorch/pytorch/actions/runs/100002",
                        "logUrl": "https://ossci-raw-job-status.s3.amazonaws.com/log/100002",
                        "durationS": 5400,
                        "failureLines": ["FAIL: test_nccl_allreduce (test_distributed.TestNCCL)"],
                        "failureCaptures": ["RuntimeError: NCCL communicator was aborted"],
                        "runnerName": "i-0def789ghi012",
                        "unstable": false,
                        "failedPreviousRun": false,
                        "authorEmail": "pytorch-dev@meta.com"
                    },
                    {
                        "id": 100008,
                        "name": "linux-jammy-py3.10-gcc9 / test (default, 2, 3)",
                        "conclusion": null,
                        "htmlUrl": null,
                        "logUrl": null,
                        "durationS": null,
                        "failureLines": null,
                        "failureCaptures": null,
                        "runnerName": null,
                        "unstable": null,
                        "failedPreviousRun": null,
                        "authorEmail": null
                    }
                ],
                "isForcedMerge": false
            },
            {
                "sha": "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1",
                "commitTitle": "Upgrade cuDNN to 9.1 for CUDA 12.4 (#98764)",
                "commitMessageBody": null,
                "prNum": 98764,
                "author": "cuda-maintainer",
                "authorUrl": "https://github.com/cuda-maintainer",
                "time": "2025-01-15T09:15:00Z",
                "jobs": [
                    {
                        "id": 100003,
                        "name": "linux-jammy-py3.10-gcc9 / build",
                        "conclusion": "success",
                        "htmlUrl": "https://github.com/pytorch/pytorch/actions/runs/100003",
                        "logUrl": null,
                        "durationS": 2100,
                        "failureLines": [],
                        "failureCaptures": [],
                        "runnerName": "i-0jkl345mno678",
                        "unstable": false,
                        "failedPreviousRun": null,
                        "authorEmail": "cuda-maintainer@meta.com"
                    },
                    {
                        "id": 100004,
                        "name": "linux-jammy-py3.10-gcc9 / test (default, 1, 3)",
                        "conclusion": "success",
                        "htmlUrl": "https://github.com/pytorch/pytorch/actions/runs/100004",
                        "logUrl": null,
                        "durationS": 4500,
                        "failureLines": [],
                        "failureCaptures": [],
                        "runnerName": "i-0pqr901stu234",
                        "unstable": false,
                        "failedPreviousRun": null,
                        "authorEmail": "cuda-maintainer@meta.com"
                    },
                    {
                        "id": 100005,
                        "name": "linux-jammy-py3.10-gcc9 / test (default, 2, 3)",
                        "conclusion": "success",
                        "htmlUrl": "https://github.com/pytorch/pytorch/actions/runs/100005",
                        "logUrl": null,
                        "durationS": 330,
                        "failureLines": [],
                        "failureCaptures": [],
                        "runnerName": "i-0vwx567yza890",
                        "unstable": false,
                        "failedPreviousRun": null,
                        "authorEmail": "cuda-maintainer@meta.com"
                    }
                ],
                "isForcedMerge": false
            },
            {
                "sha": "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2",
                "commitTitle": "Emergency revert: disable autograd profiler (#98763)",
                "commitMessageBody": "This broke trunk. Force-merging the revert.",
                "prNum": 98763,
                "author": "oncall-dev",
                "authorUrl": "https://github.com/oncall-dev",
                "time": "2025-01-15T08:00:00Z",
                "jobs": [
                    {
                        "id": 100006,
                        "name": "linux-jammy-py3.10-gcc9 / build",
                        "conclusion": "success",
                        "htmlUrl": "https://github.com/pytorch/pytorch/actions/runs/100006",
                        "logUrl": null,
                        "durationS": 45,
                        "failureLines": [],
                        "failureCaptures": [],
                        "runnerName": "i-0bcd123efg456",
                        "unstable": true,
                        "failedPreviousRun": null,
                        "authorEmail": "oncall-dev@meta.com"
                    },
                    {
                        "id": 100007,
                        "name": "linux-jammy-py3.10-gcc9 / test (default, 1, 3)",
                        "conclusion": "failure",
                        "htmlUrl": "https://github.com/pytorch/pytorch/actions/runs/100007",
                        "logUrl": "https://ossci-raw-job-status.s3.amazonaws.com/log/100007",
                        "durationS": 8100,
                        "failureLines": ["ERROR: test_autograd_profiler"],
                        "failureCaptures": ["AssertionError: profiler output mismatch"],
                        "runnerName": "i-0hij789klm012",
                        "unstable": false,
                        "failedPreviousRun": true,
                        "authorEmail": "oncall-dev@meta.com"
                    },
                    {
                        "id": 100009,
                        "name": null,
                        "conclusion": "pending",
                        "htmlUrl": null,
                        "logUrl": null,
                        "durationS": null,
                        "failureLines": null,
                        "failureCaptures": null,
                        "runnerName": null,
                        "unstable": null,
                        "failedPreviousRun": null,
                        "authorEmail": null
                    }
                ],
                "isForcedMerge": true
            }
        ],
        "jobNames": [
            "linux-jammy-py3.10-gcc9 / build",
            "linux-jammy-py3.10-gcc9 / test (default, 1, 3)",
            "linux-jammy-py3.10-gcc9 / test (default, 2, 3)"
        ]
    }
    """

    // MARK: - Commit Response

    /// Commit response with 4 jobs across 2 workflows.
    static let commitResponseJSON: String = """
    {
        "commit": {
            "sha": "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
            "commitTitle": "Add torch.compile support for custom ops (#99001)",
            "commitMessageBody": "This PR adds torch.compile support for user-defined custom operators.",
            "author": "compiler-dev",
            "authorUrl": "https://github.com/compiler-dev",
            "time": "2025-01-20T14:30:00Z",
            "prNum": 99001,
            "diffNum": "D12345678"
        },
        "jobs": [
            {
                "id": 200001,
                "name": "pull / linux-jammy-py3.10-gcc9 / build",
                "workflowName": "pull",
                "workflowId": 5001,
                "jobName": "linux-jammy-py3.10-gcc9 / build",
                "conclusion": "success",
                "htmlUrl": "https://github.com/pytorch/pytorch/actions/runs/200001",
                "logUrl": "https://ossci-raw-job-status.s3.amazonaws.com/log/200001",
                "durationS": 1920,
                "failureLines": [],
                "failureCaptures": [],
                "failureContext": null,
                "runnerName": "i-0abc111def222",
                "runnerGroup": "linux.2xlarge",
                "status": "completed",
                "steps": [
                    {
                        "name": "Checkout code",
                        "conclusion": "success",
                        "number": 1,
                        "started_at": "2025-01-20T14:31:00Z",
                        "completed_at": "2025-01-20T14:31:30Z"
                    },
                    {
                        "name": "Build PyTorch",
                        "conclusion": "success",
                        "number": 2,
                        "started_at": "2025-01-20T14:31:30Z",
                        "completed_at": "2025-01-20T15:03:00Z"
                    }
                ],
                "time": "2025-01-20T14:31:00Z",
                "unstable": false,
                "previousRun": null
            },
            {
                "id": 200002,
                "name": "pull / linux-jammy-py3.10-gcc9 / test (default, 1, 3)",
                "workflowName": "pull",
                "workflowId": 5001,
                "jobName": "linux-jammy-py3.10-gcc9 / test (default, 1, 3)",
                "conclusion": "failure",
                "htmlUrl": "https://github.com/pytorch/pytorch/actions/runs/200002",
                "logUrl": "https://ossci-raw-job-status.s3.amazonaws.com/log/200002",
                "durationS": 3780,
                "failureLines": [
                    "FAIL: test_compile_custom_op (test_custom_ops.TestCustomOps)"
                ],
                "failureCaptures": [
                    "RuntimeError: unsupported operator: my_custom_op"
                ],
                "failureContext": "test_custom_ops.py:142",
                "runnerName": "i-0ghi333jkl444",
                "runnerGroup": "linux.2xlarge",
                "status": "completed",
                "steps": [
                    {
                        "name": "Checkout code",
                        "conclusion": "success",
                        "number": 1,
                        "started_at": "2025-01-20T15:05:00Z",
                        "completed_at": "2025-01-20T15:05:20Z"
                    },
                    {
                        "name": "Run tests",
                        "conclusion": "failure",
                        "number": 2,
                        "started_at": "2025-01-20T15:05:20Z",
                        "completed_at": "2025-01-20T16:08:20Z"
                    }
                ],
                "time": "2025-01-20T15:05:00Z",
                "unstable": false,
                "previousRun": {
                    "conclusion": "success",
                    "htmlUrl": "https://github.com/pytorch/pytorch/actions/runs/199999"
                }
            },
            {
                "id": 200003,
                "name": "trunk / win-vs2022-cpu-py3 / build",
                "workflowName": "trunk",
                "workflowId": 5002,
                "jobName": "win-vs2022-cpu-py3 / build",
                "conclusion": "success",
                "htmlUrl": "https://github.com/pytorch/pytorch/actions/runs/200003",
                "logUrl": null,
                "durationS": 2700,
                "failureLines": [],
                "failureCaptures": [],
                "failureContext": null,
                "runnerName": "i-0mno555pqr666",
                "runnerGroup": "windows.4xlarge",
                "status": "completed",
                "steps": [],
                "time": "2025-01-20T14:31:00Z",
                "unstable": false,
                "previousRun": null
            },
            {
                "id": 200004,
                "name": "trunk / win-vs2022-cpu-py3 / test",
                "workflowName": "trunk",
                "workflowId": 5002,
                "jobName": "win-vs2022-cpu-py3 / test",
                "conclusion": null,
                "htmlUrl": null,
                "logUrl": null,
                "durationS": null,
                "failureLines": null,
                "failureCaptures": null,
                "failureContext": null,
                "runnerName": null,
                "runnerGroup": null,
                "status": "queued",
                "steps": null,
                "time": null,
                "unstable": null,
                "previousRun": null
            }
        ]
    }
    """

    // MARK: - Test Search Response

    /// Search results with 3 tests: one flaky, one stable, one failing.
    static let testSearchResponseJSON: String = """
    {
        "tests": [
            {
                "name": "test_nccl_allreduce",
                "suite": "TestDistributedNCCL",
                "file": "test/distributed/test_nccl.py",
                "invoked_times": 1500,
                "failed_times": 45,
                "flaky_rate": 0.03,
                "last_seen": "2025-01-18T22:00:00Z"
            },
            {
                "name": "test_matmul_cuda",
                "suite": "TestLinalgCUDA",
                "file": "test/test_linalg.py",
                "invoked_times": 3200,
                "failed_times": 0,
                "flaky_rate": 0.0,
                "last_seen": "2025-01-19T08:30:00Z"
            },
            {
                "name": "test_autograd_profiler_output",
                "suite": "TestProfiler",
                "file": "test/profiler/test_profiler.py",
                "invoked_times": 800,
                "failed_times": 200,
                "flaky_rate": 0.25,
                "last_seen": "2025-01-19T12:45:00Z"
            }
        ],
        "total_count": 3,
        "page": 1
    }
    """

    // MARK: - Runners Response

    /// Runner groups with a mix of online/busy/offline runners.
    static let runnersResponseJSON: String = """
    {
        "groups": [
            {
                "label": "linux.2xlarge",
                "totalCount": 3,
                "idleCount": 1,
                "busyCount": 1,
                "offlineCount": 1,
                "runners": [
                    {
                        "id": 50001,
                        "name": "i-0abc123def456",
                        "os": "Linux",
                        "status": "online",
                        "busy": true,
                        "labels": [
                            {"id": 1, "name": "self-hosted", "type": "custom"},
                            {"id": 2, "name": "linux.2xlarge", "type": "custom"}
                        ]
                    },
                    {
                        "id": 50002,
                        "name": "i-0def789ghi012",
                        "os": "Linux",
                        "status": "online",
                        "busy": false,
                        "labels": [
                            {"id": 1, "name": "self-hosted", "type": "custom"},
                            {"id": 2, "name": "linux.2xlarge", "type": "custom"}
                        ]
                    },
                    {
                        "id": 50003,
                        "name": "i-0jkl345mno678",
                        "os": "Linux",
                        "status": "offline",
                        "busy": false,
                        "labels": [
                            {"id": 1, "name": "self-hosted", "type": "custom"}
                        ]
                    }
                ]
            },
            {
                "label": "windows.4xlarge",
                "totalCount": 2,
                "idleCount": 0,
                "busyCount": 2,
                "offlineCount": 0,
                "runners": [
                    {
                        "id": 50004,
                        "name": "win-runner-001",
                        "os": "Windows",
                        "status": "online",
                        "busy": true,
                        "labels": [
                            {"id": 3, "name": "windows.4xlarge", "type": "custom"}
                        ]
                    },
                    {
                        "id": 50005,
                        "name": "win-runner-002",
                        "os": "Windows",
                        "status": "online",
                        "busy": true,
                        "labels": [
                            {"id": 3, "name": "windows.4xlarge", "type": "custom"}
                        ]
                    }
                ]
            }
        ],
        "totalRunners": 5
    }
    """

    // MARK: - Helpers

    /// Decode a JSON string into the given `Decodable` type using a plain JSONDecoder.
    static func decode<T: Decodable>(_ json: String) -> T {
        let data = json.data(using: .utf8)!
        return try! JSONDecoder().decode(T.self, from: data)
    }
}
