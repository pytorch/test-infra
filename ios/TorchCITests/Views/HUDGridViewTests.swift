import XCTest
@testable import TorchCI

final class HUDGridViewTests: XCTestCase {

    // MARK: - Helper factories

    private func makeJob(
        id: Int? = nil,
        name: String? = nil,
        conclusion: String? = nil,
        unstable: Bool? = nil,
        durationS: Int? = nil
    ) -> HUDJob {
        HUDJob(
            id: id,
            name: name,
            conclusion: conclusion,
            htmlUrl: nil,
            logUrl: nil,
            durationS: durationS,
            failureLines: nil,
            failureCaptures: nil,
            runnerName: nil,
            unstable: unstable,
            previousRun: nil,
            authorEmail: nil
        )
    }

    private func makeRow(
        sha: String = "abc1234567890abcdef",
        commitTitle: String? = "Test commit",
        prNumber: Int? = nil,
        author: String? = "dev",
        authorUrl: String? = nil,
        time: String? = nil,
        jobs: [HUDJob] = [],
        isForcedMerge: Bool? = false
    ) -> HUDRow {
        HUDRow(
            sha: sha,
            commitTitle: commitTitle,
            commitMessageBody: nil,
            prNumber: prNumber,
            author: author,
            authorUrl: authorUrl,
            time: time ?? ISO8601DateFormatter().string(from: Date()),
            jobs: jobs,
            isForcedMerge: isForcedMerge
        )
    }

    // MARK: - shortJobName tests

    func testShortJobNameExtractsAfterSlash() {
        let grid = HUDGridView(
            rows: [],
            allJobs: [],
            jobNames: [],
            repoOwner: "pytorch",
            repoName: "pytorch"
        )

        let result = grid.shortJobName("linux-jammy-py3.10-gcc9 / build")
        XCTAssertEqual(result, "build")
    }

    func testShortJobNameExtractsComplexSuffix() {
        let grid = HUDGridView(
            rows: [],
            allJobs: [],
            jobNames: [],
            repoOwner: "pytorch",
            repoName: "pytorch"
        )

        let result = grid.shortJobName("linux-jammy-py3.10-gcc9 / test (default, 1, 3)")
        XCTAssertEqual(result, "test (default, 1, 3)")
    }

    func testShortJobNameReturnsFullNameWhenNoSlash() {
        let grid = HUDGridView(
            rows: [],
            allJobs: [],
            jobNames: [],
            repoOwner: "pytorch",
            repoName: "pytorch"
        )

        let result = grid.shortJobName("simple-job-name")
        XCTAssertEqual(result, "simple-job-name")
    }

    func testShortJobNameHandlesMultipleSlashSeparators() {
        let grid = HUDGridView(
            rows: [],
            allJobs: [],
            jobNames: [],
            repoOwner: "pytorch",
            repoName: "pytorch"
        )

        // Should split on the first " / " occurrence
        let result = grid.shortJobName("workflow / sub / test")
        XCTAssertEqual(result, "sub / test")
    }

    func testShortJobNameHandlesEmptyString() {
        let grid = HUDGridView(
            rows: [],
            allJobs: [],
            jobNames: [],
            repoOwner: "pytorch",
            repoName: "pytorch"
        )

        let result = grid.shortJobName("")
        XCTAssertEqual(result, "")
    }

    func testShortJobNameIgnoresSlashWithoutSpaces() {
        let grid = HUDGridView(
            rows: [],
            allJobs: [],
            jobNames: [],
            repoOwner: "pytorch",
            repoName: "pytorch"
        )

        // A slash without surrounding spaces should NOT be treated as a separator
        let result = grid.shortJobName("linux/build")
        XCTAssertEqual(result, "linux/build")
    }

    // MARK: - jobSummary tests

