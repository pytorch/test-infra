import XCTest
@testable import TorchCI

@MainActor
final class CommitDetailViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: CommitDetailViewModel!

    private let testSha = "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3"

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = CommitDetailViewModel(
            sha: testSha,
            repoOwner: "pytorch",
            repoName: "pytorch",
            apiClient: mockClient
        )
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// Build valid commit response JSON using camelCase keys that match the Decodable models.
    private func makeCommitResponseJSON(
        sha: String = "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
        commitTitle: String = "Test commit",
        author: String = "test-user",
        prNum: Int? = nil,
        jobs: [JobJSON] = []
    ) -> String {
        let prNumField = prNum.map { "\($0)" } ?? "null"
        let jobsJSON = jobs.map { $0.toJSON() }.joined(separator: ",\n")
        return """
        {
            "commit": {
                "sha": "\(sha)",
                "commitTitle": "\(commitTitle)",
                "commitMessageBody": "Test body",
                "author": "\(author)",
                "authorUrl": "https://github.com/\(author)",
                "time": "2025-01-20T14:30:00Z",
                "prNum": \(prNumField),
                "diffNum": null
            },
            "jobs": [\(jobsJSON)]
        }
        """
    }

    /// Helper to build job JSON fragments with camelCase keys.
    struct JobJSON {
        var id: Int
        var name: String
        var workflowName: String
        var jobName: String
        var conclusion: String?
        var durationS: Int? = nil
        var failureLines: [String]? = nil
        var unstable: Bool = false

        func toJSON() -> String {
            let conclusionStr = conclusion.map { "\"\($0)\"" } ?? "null"
            let durationStr = durationS.map { "\($0)" } ?? "null"
            let failureLinesStr: String
            if let lines = failureLines {
                let encoded = lines.map { "\"\($0)\"" }.joined(separator: ",")
                failureLinesStr = "[\(encoded)]"
            } else {
                failureLinesStr = "null"
            }
            return """
            {
                "id": \(id),
                "name": "\(name)",
                "workflowName": "\(workflowName)",
                "workflowId": 5001,
                "jobName": "\(jobName)",
                "conclusion": \(conclusionStr),
                "htmlUrl": null,
                "logUrl": null,
                "durationS": \(durationStr),
                "failureLines": \(failureLinesStr),
                "failureCaptures": null,
                "failureContext": null,
                "runnerName": null,
                "runnerGroup": null,
                "status": "completed",
                "steps": null,
                "time": null,
                "unstable": \(unstable),
                "previousRun": null
            }
            """
        }
    }

    private func setCommitResponse(_ json: String) {
        let endpoint = APIEndpoint.commit(
            repoOwner: "pytorch",
            repoName: "pytorch",
            sha: testSha
        )
        mockClient.setResponse(json, for: endpoint.path)
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .loading)
        XCTAssertNil(viewModel.commitResponse)
        XCTAssertTrue(viewModel.groupedJobs.isEmpty)
        XCTAssertTrue(viewModel.expandedWorkflows.isEmpty)
        XCTAssertEqual(viewModel.statusFilter, .all)
        XCTAssertEqual(viewModel.jobSearchText, "")
        XCTAssertEqual(viewModel.totalJobs, 0)
        XCTAssertEqual(viewModel.passedJobs, 0)
        XCTAssertEqual(viewModel.failedJobs, 0)
        XCTAssertEqual(viewModel.pendingJobs, 0)
        XCTAssertEqual(viewModel.skippedJobs, 0)
        XCTAssertEqual(viewModel.cancelledJobs, 0)
        XCTAssertEqual(viewModel.sha, testSha)
        XCTAssertEqual(viewModel.repoOwner, "pytorch")
        XCTAssertEqual(viewModel.repoName, "pytorch")
    }

    // MARK: - Load Commit Success

    func testLoadCommitSuccess() async {
        let json = makeCommitResponseJSON(
            commitTitle: "Fix flaky test",
            author: "dev-user",
            prNum: 12345,
            jobs: [
                JobJSON(id: 1, name: "pull / build", workflowName: "pull", jobName: "build", conclusion: "success"),
                JobJSON(id: 2, name: "pull / test", workflowName: "pull", jobName: "test", conclusion: "failure",
                        failureLines: ["FAIL: test_something"]),
            ]
        )
        setCommitResponse(json)

        await viewModel.loadCommit()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertNotNil(viewModel.commitResponse)
        XCTAssertEqual(viewModel.totalJobs, 2)
        XCTAssertEqual(viewModel.passedJobs, 1)
        XCTAssertEqual(viewModel.failedJobs, 1)
    }

    func testLoadCommitError() async {
        let endpoint = APIEndpoint.commit(
            repoOwner: "pytorch",
            repoName: "pytorch",
            sha: testSha
        )
        mockClient.setError(APIError.serverError(500), for: endpoint.path)

        await viewModel.loadCommit()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
        XCTAssertNil(viewModel.commitResponse)
    }

    func testLoadCommitNotFound() async {
        // No response registered - MockAPIClient throws .notFound
        await viewModel.loadCommit()

        if case .error = viewModel.state {
            // expected
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    // MARK: - Summary Stats

    func testSummaryStats() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "b", workflowName: "pull", jobName: "test1", conclusion: "success"),
            JobJSON(id: 3, name: "c", workflowName: "pull", jobName: "test2", conclusion: "failure"),
            JobJSON(id: 4, name: "d", workflowName: "trunk", jobName: "build", conclusion: nil),
            JobJSON(id: 5, name: "e", workflowName: "trunk", jobName: "test", conclusion: "skipped"),
            JobJSON(id: 6, name: "f", workflowName: "trunk", jobName: "lint", conclusion: "cancelled"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        XCTAssertEqual(viewModel.totalJobs, 6)
        XCTAssertEqual(viewModel.passedJobs, 2)
        // failedJobs excludes "cancelled" to avoid double-counting with cancelledJobs
        XCTAssertEqual(viewModel.failedJobs, 1) // only "failure" (job 3)
        XCTAssertEqual(viewModel.pendingJobs, 1) // nil conclusion = pending
        XCTAssertEqual(viewModel.skippedJobs, 1)
        XCTAssertEqual(viewModel.cancelledJobs, 1) // "cancelled" (job 6)
        XCTAssertEqual(viewModel.otherJobs, 0)
    }

    func testSummaryStatsWithPendingVariants() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "j1", conclusion: "pending"),
            JobJSON(id: 2, name: "b", workflowName: "pull", jobName: "j2", conclusion: "queued"),
            JobJSON(id: 3, name: "c", workflowName: "pull", jobName: "j3", conclusion: "in_progress"),
            JobJSON(id: 4, name: "d", workflowName: "pull", jobName: "j4", conclusion: nil),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        XCTAssertEqual(viewModel.pendingJobs, 4)
        XCTAssertEqual(viewModel.passedJobs, 0)
        XCTAssertEqual(viewModel.failedJobs, 0)
    }

    // MARK: - Progress Ratios

    func testCompletionRatio() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "b", workflowName: "pull", jobName: "test", conclusion: "failure"),
            JobJSON(id: 3, name: "c", workflowName: "pull", jobName: "lint", conclusion: nil), // pending
            JobJSON(id: 4, name: "d", workflowName: "pull", jobName: "doc", conclusion: "success"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        // 3 out of 4 completed (1 pending)
        XCTAssertEqual(viewModel.completionRatio, 0.75, accuracy: 0.01)
        // 2 out of 4 success
        XCTAssertEqual(viewModel.successRatio, 0.5, accuracy: 0.01)
        // 1 out of 4 failed
        XCTAssertEqual(viewModel.failureRatio, 0.25, accuracy: 0.01)
    }

    func testRatiosWithZeroJobs() {
        // No jobs loaded
        XCTAssertEqual(viewModel.completionRatio, 0)
        XCTAssertEqual(viewModel.successRatio, 0)
        XCTAssertEqual(viewModel.failureRatio, 0)
    }

    func testAllJobsPassedRatios() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "b", workflowName: "pull", jobName: "test", conclusion: "success"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        XCTAssertEqual(viewModel.completionRatio, 1.0, accuracy: 0.01)
        XCTAssertEqual(viewModel.successRatio, 1.0, accuracy: 0.01)
        XCTAssertEqual(viewModel.failureRatio, 0.0, accuracy: 0.01)
    }

    // MARK: - Workflow Grouping

    func testWorkflowGrouping() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "pull / build", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "pull / test", workflowName: "pull", jobName: "test", conclusion: "success"),
            JobJSON(id: 3, name: "trunk / build", workflowName: "trunk", jobName: "build", conclusion: "failure"),
            JobJSON(id: 4, name: "nightly / build", workflowName: "nightly", jobName: "build", conclusion: "success"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        // Should be 3 workflow groups, sorted alphabetically
        XCTAssertEqual(viewModel.groupedJobs.count, 3)
        XCTAssertEqual(viewModel.groupedJobs[0].workflowName, "nightly")
        XCTAssertEqual(viewModel.groupedJobs[1].workflowName, "pull")
        XCTAssertEqual(viewModel.groupedJobs[2].workflowName, "trunk")

        // pull should have 2 jobs, others 1
        XCTAssertEqual(viewModel.groupedJobs[0].jobs.count, 1)
        XCTAssertEqual(viewModel.groupedJobs[1].jobs.count, 2)
        XCTAssertEqual(viewModel.groupedJobs[2].jobs.count, 1)
    }

    func testWorkflowGroupingSortsFailuresFirst() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "pull / build", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "pull / test1", workflowName: "pull", jobName: "test1", conclusion: "failure"),
            JobJSON(id: 3, name: "pull / test2", workflowName: "pull", jobName: "test2", conclusion: "success"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        let pullGroup = viewModel.groupedJobs.first { $0.workflowName == "pull" }
        XCTAssertNotNil(pullGroup)

        // Failure should come first
        XCTAssertEqual(pullGroup?.jobs.first?.conclusion, "failure")
    }

    func testAutoExpandsWorkflowsWithFailures() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "pull / build", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "trunk / test", workflowName: "trunk", jobName: "test", conclusion: "failure"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        // trunk has a failure so should be auto-expanded
        XCTAssertTrue(viewModel.expandedWorkflows.contains("trunk"))
        // pull has no failures so should not be expanded
        XCTAssertFalse(viewModel.expandedWorkflows.contains("pull"))
    }

    func testUnknownWorkflowName() async {
        let json = makeCommitResponseJSON(jobs: [
            // jobJSON with nil workflowName won't work in JSON, so let's test
            // with an actual value
            JobJSON(id: 1, name: "build", workflowName: "Unknown Workflow", jobName: "build", conclusion: "success"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        XCTAssertEqual(viewModel.groupedJobs.count, 1)
        XCTAssertEqual(viewModel.groupedJobs[0].workflowName, "Unknown Workflow")
    }

    // MARK: - Expand/Collapse

    func testToggleWorkflow() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "pull / build", workflowName: "pull", jobName: "build", conclusion: "success"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        // Initially not expanded (no failures)
        XCTAssertFalse(viewModel.expandedWorkflows.contains("pull"))

        viewModel.toggleWorkflow("pull")
        XCTAssertTrue(viewModel.expandedWorkflows.contains("pull"))

        viewModel.toggleWorkflow("pull")
        XCTAssertFalse(viewModel.expandedWorkflows.contains("pull"))
    }

    func testExpandAllWorkflows() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "pull / build", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "trunk / build", workflowName: "trunk", jobName: "build", conclusion: "success"),
            JobJSON(id: 3, name: "nightly / build", workflowName: "nightly", jobName: "build", conclusion: "success"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        // All success, so none auto-expanded
        XCTAssertTrue(viewModel.expandedWorkflows.isEmpty)

        viewModel.expandAllWorkflows()
        XCTAssertEqual(viewModel.expandedWorkflows.count, 3)
        XCTAssertTrue(viewModel.expandedWorkflows.contains("pull"))
        XCTAssertTrue(viewModel.expandedWorkflows.contains("trunk"))
        XCTAssertTrue(viewModel.expandedWorkflows.contains("nightly"))
    }

    func testCollapseAllWorkflows() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "pull / build", workflowName: "pull", jobName: "build", conclusion: "failure"),
            JobJSON(id: 2, name: "trunk / build", workflowName: "trunk", jobName: "build", conclusion: "failure"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        // Both auto-expanded due to failures
        XCTAssertEqual(viewModel.expandedWorkflows.count, 2)

        viewModel.collapseAllWorkflows()
        XCTAssertTrue(viewModel.expandedWorkflows.isEmpty)
    }

    func testHasExpandedWorkflows() async {
        XCTAssertFalse(viewModel.hasExpandedWorkflows)

        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "pull / build", workflowName: "pull", jobName: "build", conclusion: "success"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        viewModel.toggleWorkflow("pull")
        XCTAssertTrue(viewModel.hasExpandedWorkflows)

        viewModel.toggleWorkflow("pull")
        XCTAssertFalse(viewModel.hasExpandedWorkflows)
    }

    // MARK: - Status Filter

    func testStatusFilterAll() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "b", workflowName: "pull", jobName: "test", conclusion: "failure"),
            JobJSON(id: 3, name: "c", workflowName: "pull", jobName: "lint", conclusion: nil),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        viewModel.statusFilter = .all
        XCTAssertEqual(viewModel.visibleJobCount, 3)
    }

    func testStatusFilterFailed() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "b", workflowName: "pull", jobName: "test1", conclusion: "failure"),
            JobJSON(id: 3, name: "c", workflowName: "pull", jobName: "test2", conclusion: "failure"),
            JobJSON(id: 4, name: "d", workflowName: "pull", jobName: "lint", conclusion: nil),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        viewModel.statusFilter = .failed
        XCTAssertEqual(viewModel.visibleJobCount, 2)

        // All visible jobs should be failures
        let allJobs = viewModel.filteredGroupedJobs.flatMap { $0.jobs }
        XCTAssertTrue(allJobs.allSatisfy { $0.isFailure })
    }

    func testStatusFilterPassed() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "b", workflowName: "pull", jobName: "test", conclusion: "failure"),
            JobJSON(id: 3, name: "c", workflowName: "trunk", jobName: "build", conclusion: "success"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        viewModel.statusFilter = .passed
        XCTAssertEqual(viewModel.visibleJobCount, 2)

        let allJobs = viewModel.filteredGroupedJobs.flatMap { $0.jobs }
        XCTAssertTrue(allJobs.allSatisfy { $0.isSuccess })
    }

    func testStatusFilterPending() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "b", workflowName: "pull", jobName: "test", conclusion: nil),
            JobJSON(id: 3, name: "c", workflowName: "pull", jobName: "lint", conclusion: "pending"),
            JobJSON(id: 4, name: "d", workflowName: "pull", jobName: "doc", conclusion: "queued"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        viewModel.statusFilter = .pending
        XCTAssertEqual(viewModel.visibleJobCount, 3) // nil, pending, and queued
    }

    func testStatusFilterSkipped() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "b", workflowName: "pull", jobName: "test", conclusion: "skipped"),
            JobJSON(id: 3, name: "c", workflowName: "pull", jobName: "lint", conclusion: "skipped"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        viewModel.statusFilter = .skipped
        XCTAssertEqual(viewModel.visibleJobCount, 2)
    }

    func testStatusFilterRemovesEmptyWorkflows() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "b", workflowName: "trunk", jobName: "test", conclusion: "failure"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        // Filter to failed only - should only show trunk
        viewModel.statusFilter = .failed
        XCTAssertEqual(viewModel.filteredGroupedJobs.count, 1)
        XCTAssertEqual(viewModel.filteredGroupedJobs.first?.workflowName, "trunk")
    }

    // MARK: - Job Search

    func testJobSearchByName() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "pull / linux-build", workflowName: "pull", jobName: "linux-build", conclusion: "success"),
            JobJSON(id: 2, name: "pull / windows-build", workflowName: "pull", jobName: "windows-build", conclusion: "success"),
            JobJSON(id: 3, name: "pull / linux-test", workflowName: "pull", jobName: "linux-test", conclusion: "failure"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        viewModel.jobSearchText = "linux"
        XCTAssertEqual(viewModel.visibleJobCount, 2)
    }

    func testJobSearchCaseInsensitive() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "Linux-Build", conclusion: "success"),
            JobJSON(id: 2, name: "b", workflowName: "pull", jobName: "Windows-Build", conclusion: "success"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        viewModel.jobSearchText = "linux"
        XCTAssertEqual(viewModel.visibleJobCount, 1)
    }

    func testJobSearchEmptyReturnsAll() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "b", workflowName: "pull", jobName: "test", conclusion: "success"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        viewModel.jobSearchText = ""
        XCTAssertEqual(viewModel.visibleJobCount, 2)
    }

    func testJobSearchNoResults() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        viewModel.jobSearchText = "nonexistent"
        XCTAssertEqual(viewModel.visibleJobCount, 0)
        XCTAssertTrue(viewModel.filteredGroupedJobs.isEmpty)
    }

    // MARK: - Combined Filters

    func testCombinedStatusAndSearchFilter() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "linux-build", conclusion: "success"),
            JobJSON(id: 2, name: "b", workflowName: "pull", jobName: "linux-test", conclusion: "failure"),
            JobJSON(id: 3, name: "c", workflowName: "pull", jobName: "windows-build", conclusion: "failure"),
            JobJSON(id: 4, name: "d", workflowName: "pull", jobName: "windows-test", conclusion: "success"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        // Filter to failed + search for "linux"
        viewModel.statusFilter = .failed
        viewModel.jobSearchText = "linux"
        XCTAssertEqual(viewModel.visibleJobCount, 1)

        let jobs = viewModel.filteredGroupedJobs.flatMap { $0.jobs }
        XCTAssertEqual(jobs.first?.jobName, "linux-test")
    }

    func testIsFilteringFlag() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        XCTAssertFalse(viewModel.isFiltering)

        viewModel.statusFilter = .failed
        XCTAssertTrue(viewModel.isFiltering)

        viewModel.statusFilter = .all
        XCTAssertFalse(viewModel.isFiltering)

        viewModel.jobSearchText = "build"
        XCTAssertTrue(viewModel.isFiltering)
    }

    func testClearFilters() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "b", workflowName: "pull", jobName: "test", conclusion: "failure"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        viewModel.statusFilter = .failed
        viewModel.jobSearchText = "test"
        XCTAssertTrue(viewModel.isFiltering)
        XCTAssertEqual(viewModel.visibleJobCount, 1)

        viewModel.clearFilters()
        XCTAssertFalse(viewModel.isFiltering)
        XCTAssertEqual(viewModel.statusFilter, .all)
        XCTAssertEqual(viewModel.jobSearchText, "")
        XCTAssertEqual(viewModel.visibleJobCount, 2)
    }

    // MARK: - URLs

    func testCommitURL() {
        XCTAssertEqual(
            viewModel.commitURL,
            "https://github.com/pytorch/pytorch/commit/\(testSha)"
        )
    }

    func testCommitURLCustomRepo() {
        let vm = CommitDetailViewModel(
            sha: "abc123",
            repoOwner: "meta",
            repoName: "llama",
            apiClient: mockClient
        )
        XCTAssertEqual(vm.commitURL, "https://github.com/meta/llama/commit/abc123")
    }

    func testPrURLNilWhenNoCommitResponse() {
        XCTAssertNil(viewModel.prURL)
    }

    func testPrURLPresentWhenPrNumber() async {
        let json = makeCommitResponseJSON(prNum: 99001)
        setCommitResponse(json)

        await viewModel.loadCommit()

        XCTAssertEqual(viewModel.prURL, "https://github.com/pytorch/pytorch/pull/99001")
    }

    func testPrURLNilWhenNoPrNumber() async {
        let json = makeCommitResponseJSON(prNum: nil)
        setCommitResponse(json)

        await viewModel.loadCommit()

        XCTAssertNil(viewModel.prURL)
    }

    // MARK: - Autorevert Detection

    func testIsAutorevertWithRevertTitle() async {
        let json = makeCommitResponseJSON(commitTitle: "Revert: broken commit (#12345)")
        setCommitResponse(json)

        await viewModel.loadCommit()

        XCTAssertTrue(viewModel.isAutorevert)
    }

    func testIsAutorevertWithAutorevertTitle() async {
        let json = makeCommitResponseJSON(commitTitle: "Autorevert of PR #12345")
        setCommitResponse(json)

        await viewModel.loadCommit()

        XCTAssertTrue(viewModel.isAutorevert)
    }

    func testIsNotAutorevertWithNormalTitle() async {
        let json = makeCommitResponseJSON(commitTitle: "Add new feature")
        setCommitResponse(json)

        await viewModel.loadCommit()

        XCTAssertFalse(viewModel.isAutorevert)
    }

    func testIsAutorevertFalseBeforeLoad() {
        XCTAssertFalse(viewModel.isAutorevert)
    }

    // MARK: - Refresh

    func testRefreshUpdatesData() async {
        let json1 = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
        ])
        setCommitResponse(json1)

        await viewModel.loadCommit()
        XCTAssertEqual(viewModel.totalJobs, 1)

        // Update response with more jobs
        let json2 = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "b", workflowName: "pull", jobName: "test", conclusion: "success"),
        ])
        setCommitResponse(json2)

        await viewModel.refresh()
        XCTAssertEqual(viewModel.totalJobs, 2)
        XCTAssertEqual(viewModel.state, .loaded)
    }

    func testRefreshPreservesLoadedOnError() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()
        XCTAssertEqual(viewModel.state, .loaded)

        // Set error for refresh
        let endpoint = APIEndpoint.commit(
            repoOwner: "pytorch",
            repoName: "pytorch",
            sha: testSha
        )
        mockClient.setError(APIError.serverError(500), for: endpoint.path)

        await viewModel.refresh()

        // When data is already loaded, refresh errors should preserve existing data
        XCTAssertEqual(viewModel.state, .loaded, "Refresh should preserve loaded state when data exists")
        XCTAssertNotNil(viewModel.commitResponse, "Existing data should be preserved after failed refresh")
    }

    // MARK: - API Calls

    func testLoadCommitCallsCorrectEndpoint() async {
        let json = makeCommitResponseJSON()
        setCommitResponse(json)

        await viewModel.loadCommit()

        XCTAssertEqual(mockClient.callCount, 1)
        XCTAssertEqual(
            mockClient.callPaths().first,
            "/api/pytorch/pytorch/commit/\(testSha)"
        )
    }

    func testRefreshCallsCorrectEndpoint() async {
        let json = makeCommitResponseJSON()
        setCommitResponse(json)

        await viewModel.loadCommit()
        await viewModel.refresh()

        XCTAssertEqual(mockClient.callCount, 2)
        let paths = mockClient.callPaths()
        XCTAssertTrue(paths.allSatisfy { $0 == "/api/pytorch/pytorch/commit/\(testSha)" })
    }

    // MARK: - StatusFilter Enum

    func testStatusFilterAllCases() {
        let cases = CommitDetailViewModel.StatusFilter.allCases
        XCTAssertEqual(cases.count, 6)
        XCTAssertTrue(cases.contains(.all))
        XCTAssertTrue(cases.contains(.failed))
        XCTAssertTrue(cases.contains(.cancelled))
        XCTAssertTrue(cases.contains(.pending))
        XCTAssertTrue(cases.contains(.passed))
        XCTAssertTrue(cases.contains(.skipped))
    }

    func testStatusFilterRawValues() {
        XCTAssertEqual(CommitDetailViewModel.StatusFilter.all.rawValue, "All")
        XCTAssertEqual(CommitDetailViewModel.StatusFilter.failed.rawValue, "Failed")
        XCTAssertEqual(CommitDetailViewModel.StatusFilter.pending.rawValue, "Pending")
        XCTAssertEqual(CommitDetailViewModel.StatusFilter.passed.rawValue, "Passed")
        XCTAssertEqual(CommitDetailViewModel.StatusFilter.skipped.rawValue, "Skipped")
    }

    // MARK: - ViewState Equatable

    func testViewStateEquatable() {
        XCTAssertEqual(CommitDetailViewModel.ViewState.loading, .loading)
        XCTAssertEqual(CommitDetailViewModel.ViewState.loaded, .loaded)
        XCTAssertEqual(CommitDetailViewModel.ViewState.error("A"), .error("A"))
        XCTAssertNotEqual(CommitDetailViewModel.ViewState.error("A"), .error("B"))
        XCTAssertNotEqual(CommitDetailViewModel.ViewState.loading, .loaded)
        XCTAssertNotEqual(CommitDetailViewModel.ViewState.loading, .error("X"))
    }

    // MARK: - Auto-Refresh

    func testAutoRefreshToggle() async {
        // Initially enabled
        XCTAssertTrue(viewModel.isAutoRefreshEnabled)

        viewModel.toggleAutoRefresh()
        XCTAssertFalse(viewModel.isAutoRefreshEnabled)

        viewModel.toggleAutoRefresh()
        XCTAssertTrue(viewModel.isAutoRefreshEnabled)
    }

    func testAutoRefreshStartStop() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()
        XCTAssertEqual(viewModel.state, .loaded)

        // Start auto-refresh while enabled
        XCTAssertTrue(viewModel.isAutoRefreshEnabled)
        viewModel.startAutoRefresh()

        // Stop auto-refresh
        viewModel.stopAutoRefresh()

        // Disable then start -- should be a no-op (guard returns early)
        viewModel.isAutoRefreshEnabled = false
        viewModel.startAutoRefresh()

        // Re-enable via toggle -- starts auto-refresh again
        viewModel.toggleAutoRefresh()
        XCTAssertTrue(viewModel.isAutoRefreshEnabled)

        // Disable via toggle -- stops auto-refresh
        viewModel.toggleAutoRefresh()
        XCTAssertFalse(viewModel.isAutoRefreshEnabled)
    }

    // MARK: - Status Filter Cancelled

    func testStatusFilterCancelledState() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "b", workflowName: "pull", jobName: "test1", conclusion: "cancelled"),
            JobJSON(id: 3, name: "c", workflowName: "pull", jobName: "test2", conclusion: "canceled"),
            JobJSON(id: 4, name: "d", workflowName: "pull", jobName: "test3", conclusion: "failure"),
            JobJSON(id: 5, name: "e", workflowName: "pull", jobName: "test4", conclusion: "timed_out"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        viewModel.statusFilter = .cancelled
        XCTAssertTrue(viewModel.isFiltering)

        // cancelled, canceled, and timed_out should all match the cancelled filter
        XCTAssertEqual(viewModel.visibleJobCount, 3)

        let allJobs = viewModel.filteredGroupedJobs.flatMap { $0.jobs }
        for job in allJobs {
            let c = job.conclusion?.lowercased()
            XCTAssertTrue(
                c == "cancelled" || c == "canceled" || c == "timed_out",
                "Expected cancelled/canceled/timed_out but got \(c ?? "nil")"
            )
        }
    }

    // MARK: - Search Filter Clears on Reset

    func testSearchFilterClearsOnReset() async {
        let json = makeCommitResponseJSON(jobs: [
            JobJSON(id: 1, name: "a", workflowName: "pull", jobName: "linux-build", conclusion: "success"),
            JobJSON(id: 2, name: "b", workflowName: "pull", jobName: "windows-build", conclusion: "success"),
        ])
        setCommitResponse(json)

        await viewModel.loadCommit()

        // Apply search and status filter
        viewModel.jobSearchText = "linux"
        viewModel.statusFilter = .passed
        XCTAssertTrue(viewModel.isFiltering)
        XCTAssertEqual(viewModel.visibleJobCount, 1)

        // Reset filters should clear both search and status filter
        viewModel.resetFilters()
        XCTAssertEqual(viewModel.jobSearchText, "")
        XCTAssertEqual(viewModel.statusFilter, .all)
        XCTAssertFalse(viewModel.isFiltering)
        XCTAssertEqual(viewModel.visibleJobCount, 2)
    }
}
