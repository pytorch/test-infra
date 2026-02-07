import XCTest
@testable import TorchCI

final class JobDataTests: XCTestCase {

    // MARK: - Decoding

    func testDecodeSuccessfulJob() {
        let json = """
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
        }
        """

        let job: JobData = MockData.decode(json)

        XCTAssertEqual(job.jobId, 200001)
        XCTAssertEqual(job.name, "pull / linux-jammy-py3.10-gcc9 / build")
        XCTAssertEqual(job.workflowName, "pull")
        XCTAssertEqual(job.workflowId, 5001)
        XCTAssertEqual(job.jobName, "linux-jammy-py3.10-gcc9 / build")
        XCTAssertEqual(job.conclusion, "success")
        XCTAssertEqual(job.htmlUrl, "https://github.com/pytorch/pytorch/actions/runs/200001")
        XCTAssertEqual(job.logUrl, "https://ossci-raw-job-status.s3.amazonaws.com/log/200001")
        XCTAssertEqual(job.durationS, 1920)
        XCTAssertEqual(job.failureLines, [])
        XCTAssertEqual(job.failureCaptures, [])
        XCTAssertNil(job.failureContext)
        XCTAssertEqual(job.runnerName, "i-0abc111def222")
        XCTAssertEqual(job.runnerGroup, "linux.2xlarge")
        XCTAssertEqual(job.status, "completed")
        XCTAssertEqual(job.steps?.count, 2)
        XCTAssertEqual(job.time, "2025-01-20T14:31:00Z")
        XCTAssertEqual(job.unstable, false)
        XCTAssertNil(job.previousRun)
    }

    func testDecodeFailedJobWithPreviousRun() {
        let json = """
        {
            "id": 200002,
            "name": "pull / linux-jammy / test (default, 1, 3)",
            "workflow_name": "pull",
            "workflow_id": 5001,
            "job_name": "linux-jammy / test (default, 1, 3)",
            "conclusion": "failure",
            "html_url": "https://github.com/pytorch/pytorch/actions/runs/200002",
            "log_url": "https://ossci-raw-job-status.s3.amazonaws.com/log/200002",
            "duration_s": 3780,
            "failure_lines": ["FAIL: test_compile_custom_op"],
            "failure_captures": ["RuntimeError: unsupported operator"],
            "failure_context": "test_custom_ops.py:142",
            "runner_name": "i-0ghi333jkl444",
            "runner_group": "linux.2xlarge",
            "status": "completed",
            "steps": [],
            "time": "2025-01-20T15:05:00Z",
            "unstable": false,
            "previous_run": {
                "conclusion": "success",
                "html_url": "https://github.com/pytorch/pytorch/actions/runs/199999"
            }
        }
        """

        let job: JobData = MockData.decode(json)

        XCTAssertEqual(job.conclusion, "failure")
        XCTAssertEqual(job.failureLines, ["FAIL: test_compile_custom_op"])
        XCTAssertEqual(job.failureCaptures, ["RuntimeError: unsupported operator"])
        XCTAssertEqual(job.failureContext, "test_custom_ops.py:142")
        XCTAssertNotNil(job.previousRun)
        XCTAssertEqual(job.previousRun?.conclusion, "success")
        XCTAssertEqual(job.previousRun?.htmlUrl, "https://github.com/pytorch/pytorch/actions/runs/199999")
    }

    func testDecodeNilAndMissingFieldsGracefully() {
        // Minimal JSON -- only the fields that appear in CodingKeys with all nullable values set to null.
        let json = """
        {
            "id": null,
            "name": null,
            "workflow_name": null,
            "workflow_id": null,
            "job_name": null,
            "conclusion": null,
            "html_url": null,
            "log_url": null,
            "duration_s": null,
            "failure_lines": null,
            "failure_captures": null,
            "failure_context": null,
            "runner_name": null,
            "runner_group": null,
            "status": null,
            "steps": null,
            "time": null,
            "unstable": null,
            "previous_run": null
        }
        """

        let job: JobData = MockData.decode(json)

        XCTAssertNil(job.id)
        XCTAssertNil(job.name)
        XCTAssertNil(job.workflowName)
        XCTAssertNil(job.workflowId)
        XCTAssertNil(job.conclusion)
        XCTAssertNil(job.htmlUrl)
        XCTAssertNil(job.logUrl)
        XCTAssertNil(job.durationS)
        XCTAssertNil(job.failureLines)
        XCTAssertNil(job.failureCaptures)
        XCTAssertNil(job.failureContext)
        XCTAssertNil(job.runnerName)
        XCTAssertNil(job.runnerGroup)
        XCTAssertNil(job.status)
        XCTAssertNil(job.steps)
        XCTAssertNil(job.time)
        XCTAssertNil(job.unstable)
        XCTAssertNil(job.previousRun)
    }