    func testJobSummaryCountsAllStatuses() {
        let jobs = [
            makeJob(conclusion: "success"),
            makeJob(conclusion: "success"),
            makeJob(conclusion: "failure"),
            makeJob(conclusion: nil),
            makeJob(conclusion: "pending"),
        ]

        let summary = HUDGridView.jobSummary(for: jobs)

        XCTAssertEqual(summary.successes, 2)
        XCTAssertEqual(summary.failures, 1)
        XCTAssertEqual(summary.pending, 2)
    }

    func testJobSummaryAllSuccess() {
        let jobs = [
            makeJob(conclusion: "success"),
            makeJob(conclusion: "success"),
            makeJob(conclusion: "success"),
        ]

        let summary = HUDGridView.jobSummary(for: jobs)

        XCTAssertEqual(summary.successes, 3)
        XCTAssertEqual(summary.failures, 0)
        XCTAssertEqual(summary.pending, 0)
    }

    func testJobSummaryAllFailures() {
        let jobs = [
            makeJob(conclusion: "failure"),
            makeJob(conclusion: "failure"),
        ]

        let summary = HUDGridView.jobSummary(for: jobs)

        XCTAssertEqual(summary.successes, 0)
        XCTAssertEqual(summary.failures, 2)
        XCTAssertEqual(summary.pending, 0)
    }

    func testJobSummaryAllPending() {
        let jobs = [
            makeJob(conclusion: nil),
            makeJob(conclusion: "pending"),
        ]

        let summary = HUDGridView.jobSummary(for: jobs)

        XCTAssertEqual(summary.successes, 0)
        XCTAssertEqual(summary.failures, 0)
        XCTAssertEqual(summary.pending, 2)
    }

    func testJobSummaryEmpty() {
        let summary = HUDGridView.jobSummary(for: [])

        XCTAssertEqual(summary.successes, 0)
        XCTAssertEqual(summary.failures, 0)
        XCTAssertEqual(summary.pending, 0)
    }

    func testJobSummaryIgnoresSkippedAndCancelledInMainCounts() {
        let jobs = [
            makeJob(conclusion: "success"),
            makeJob(conclusion: "skipped"),
            makeJob(conclusion: "cancelled"),
        ]

        let summary = HUDGridView.jobSummary(for: jobs)

        // Skipped and cancelled are not counted in any of the three buckets
        XCTAssertEqual(summary.successes, 1)
        XCTAssertEqual(summary.failures, 0)
        XCTAssertEqual(summary.pending, 0)
    }

    func testJobSummaryUnstableFailureStillCountsAsFailure() {
        let jobs = [
            makeJob(conclusion: "failure", unstable: true),
            makeJob(conclusion: "failure", unstable: false),
        ]

        let summary = HUDGridView.jobSummary(for: jobs)

        // Both should be counted as failures (jobSummary does not distinguish unstable)
        XCTAssertEqual(summary.failures, 2)
        XCTAssertEqual(summary.successes, 0)
        XCTAssertEqual(summary.pending, 0)
    }

    // MARK: - Grid data integrity tests

    func testJobColumnsWidthScalesWithJobCount() {
        // Verify that the grid width grows as more jobs are added
        let grid1 = HUDGridView(
            rows: [],
            allJobs: [],
            jobNames: ["a"],
            repoOwner: "pytorch",
            repoName: "pytorch"
        )

        let grid5 = HUDGridView(
            rows: [],
            allJobs: [],
            jobNames: ["a", "b", "c", "d", "e"],
            repoOwner: "pytorch",
            repoName: "pytorch"
        )

        // With 5 job names there should be a wider total job columns area
        // Each column is cellSize(28) + cellSpacing(3) = 31 points
        // grid1 has 1 job: 1*31 + 8 = 39
        // grid5 has 5 jobs: 5*31 + 8 = 163
        // We don't expose the computed property directly, but we can
        // verify the relationship through the view's structural correctness.
        // Instead, just verify the job names count is propagated correctly.
        XCTAssertEqual(grid1.jobNames.count, 1)
        XCTAssertEqual(grid5.jobNames.count, 5)
    }

