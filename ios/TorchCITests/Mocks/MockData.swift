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
                "prNumber": 98765,
                "author": "pytorch-dev",
                "authorUrl": "https://github.com/pytorch-dev",
                "time": "2025-01-15T10:30:00Z",
                "jobs": [
                    {
                        "id": 100001,
                        "name": "linux-jammy-py3.10-gcc9 / build",
                        "conclusion": "success",
                        "html_url": "https://github.com/pytorch/pytorch/actions/runs/100001",
                        "log_url": "https://ossci-raw-job-status.s3.amazonaws.com/log/100001",
                        "duration_s": 1800,
                        "failure_lines": [],
                        "failure_captures": [],
                        "runner_name": "i-0abc123def456",
                        "unstable": false,
                        "previous_run": null,
                        "author_email": "pytorch-dev@meta.com"
                    },
                    {
                        "id": 100002,
                        "name": "linux-jammy-py3.10-gcc9 / test (default, 1, 3)",
                        "conclusion": "failure",
                        "html_url": "https://github.com/pytorch/pytorch/actions/runs/100002",
                        "log_url": "https://ossci-raw-job-status.s3.amazonaws.com/log/100002",
                        "duration_s": 5400,
                        "failure_lines": ["FAIL: test_nccl_allreduce (test_distributed.TestNCCL)"],
                        "failure_captures": ["RuntimeError: NCCL communicator was aborted"],
                        "runner_name": "i-0def789ghi012",
                        "unstable": false,
                        "previous_run": {
                            "conclusion": "success",
                            "html_url": "https://github.com/pytorch/pytorch/actions/runs/99999"
                        },
                        "author_email": "pytorch-dev@meta.com"
                    },
                    {
                        "id": null,
                        "name": "linux-jammy-py3.10-gcc9 / test (default, 2, 3)",
                        "conclusion": null,
                        "html_url": null,
                        "log_url": null,
                        "duration_s": null,
                        "failure_lines": null,
                        "failure_captures": null,
                        "runner_name": null,
                        "unstable": null,
                        "previous_run": null,
                        "author_email": null
                    }
                ],
                "isForcedMerge": false
            },
            {
                "sha": "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1",
                "commitTitle": "Upgrade cuDNN to 9.1 for CUDA 12.4 (#98764)",
                "commitMessageBody": null,
                "prNumber": 98764,
                "author": "cuda-maintainer",
                "authorUrl": "https://github.com/cuda-maintainer",
                "time": "2025-01-15T09:15:00Z",
                "jobs": [
                    {
                        "id": 100003,
                        "name": "linux-jammy-py3.10-gcc9 / build",
                        "conclusion": "success",
                        "html_url": "https://github.com/pytorch/pytorch/actions/runs/100003",
                        "log_url": null,
                        "duration_s": 2100,
                        "failure_lines": [],
                        "failure_captures": [],
                        "runner_name": "i-0jkl345mno678",
                        "unstable": false,
                        "previous_run": null,
                        "author_email": "cuda-maintainer@meta.com"
                    },
                    {
                        "id": 100004,
                        "name": "linux-jammy-py3.10-gcc9 / test (default, 1, 3)",
                        "conclusion": "success",
                        "html_url": "https://github.com/pytorch/pytorch/actions/runs/100004",
                        "log_url": null,
                        "duration_s": 4500,
                        "failure_lines": [],
                        "failure_captures": [],
                        "runner_name": "i-0pqr901stu234",
                        "unstable": false,
                        "previous_run": null,
                        "author_email": "cuda-maintainer@meta.com"
                    },
                    {
                        "id": 100005,
                        "name": "linux-jammy-py3.10-gcc9 / test (default, 2, 3)",
                        "conclusion": "success",
                        "html_url": "https://github.com/pytorch/pytorch/actions/runs/100005",
                        "log_url": null,
                        "duration_s": 330,
                        "failure_lines": [],
                        "failure_captures": [],
                        "runner_name": "i-0vwx567yza890",
                        "unstable": false,
                        "previous_run": null,
                        "author_email": "cuda-maintainer@meta.com"
                    }
                ],
                "isForcedMerge": false
            },
            {
                "sha": "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2",
                "commitTitle": "Emergency revert: disable autograd profiler (#98763)",
                "commitMessageBody": "This broke trunk. Force-merging the revert.",
                "prNumber": 98763,
                "author": "oncall-dev",
                "authorUrl": "https://github.com/oncall-dev",
                "time": "2025-01-15T08:00:00Z",
                "jobs": [
                    {
                        "id": 100006,
                        "name": "linux-jammy-py3.10-gcc9 / build",
                        "conclusion": "success",
                        "html_url": "https://github.com/pytorch/pytorch/actions/runs/100006",
                        "log_url": null,
                        "duration_s": 45,
                        "failure_lines": [],
                        "failure_captures": [],
                        "runner_name": "i-0bcd123efg456",
                        "unstable": true,
                        "previous_run": null,
                        "author_email": "oncall-dev@meta.com"
                    },
                    {
                        "id": 100007,
                        "name": "linux-jammy-py3.10-gcc9 / test (default, 1, 3)",
                        "conclusion": "failure",
                        "html_url": "https://github.com/pytorch/pytorch/actions/runs/100007",
                        "log_url": "https://ossci-raw-job-status.s3.amazonaws.com/log/100007",
                        "duration_s": 8100,
                        "failure_lines": ["ERROR: test_autograd_profiler"],
                        "failure_captures": ["AssertionError: profiler output mismatch"],
                        "runner_name": "i-0hij789klm012",
                        "unstable": false,
                        "previous_run": {
                            "conclusion": "failure",
                            "html_url": "https://github.com/pytorch/pytorch/actions/runs/99998"
                        },
                        "author_email": "oncall-dev@meta.com"
                    },
                    {
                        "id": null,
                        "name": null,
                        "conclusion": "pending",
                        "html_url": null,
                        "log_url": null,
                        "duration_s": null,
                        "failure_lines": null,
                        "failure_captures": null,
                        "runner_name": null,
                        "unstable": null,
                        "previous_run": null,
                        "author_email": null
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
            "title": "Add torch.compile support for custom ops (#99001)",
            "body": "This PR adds torch.compile support for user-defined custom operators.",
            "author": {
                "login": "compiler-dev",
                "avatar_url": "https://avatars.githubusercontent.com/u/12345678",
                "url": "https://github.com/compiler-dev"
            },
            "commitDate": "2025-01-20T14:30:00Z",
            "prNumber": 99001,
            "diffNum": "D12345678"
        },
        "jobs": [
            {
                "id": 200001,
                "name": "pull / linux-jammy-py3.10-gcc9 / build",
                "workflow_name": "pull",
                "workflow_id": 5001,
                "job_name": "linux-jammy-py3.10-gcc9 / build",
                "conclusion": "success",
                "html_url": "https://github.com/pytorch/pytorch/actions/runs/200001",
                "log_url": "https://ossci-raw-job-status.s3.amazonaws.com/log/200001",
                "duration_s": 1920,
                "failure_lines": [],
                "failure_captures": [],
                "failure_context": null,
                "runner_name": "i-0abc111def222",
                "runner_group": "linux.2xlarge",
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
                "previous_run": null
            },
            {
                "id": 200002,
                "name": "pull / linux-jammy-py3.10-gcc9 / test (default, 1, 3)",
                "workflow_name": "pull",
                "workflow_id": 5001,
                "job_name": "linux-jammy-py3.10-gcc9 / test (default, 1, 3)",
                "conclusion": "failure",
                "html_url": "https://github.com/pytorch/pytorch/actions/runs/200002",
                "log_url": "https://ossci-raw-job-status.s3.amazonaws.com/log/200002",
                "duration_s": 3780,
                "failure_lines": [
                    "FAIL: test_compile_custom_op (test_custom_ops.TestCustomOps)"
                ],
                "failure_captures": [
                    "RuntimeError: unsupported operator: my_custom_op"
                ],
                "failure_context": "test_custom_ops.py:142",
                "runner_name": "i-0ghi333jkl444",
                "runner_group": "linux.2xlarge",
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
                "previous_run": {
                    "conclusion": "success",
                    "html_url": "https://github.com/pytorch/pytorch/actions/runs/199999"
                }
            },
            {
                "id": 200003,
                "name": "trunk / win-vs2022-cpu-py3 / build",
                "workflow_name": "trunk",
                "workflow_id": 5002,
                "job_name": "win-vs2022-cpu-py3 / build",
                "conclusion": "success",
                "html_url": "https://github.com/pytorch/pytorch/actions/runs/200003",
                "log_url": null,
                "duration_s": 2700,
                "failure_lines": [],
                "failure_captures": [],
                "failure_context": null,
                "runner_name": "i-0mno555pqr666",
                "runner_group": "windows.4xlarge",
                "status": "completed",
                "steps": [],
                "time": "2025-01-20T14:31:00Z",
                "unstable": false,
                "previous_run": null
            },
            {
                "id": 200004,
                "name": "trunk / win-vs2022-cpu-py3 / test",
                "workflow_name": "trunk",
                "workflow_id": 5002,
                "job_name": "win-vs2022-cpu-py3 / test",
                "conclusion": null,
                "html_url": null,
                "log_url": null,
                "duration_s": null,
                "failure_lines": null,
                "failure_captures": null,
                "failure_context": null,
                "runner_name": null,
                "runner_group": null,
                "status": "queued",
                "steps": null,
                "time": null,
                "unstable": null,
                "previous_run": null
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
                "name": "linux.2xlarge",
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
                "name": "windows.4xlarge",
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
        "total_runners": 5
    }
    """

    // MARK: - Helpers

    /// Decode a JSON string into the given `Decodable` type using a plain JSONDecoder.
    static func decode<T: Decodable>(_ json: String) -> T {
        let data = json.data(using: .utf8)!
        return try! JSONDecoder().decode(T.self, from: data)
    }
}