    // MARK: - durationFormatted

    func testDurationFormattedZeroSeconds() {
        let job = makeJob(durationS: 0)
        XCTAssertEqual(job.durationFormatted, "0s")
    }

    func testDurationFormattedSecondsOnly() {
        let job = makeJob(durationS: 45)
        XCTAssertEqual(job.durationFormatted, "45s")
    }

    func testDurationFormattedMinutesAndSeconds() {
        let job = makeJob(durationS: 330) // 5m 30s
        XCTAssertEqual(job.durationFormatted, "5m 30s")
    }

    func testDurationFormattedHoursAndMinutesAndSeconds() {
        let job = makeJob(durationS: 8100) // 2h 15m 0s
        XCTAssertEqual(job.durationFormatted, "2h 15m 0s")
    }

    func testDurationFormattedNilDuration() {
        let job = makeJob(durationS: nil)
        XCTAssertNil(job.durationFormatted)
    }

    func testDurationFormattedExactHour() {
        let job = makeJob(durationS: 3600) // 1h 0m 0s
        XCTAssertEqual(job.durationFormatted, "1h 0m 0s")
    }

    func testDurationFormattedExactMinute() {
        let job = makeJob(durationS: 60) // 1m 0s
        XCTAssertEqual(job.durationFormatted, "1m 0s")
    }

    // MARK: - isFailure / isSuccess

    func testIsFailure() {
        let job = makeJob(conclusion: "failure")
        XCTAssertTrue(job.isFailure)
        XCTAssertFalse(job.isSuccess)
    }

    func testIsSuccess() {
        let job = makeJob(conclusion: "success")
        XCTAssertTrue(job.isSuccess)
        XCTAssertFalse(job.isFailure)
    }

    func testNilConclusionIsNotFailureNorSuccess() {
        let job = makeJob(conclusion: nil)
        XCTAssertFalse(job.isFailure)
        XCTAssertFalse(job.isSuccess)
    }

    func testSkippedConclusionIsNotFailureNorSuccess() {
        let job = makeJob(conclusion: "skipped")
        XCTAssertFalse(job.isFailure)
        XCTAssertFalse(job.isSuccess)
    }

    // MARK: - JobStep decoding

    func testJobStepDecoding() {
        let json = """
        {
            "name": "Run tests",
            "conclusion": "failure",
            "number": 3,
            "started_at": "2025-01-20T15:00:00Z",
            "completed_at": "2025-01-20T15:45:00Z"
        }
        """

        let step: JobStep = MockData.decode(json)

        XCTAssertEqual(step.name, "Run tests")
        XCTAssertEqual(step.conclusion, "failure")
        XCTAssertEqual(step.number, 3)
        XCTAssertEqual(step.id, 3) // id == number
        XCTAssertEqual(step.startedAt, "2025-01-20T15:00:00Z")
        XCTAssertEqual(step.completedAt, "2025-01-20T15:45:00Z")
    }

    func testJobStepNilOptionals() {
        let json = """
        {
            "name": "Post cleanup",
            "conclusion": null,
            "number": 10,
            "started_at": null,
            "completed_at": null
        }
        """

        let step: JobStep = MockData.decode(json)

        XCTAssertEqual(step.name, "Post cleanup")
        XCTAssertNil(step.conclusion)
        XCTAssertNil(step.startedAt)
        XCTAssertNil(step.completedAt)
    }

    // MARK: - Full CommitResponse decoding from MockData

    func testFullCommitResponseDecoding() {
        let response: CommitResponse = MockData.decode(MockData.commitResponseJSON)

        XCTAssertEqual(response.jobs.count, 4)

        let successJobs = response.jobs.filter(\.isSuccess)
        let failureJobs = response.jobs.filter(\.isFailure)

        XCTAssertEqual(successJobs.count, 2)
        XCTAssertEqual(failureJobs.count, 1)
    }

    // MARK: - Helpers

    /// Builds a minimal `JobData` by round-tripping through JSON, controlling only the fields under test.
    private func makeJob(durationS: Int? = nil, conclusion: String? = nil) -> JobData {
        let durationValue = durationS.map { "\($0)" } ?? "null"
        let conclusionValue = conclusion.map { "\"\($0)\"" } ?? "null"

        let json = """
        {
            "id": 1,
            "name": "test-job",
            "workflow_name": null,
            "workflow_id": null,
            "job_name": null,
            "conclusion": \(conclusionValue),
            "html_url": null,
            "log_url": null,
            "duration_s": \(durationValue),
            "failure_lines": null,
            "failure_captures": null,
            "failure_context": null,
            "runner_name": null,
            "runner_group": null,
            "status": null,
            "steps": null,
            "time": null,
            "unstable": null,
            "previous_run": null
        }
        """
        return MockData.decode(json)
    }
}