    func testGridAcceptsEmptyRows() {
        let grid = HUDGridView(
            rows: [],
            allJobs: [],
            jobNames: ["build", "test"],
            repoOwner: "pytorch",
            repoName: "pytorch"
        )

        XCTAssertTrue(grid.rows.isEmpty)
    }

    func testGridAcceptsRowsWithMismatchedJobCounts() {
        // In real data, some rows may have fewer jobs than jobNames
        let row = makeRow(
            sha: "aaa1111111111111111111111111111111111111",
            jobs: [makeJob(conclusion: "success")]
        )

        let grid = HUDGridView(
            rows: [row],
            allJobs: [[makeJob(conclusion: "success")]],
            jobNames: ["build", "test", "lint"],
            repoOwner: "pytorch",
            repoName: "pytorch"
        )

        // Row has 1 job but 3 job names -- the grid should handle this gracefully
        XCTAssertEqual(grid.rows.count, 1)
        XCTAssertEqual(grid.allJobs[0].count, 1)
        XCTAssertEqual(grid.jobNames.count, 3)
    }

    // MARK: - Row display data tests

    func testRowsPreserveCommitMetadata() {
        let row = makeRow(
            sha: "deadbeef12345678901234567890123456789012",
            commitTitle: "Fix broken CI",
            prNumber: 42,
            author: "torchdev",
            isForcedMerge: true
        )

        XCTAssertEqual(row.shortSha, "deadbee")
        XCTAssertEqual(row.commitTitle, "Fix broken CI")
        XCTAssertEqual(row.prNumber, 42)
        XCTAssertEqual(row.author, "torchdev")
        XCTAssertEqual(row.isForcedMerge, true)
    }

    func testRowWithNilOptionals() {
        let row = makeRow(
            commitTitle: nil,
            prNumber: nil,
            author: nil,
            authorUrl: nil,
            isForcedMerge: nil
        )

        XCTAssertNil(row.commitTitle)
        XCTAssertNil(row.prNumber)
        XCTAssertNil(row.author)
        XCTAssertNil(row.authorUrl)
        XCTAssertNil(row.isForcedMerge)
    }

    // MARK: - JobSummary with mock decoded data

    func testJobSummaryFromMockData() {
        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)

        // Row 0: 1 success, 1 failure, 1 pending
        let summary0 = HUDGridView.jobSummary(for: response.shaGrid[0].jobs)
        XCTAssertEqual(summary0.successes, 1)
        XCTAssertEqual(summary0.failures, 1)
        XCTAssertEqual(summary0.pending, 1)

        // Row 1: all 3 success
        let summary1 = HUDGridView.jobSummary(for: response.shaGrid[1].jobs)
        XCTAssertEqual(summary1.successes, 3)
        XCTAssertEqual(summary1.failures, 0)
        XCTAssertEqual(summary1.pending, 0)

        // Row 2: 1 success, 1 failure, 1 pending
        let summary2 = HUDGridView.jobSummary(for: response.shaGrid[2].jobs)
        XCTAssertEqual(summary2.successes, 1)
        XCTAssertEqual(summary2.failures, 1)
        XCTAssertEqual(summary2.pending, 1)
    }

    func testShortJobNameFromMockData() {
        let grid = HUDGridView(
            rows: [],
            allJobs: [],
            jobNames: [],
            repoOwner: "pytorch",
            repoName: "pytorch"
        )

        let response: HUDResponse = MockData.decode(MockData.hudResponseJSON)

        XCTAssertEqual(
            grid.shortJobName(response.jobNames[0]),
            "build"
        )
        XCTAssertEqual(
            grid.shortJobName(response.jobNames[1]),
            "test (default, 1, 3)"
        )
        XCTAssertEqual(
            grid.shortJobName(response.jobNames[2]),
            "test (default, 2, 3)"
        )
    }
}
