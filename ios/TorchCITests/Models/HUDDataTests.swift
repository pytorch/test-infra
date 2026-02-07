import XCTest
@testable import TorchCI

final class HUDDataTests: XCTestCase {

    // MARK: - HUDResponse decoding

    func testHUDResponseDecoding() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)

        XCTAssertEqual(response.shaGrid.count, 3)
        XCTAssertEqual(response.jobNames.count, 3)
        XCTAssertEqual(response.jobNames[0], "linux-jammy-py3.10-gcc9 / build")
        XCTAssertEqual(response.jobNames[1], "linux-jammy-py3.10-gcc9 / test (default, 1, 3)")
        XCTAssertEqual(response.jobNames[2], "linux-jammy-py3.10-gcc9 / test (default, 2, 3)")
    }

    func testHUDResponseEmptyGrid() {
        let json = """
        {
            "shaGrid": [],
            "jobNames": []
        }
        """

        let response: HUDResponse = MockData.decode(json)

        XCTAssertTrue(response.shaGrid.isEmpty)
        XCTAssertTrue(response.jobNames.isEmpty)
    }

    // MARK: - HUDRow decoding

    func testHUDRowDecoding() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let row = response.shaGrid[0]

        XCTAssertEqual(row.sha, "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")
        XCTAssertEqual(row.commitTitle, "Fix flaky test_distributed_nccl (#98765)")
        XCTAssertEqual(row.commitMessageBody, "The test was racy due to a missing barrier call.")
        XCTAssertEqual(row.prNumber, 98765)
        XCTAssertEqual(row.author, "pytorch-dev")
        XCTAssertEqual(row.authorUrl, "https://github.com/pytorch-dev")
        XCTAssertEqual(row.time, "2025-01-15T10:30:00Z")
        XCTAssertEqual(row.jobs.count, 3)
        XCTAssertEqual(row.isForcedMerge, false)
    }

    func testHUDRowNilOptionalFields() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let row = response.shaGrid[1] // second row has null commitMessageBody

        XCTAssertNil(row.commitMessageBody)
    }

    func testHUDRowForcedMerge() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let row = response.shaGrid[2] // third row is a forced merge

        XCTAssertEqual(row.isForcedMerge, true)
        XCTAssertEqual(row.commitTitle, "Emergency revert: disable autograd profiler (#98763)")
    }

    // MARK: - HUDRow.shortSha

    func testShortSha() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let row = response.shaGrid[0]

        XCTAssertEqual(row.shortSha, "a1b2c3d")
        XCTAssertEqual(row.shortSha.count, 7)
    }

    func testShortShaConsistency() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)

        // Verify shortSha is always a prefix of sha for all rows
        for row in response.shaGrid {
            XCTAssertTrue(row.sha.hasPrefix(row.shortSha))
        }
    }

    // MARK: - HUDRow.id (Identifiable)

    func testRowIdIsSha() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let row = response.shaGrid[0]

        XCTAssertEqual(row.id, row.sha)
        XCTAssertEqual(row.id, "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")
    }

    func testAllRowIdsAreUnique() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let ids = response.shaGrid.map(\.id)
        let uniqueIds = Set(ids)

        XCTAssertEqual(ids.count, uniqueIds.count, "All row IDs should be unique")
    }

    // MARK: - HUDRow.relativeTime

    func testRelativeTimeWithValidDate() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let row = response.shaGrid[0] // time: "2025-01-15T10:30:00Z"

        // The time is in the past, so relativeTime should produce a non-empty string
        let relative = row.relativeTime
        XCTAssertFalse(relative.isEmpty)
        // Since the date is well in the past, it should NOT just be the raw ISO string
        XCTAssertNotEqual(relative, row.time)
    }

    func testRelativeTimeWithNilDate() {
        let json = """
        {
            "shaGrid": [
                {
                    "sha": "ffff0000ffff0000ffff0000ffff0000ffff0000",
                    "commitTitle": "No time commit",
                    "commitMessageBody": null,
                    "prNumber": null,
                    "author": null,
                    "authorUrl": null,
                    "time": null,
                    "jobs": [],
                    "isForcedMerge": null
                }
            ],
            "jobNames": []
        }
        """

        let response: HUDResponse = MockData.decode(json)
        let row = response.shaGrid[0]

        // When time is nil, relativeTime should return ""
        XCTAssertEqual(row.relativeTime, "")
    }

    // MARK: - HUDRow.commitDate

    func testCommitDateParsesISO8601() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let row = response.shaGrid[0]

        XCTAssertNotNil(row.commitDate)

        let calendar = Calendar(identifier: .gregorian)
        let components = calendar.dateComponents(in: TimeZone(identifier: "UTC")!, from: row.commitDate!)
        XCTAssertEqual(components.year, 2025)
        XCTAssertEqual(components.month, 1)
        XCTAssertEqual(components.day, 15)
        XCTAssertEqual(components.hour, 10)
        XCTAssertEqual(components.minute, 30)
    }

    func testCommitDateNilWhenTimeIsNil() {
        let json = """
        {
            "shaGrid": [
                {
                    "sha": "0000111100001111000011110000111100001111",
                    "commitTitle": null,
                    "commitMessageBody": null,
                    "prNumber": null,
                    "author": null,
                    "authorUrl": null,
                    "time": null,
                    "jobs": [],
                    "isForcedMerge": null
                }
            ],
            "jobNames": []
        }
        """

        let response: HUDResponse = MockData.decode(json)

        XCTAssertNil(response.shaGrid[0].commitDate)
    }

    // MARK: - HUDJob status helpers

    func testHUDJobIsSuccess() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let successJob = response.shaGrid[0].jobs[0] // conclusion: "success"

        XCTAssertTrue(successJob.isSuccess)
        XCTAssertFalse(successJob.isFailure)
        XCTAssertFalse(successJob.isPending)
    }

    func testHUDJobIsFailure() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let failureJob = response.shaGrid[0].jobs[1] // conclusion: "failure"

        XCTAssertTrue(failureJob.isFailure)
        XCTAssertFalse(failureJob.isSuccess)
        XCTAssertFalse(failureJob.isPending)
    }

    func testHUDJobIsPendingWithNilConclusion() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let pendingJob = response.shaGrid[0].jobs[2] // conclusion: null

        XCTAssertTrue(pendingJob.isPending)
        XCTAssertFalse(pendingJob.isSuccess)
        XCTAssertFalse(pendingJob.isFailure)
    }

    func testHUDJobIsPendingWithPendingConclusion() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let pendingJob = response.shaGrid[2].jobs[2] // conclusion: "pending"

        XCTAssertTrue(pendingJob.isPending)
        XCTAssertFalse(pendingJob.isSuccess)
        XCTAssertFalse(pendingJob.isFailure)
    }

    func testHUDJobIsUnstable() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let unstableJob = response.shaGrid[2].jobs[0] // unstable: true

        XCTAssertTrue(unstableJob.isUnstable)
    }

    func testHUDJobIsNotUnstable() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let stableJob = response.shaGrid[0].jobs[0] // unstable: false

        XCTAssertFalse(stableJob.isUnstable)
    }

    func testHUDJobNilUnstableIsNotUnstable() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let nilUnstableJob = response.shaGrid[0].jobs[2] // unstable: null

        XCTAssertFalse(nilUnstableJob.isUnstable)
    }

    // MARK: - HUDJob.durationFormatted

    func testHUDJobDurationFormattedSeconds() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let job = response.shaGrid[2].jobs[0] // duration_s: 45

        XCTAssertEqual(job.durationFormatted, "45s")
    }

    func testHUDJobDurationFormattedMinutesSeconds() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let job = response.shaGrid[1].jobs[2] // duration_s: 330 -> 5m 30s

        XCTAssertEqual(job.durationFormatted, "5m 30s")
    }

    func testHUDJobDurationFormattedHoursMinutes() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let job = response.shaGrid[0].jobs[1] // duration_s: 5400 -> 1h 30m

        XCTAssertEqual(job.durationFormatted, "1h 30m")
    }

    func testHUDJobDurationFormattedNil() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let job = response.shaGrid[0].jobs[2] // duration_s: null

        XCTAssertNil(job.durationFormatted)
    }

    // MARK: - HUDJob fields

    func testHUDJobFieldDecoding() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let job = response.shaGrid[0].jobs[1] // the failure job

        XCTAssertEqual(job.id, 100002)
        XCTAssertEqual(job.name, "linux-jammy-py3.10-gcc9 / test (default, 1, 3)")
        XCTAssertEqual(job.conclusion, "failure")
        XCTAssertEqual(job.htmlUrl, "https://github.com/pytorch/pytorch/actions/runs/100002")
        XCTAssertEqual(job.logUrl, "https://ossci-raw-job-status.s3.amazonaws.com/log/100002")
        XCTAssertEqual(job.durationS, 5400)
        XCTAssertEqual(job.failureLines, ["FAIL: test_nccl_allreduce (test_distributed.TestNCCL)"])
        XCTAssertEqual(job.failureCaptures, ["RuntimeError: NCCL communicator was aborted"])
        XCTAssertEqual(job.runnerName, "i-0def789ghi012")
        XCTAssertEqual(job.authorEmail, "pytorch-dev@meta.com")
    }

    func testHUDJobPreviousRunDecoding() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let job = response.shaGrid[0].jobs[1] // has a previous_run

        XCTAssertNotNil(job.previousRun)
        XCTAssertEqual(job.previousRun?.conclusion, "success")
        XCTAssertEqual(job.previousRun?.htmlUrl, "https://github.com/pytorch/pytorch/actions/runs/99999")
    }

    func testHUDJobNilPreviousRun() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)
        let job = response.shaGrid[0].jobs[0] // previous_run: null

        XCTAssertNil(job.previousRun)
    }

    // MARK: - PreviousRun standalone decoding

    func testPreviousRunDecoding() {
        let json = """
        {
            "conclusion": "failure",
            "html_url": "https://github.com/pytorch/pytorch/actions/runs/88888"
        }
        """

        let previousRun: PreviousRun = MockData.decode(json)

        XCTAssertEqual(previousRun.conclusion, "failure")
        XCTAssertEqual(previousRun.htmlUrl, "https://github.com/pytorch/pytorch/actions/runs/88888")
    }

    func testPreviousRunNilFields() {
        let json = """
        {
            "conclusion": null,
            "html_url": null
        }
        """

        let previousRun: PreviousRun = MockData.decode(json)

        XCTAssertNil(previousRun.conclusion)
        XCTAssertNil(previousRun.htmlUrl)
    }

    // MARK: - Row-level aggregation smoke tests

    func testRowJobCounts() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)

        // Row 0: 1 success, 1 failure, 1 pending (null conclusion)
        let row0Jobs = response.shaGrid[0].jobs
        XCTAssertEqual(row0Jobs.filter(\.isSuccess).count, 1)
        XCTAssertEqual(row0Jobs.filter(\.isFailure).count, 1)
        XCTAssertEqual(row0Jobs.filter(\.isPending).count, 1)

        // Row 1: all 3 jobs succeeded
        let row1Jobs = response.shaGrid[1].jobs
        XCTAssertEqual(row1Jobs.filter(\.isSuccess).count, 3)
        XCTAssertEqual(row1Jobs.filter(\.isFailure).count, 0)
        XCTAssertEqual(row1Jobs.filter(\.isPending).count, 0)

        // Row 2: 1 success (unstable), 1 failure, 1 pending
        let row2Jobs = response.shaGrid[2].jobs
        XCTAssertEqual(row2Jobs.filter(\.isSuccess).count, 1)
        XCTAssertEqual(row2Jobs.filter(\.isFailure).count, 1)
        XCTAssertEqual(row2Jobs.filter(\.isPending).count, 1)
    }
}
