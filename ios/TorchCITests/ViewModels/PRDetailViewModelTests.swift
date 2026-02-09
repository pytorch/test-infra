import XCTest
@testable import TorchCI

@MainActor
final class PRDetailViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: PRDetailViewModel!

    private let testPRNumber = 12345

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = PRDetailViewModel(
            prNumber: testPRNumber,
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

    /// Build a minimal PR response JSON matching what the API actually returns
    /// (title, body, shas only -- no state, author, timestamps, or branch info).
    private func makePRResponseJSON(
        title: String = "Fix distributed NCCL test",
        body: String = "This fixes a flaky test.",
        shas: [(sha: String, title: String)] = [
            (sha: "aaa1111111111111111111111111111111111111", title: "Initial commit"),
            (sha: "bbb2222222222222222222222222222222222222", title: "Address review feedback"),
        ]
    ) -> String {
        let shaArray = shas.map { s in
            #"{"sha":"\#(s.sha)","title":"\#(s.title)"}"#
        }
        return """
        {
            "title": "\(title)",
            "body": "\(body)",
            "shas": [\(shaArray.joined(separator: ","))]
        }
        """
    }

    /// Build a PR response JSON that includes the optional fields the API might
    /// someday return (state, author, timestamps, branch info).
    private func makeFullPRResponseJSON(
        title: String = "Add new feature",
        body: String = "Full details.",
        shas: [(sha: String, title: String)] = [
            (sha: "ccc3333333333333333333333333333333333333", title: "Feature commit"),
        ],
        state: String = "open",
        authorLogin: String = "test-user",
        headRef: String = "feature-branch",
        baseRef: String = "main"
    ) -> String {
        let shaArray = shas.map { s in
            #"{"sha":"\#(s.sha)","title":"\#(s.title)"}"#
        }
        return """
        {
            "title": "\(title)",
            "body": "\(body)",
            "shas": [\(shaArray.joined(separator: ","))],
            "state": "\(state)",
            "author": {"login": "\(authorLogin)", "avatar_url": "https://github.com/\(authorLogin).png", "url": "https://api.github.com/users/\(authorLogin)"},
            "number": \(testPRNumber),
            "created_at": "2026-02-01T10:00:00Z",
            "updated_at": "2026-02-05T15:30:00Z",
            "head_ref": "\(headRef)",
            "base_ref": "\(baseRef)"
        }
        """
    }

    /// Build a commit response JSON for SHA selection tests.
    private func makeCommitResponseJSON(
        sha: String,
        jobs: [JobJSON] = []
    ) -> String {
        let jobsStr = jobs.map { $0.toJSON() }.joined(separator: ",")
        return """
        {
            "commit": {
                "sha": "\(sha)",
                "commitTitle": "Test commit",
                "commitMessageBody": null,
                "author": "test-user",
                "authorUrl": "https://github.com/test-user",
                "time": "2026-02-05T14:30:00Z",
                "prNum": \(testPRNumber),
                "diffNum": null
            },
            "jobs": [\(jobsStr)]
        }
        """
    }

    struct JobJSON {
        var id: Int
        var name: String
        var workflowName: String
        var jobName: String
        var conclusion: String?

        func toJSON() -> String {
            let conclusionStr = conclusion.map { "\"\($0)\"" } ?? "null"
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
                "durationS": null,
                "failureLines": null,
                "failureCaptures": null,
                "failureContext": null,
                "runnerName": null,
                "runnerGroup": null,
                "status": "completed",
                "steps": null,
                "time": null,
                "unstable": false,
                "previousRun": null
            }
            """
        }
    }

    private func setPRResponse(_ json: String) {
        let endpoint = APIEndpoint.pullRequest(
            repoOwner: "pytorch",
            repoName: "pytorch",
            prNumber: testPRNumber
        )
        mockClient.setResponse(json, for: endpoint.path)
    }

    private func setCommitResponse(_ json: String, for sha: String) {
        let endpoint = APIEndpoint.commit(
            repoOwner: "pytorch",
            repoName: "pytorch",
            sha: sha
        )
        mockClient.setResponse(json, for: endpoint.path)
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .loading)
        XCTAssertNil(viewModel.prResponse)
        XCTAssertNil(viewModel.selectedSha)
        XCTAssertTrue(viewModel.commits.isEmpty)
        XCTAssertTrue(viewModel.groupedJobs.isEmpty)
        XCTAssertTrue(viewModel.expandedWorkflows.isEmpty)
        XCTAssertEqual(viewModel.jobFilter, .all)
        XCTAssertEqual(viewModel.jobSearchQuery, "")
        XCTAssertFalse(viewModel.isBodyExpanded)
        XCTAssertEqual(viewModel.totalJobs, 0)
        XCTAssertEqual(viewModel.passedJobs, 0)
        XCTAssertEqual(viewModel.failedJobs, 0)
        XCTAssertEqual(viewModel.pendingJobs, 0)
        XCTAssertEqual(viewModel.skippedJobs, 0)
        XCTAssertFalse(viewModel.isFiltering)
        XCTAssertFalse(viewModel.hasMetadata)
    }

    func testConfigProperties() {
        XCTAssertEqual(viewModel.prNumber, testPRNumber)
        XCTAssertEqual(viewModel.repoOwner, "pytorch")
        XCTAssertEqual(viewModel.repoName, "pytorch")
        XCTAssertEqual(viewModel.prURL, "https://github.com/pytorch/pytorch/pull/12345")
        XCTAssertEqual(viewModel.hudURL, "https://hud.pytorch.org/pytorch/pytorch/pull/12345")
    }

    // MARK: - Load PR (Minimal Response -- What The API Actually Returns)

    func testLoadPRMinimalResponse() async {
        let sha1 = "aaa1111111111111111111111111111111111111"
        let sha2 = "bbb2222222222222222222222222222222222222"

        setPRResponse(makePRResponseJSON())
        // The VM auto-selects the head SHA and loads jobs for it.
        setCommitResponse(makeCommitResponseJSON(sha: sha2), for: sha2)

        await viewModel.loadPR()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertNotNil(viewModel.prResponse)
        XCTAssertEqual(viewModel.prResponse?.title, "Fix distributed NCCL test")
        XCTAssertEqual(viewModel.prResponse?.body, "This fixes a flaky test.")
        XCTAssertEqual(viewModel.commits.count, 2)
        XCTAssertEqual(viewModel.commits[0].sha, sha1)
        XCTAssertEqual(viewModel.commits[1].sha, sha2)

        // Head SHA (last in list) auto-selected
        XCTAssertEqual(viewModel.selectedSha, sha2)
    }

    func testLoadPRMinimalResponseHasNoMetadata() async {
        let sha = "bbb2222222222222222222222222222222222222"
        setPRResponse(makePRResponseJSON())
        setCommitResponse(makeCommitResponseJSON(sha: sha), for: sha)

        await viewModel.loadPR()

        // API returns no state, author, timestamps, or branch info
        XCTAssertNil(viewModel.prResponse?.state)
        XCTAssertNil(viewModel.prResponse?.author)
        XCTAssertNil(viewModel.prResponse?.createdAt)
        XCTAssertNil(viewModel.prResponse?.updatedAt)
        XCTAssertNil(viewModel.prResponse?.headRef)
        XCTAssertNil(viewModel.prResponse?.baseRef)
        XCTAssertNil(viewModel.prResponse?.branchInfo)
        XCTAssertFalse(viewModel.hasMetadata)

        // Timestamp helpers should return nil
        XCTAssertNil(viewModel.createdTimeAgo)
        XCTAssertNil(viewModel.updatedTimeAgo)

        // State helpers should return neutral/default
        XCTAssertEqual(viewModel.prStateColor, "neutral")
        XCTAssertEqual(viewModel.prStateIcon, "questionmark.circle")
    }

    // MARK: - Load PR (Full Response -- Forward-Compatibility)

    func testLoadPRFullResponseIncludesMetadata() async {
        let sha = "ccc3333333333333333333333333333333333333"
        setPRResponse(makeFullPRResponseJSON())
        setCommitResponse(makeCommitResponseJSON(sha: sha), for: sha)

        await viewModel.loadPR()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.prResponse?.state, "open")
        XCTAssertEqual(viewModel.prResponse?.author?.login, "test-user")
        XCTAssertEqual(viewModel.prResponse?.branchInfo, "feature-branch → main")
        XCTAssertNotNil(viewModel.prResponse?.createdAt)
        XCTAssertNotNil(viewModel.prResponse?.updatedAt)
        XCTAssertTrue(viewModel.hasMetadata)

        // Timestamps should produce human-readable values
        XCTAssertNotNil(viewModel.createdTimeAgo)
        XCTAssertNotNil(viewModel.updatedTimeAgo)
    }

    func testStateColorAndIconForOpen() async {
        let sha = "ccc3333333333333333333333333333333333333"
        setPRResponse(makeFullPRResponseJSON(state: "open"))
        setCommitResponse(makeCommitResponseJSON(sha: sha), for: sha)

        await viewModel.loadPR()

        XCTAssertEqual(viewModel.prStateColor, "success")
        XCTAssertEqual(viewModel.prStateIcon, "arrow.triangle.branch")
    }

    func testStateColorAndIconForClosed() async {
        let sha = "ccc3333333333333333333333333333333333333"
        setPRResponse(makeFullPRResponseJSON(state: "closed"))
        setCommitResponse(makeCommitResponseJSON(sha: sha), for: sha)

        await viewModel.loadPR()

        XCTAssertEqual(viewModel.prStateColor, "failure")
        XCTAssertEqual(viewModel.prStateIcon, "xmark.circle")
    }

    func testStateColorAndIconForMerged() async {
        let sha = "ccc3333333333333333333333333333333333333"
        setPRResponse(makeFullPRResponseJSON(state: "merged"))
        setCommitResponse(makeCommitResponseJSON(sha: sha), for: sha)

        await viewModel.loadPR()

        XCTAssertEqual(viewModel.prStateColor, "unstable")
        XCTAssertEqual(viewModel.prStateIcon, "arrow.triangle.merge")
    }

    // MARK: - Load PR Error

    func testLoadPRErrorSetsErrorState() async {
        // No response registered -> MockAPIClient throws .notFound
        await viewModel.loadPR()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadPRServerErrorSetsErrorState() async {
        let endpoint = APIEndpoint.pullRequest(
            repoOwner: "pytorch",
            repoName: "pytorch",
            prNumber: testPRNumber
        )
        mockClient.setError(APIError.serverError(500), for: endpoint.path)

        await viewModel.loadPR()

        if case .error = viewModel.state {
            // Expected
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    // MARK: - SHA Selection

    func testSelectShaLoadsJobsForCommit() async {
        let sha = "bbb2222222222222222222222222222222222222"
        setPRResponse(makePRResponseJSON())

        let jobs: [JobJSON] = [
            JobJSON(id: 1, name: "build", workflowName: "pull", jobName: "linux-build", conclusion: "success"),
            JobJSON(id: 2, name: "test", workflowName: "pull", jobName: "linux-test", conclusion: "failure"),
            JobJSON(id: 3, name: "lint", workflowName: "Lint", jobName: "flake8", conclusion: nil),
        ]
        setCommitResponse(makeCommitResponseJSON(sha: sha, jobs: jobs), for: sha)

        await viewModel.loadPR()

        XCTAssertEqual(viewModel.selectedSha, sha)
        XCTAssertEqual(viewModel.totalJobs, 3)
        XCTAssertEqual(viewModel.passedJobs, 1)
        XCTAssertEqual(viewModel.failedJobs, 1)
        XCTAssertEqual(viewModel.pendingJobs, 1)
    }

    func testSelectDifferentSha() async {
        let sha1 = "aaa1111111111111111111111111111111111111"
        let sha2 = "bbb2222222222222222222222222222222222222"

        setPRResponse(makePRResponseJSON())

        let jobs1: [JobJSON] = [
            JobJSON(id: 10, name: "build", workflowName: "pull", jobName: "build-job", conclusion: "success"),
        ]
        let jobs2: [JobJSON] = [
            JobJSON(id: 20, name: "test", workflowName: "pull", jobName: "test-job", conclusion: "failure"),
            JobJSON(id: 21, name: "lint", workflowName: "Lint", jobName: "lint-job", conclusion: "success"),
        ]
        setCommitResponse(makeCommitResponseJSON(sha: sha1, jobs: jobs1), for: sha1)
        setCommitResponse(makeCommitResponseJSON(sha: sha2, jobs: jobs2), for: sha2)

        await viewModel.loadPR()

        // Initially selects head (sha2)
        XCTAssertEqual(viewModel.selectedSha, sha2)
        XCTAssertEqual(viewModel.totalJobs, 2)

        // Switch to sha1
        await viewModel.selectSha(sha1)
        XCTAssertEqual(viewModel.selectedSha, sha1)
        XCTAssertEqual(viewModel.totalJobs, 1)
        XCTAssertEqual(viewModel.passedJobs, 1)
        XCTAssertEqual(viewModel.failedJobs, 0)
    }

    func testSelectShaResetsFilters() async {
        let sha1 = "aaa1111111111111111111111111111111111111"
        let sha2 = "bbb2222222222222222222222222222222222222"

        setPRResponse(makePRResponseJSON())
        setCommitResponse(makeCommitResponseJSON(sha: sha2, jobs: [
            JobJSON(id: 1, name: "job", workflowName: "wf", jobName: "j", conclusion: "failure"),
        ]), for: sha2)
        setCommitResponse(makeCommitResponseJSON(sha: sha1), for: sha1)

        await viewModel.loadPR()

        // Apply a filter
        viewModel.setJobFilter(.failures)
        viewModel.jobSearchQuery = "test"
        XCTAssertTrue(viewModel.isFiltering)

        // Switch SHA -- filter should reset
        await viewModel.selectSha(sha1)
        XCTAssertEqual(viewModel.jobFilter, .all)
        XCTAssertEqual(viewModel.jobSearchQuery, "")
        XCTAssertFalse(viewModel.isFiltering)
    }

    // MARK: - Grouped Jobs

    func testGroupedJobsByWorkflow() async {
        let sha = "bbb2222222222222222222222222222222222222"
        setPRResponse(makePRResponseJSON())

        let jobs: [JobJSON] = [
            JobJSON(id: 1, name: "build", workflowName: "pull", jobName: "linux-build", conclusion: "success"),
            JobJSON(id: 2, name: "test-1", workflowName: "pull", jobName: "linux-test-1", conclusion: "success"),
            JobJSON(id: 3, name: "lint-flake8", workflowName: "Lint", jobName: "flake8", conclusion: "failure"),
            JobJSON(id: 4, name: "lint-mypy", workflowName: "Lint", jobName: "mypy", conclusion: "success"),
        ]
        setCommitResponse(makeCommitResponseJSON(sha: sha, jobs: jobs), for: sha)

        await viewModel.loadPR()

        XCTAssertEqual(viewModel.groupedJobs.count, 2)

        // Sorted alphabetically: "Lint" before "pull"
        XCTAssertEqual(viewModel.groupedJobs[0].workflowName, "Lint")
        XCTAssertEqual(viewModel.groupedJobs[0].jobs.count, 2)
        XCTAssertEqual(viewModel.groupedJobs[1].workflowName, "pull")
        XCTAssertEqual(viewModel.groupedJobs[1].jobs.count, 2)
    }

    func testAutoExpandWorkflowsWithFailures() async {
        let sha = "bbb2222222222222222222222222222222222222"
        setPRResponse(makePRResponseJSON())

        let jobs: [JobJSON] = [
            JobJSON(id: 1, name: "build", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "lint", workflowName: "Lint", jobName: "lint", conclusion: "failure"),
        ]
        setCommitResponse(makeCommitResponseJSON(sha: sha, jobs: jobs), for: sha)

        await viewModel.loadPR()

        // Only Lint has failures, so only Lint should be expanded
        XCTAssertTrue(viewModel.expandedWorkflows.contains("Lint"))
        XCTAssertFalse(viewModel.expandedWorkflows.contains("pull"))
    }

    // MARK: - Job Filters

    func testFilterByFailures() async {
        let sha = "bbb2222222222222222222222222222222222222"
        setPRResponse(makePRResponseJSON())

        let jobs: [JobJSON] = [
            JobJSON(id: 1, name: "build", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "test", workflowName: "pull", jobName: "test", conclusion: "failure"),
            JobJSON(id: 3, name: "lint", workflowName: "Lint", jobName: "lint", conclusion: "success"),
        ]
        setCommitResponse(makeCommitResponseJSON(sha: sha, jobs: jobs), for: sha)

        await viewModel.loadPR()

        viewModel.setJobFilter(.failures)
        XCTAssertTrue(viewModel.isFiltering)

        let filtered = viewModel.filteredGroupedJobs
        XCTAssertEqual(filtered.count, 1) // Only "pull" has a failure
        XCTAssertEqual(filtered[0].workflowName, "pull")
        XCTAssertEqual(filtered[0].jobs.count, 1) // Only the failed job
        XCTAssertEqual(viewModel.filteredJobCount, 1)
    }

    func testFilterByPending() async {
        let sha = "bbb2222222222222222222222222222222222222"
        setPRResponse(makePRResponseJSON())

        let jobs: [JobJSON] = [
            JobJSON(id: 1, name: "build", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "test", workflowName: "pull", jobName: "test", conclusion: nil),
        ]
        setCommitResponse(makeCommitResponseJSON(sha: sha, jobs: jobs), for: sha)

        await viewModel.loadPR()

        viewModel.setJobFilter(.pending)
        XCTAssertEqual(viewModel.filteredJobCount, 1)
    }

    func testSearchFilter() async {
        let sha = "bbb2222222222222222222222222222222222222"
        setPRResponse(makePRResponseJSON())

        let jobs: [JobJSON] = [
            JobJSON(id: 1, name: "linux-build", workflowName: "pull", jobName: "linux-build", conclusion: "success"),
            JobJSON(id: 2, name: "windows-build", workflowName: "pull", jobName: "windows-build", conclusion: "success"),
        ]
        setCommitResponse(makeCommitResponseJSON(sha: sha, jobs: jobs), for: sha)

        await viewModel.loadPR()

        viewModel.jobSearchQuery = "linux"
        XCTAssertTrue(viewModel.isFiltering)
        XCTAssertEqual(viewModel.filteredJobCount, 1)
    }

    func testClearJobSearch() async {
        let sha = "bbb2222222222222222222222222222222222222"
        setPRResponse(makePRResponseJSON())
        setCommitResponse(makeCommitResponseJSON(sha: sha), for: sha)

        await viewModel.loadPR()

        viewModel.jobSearchQuery = "test"
        XCTAssertTrue(viewModel.isFiltering)

        viewModel.clearJobSearch()
        XCTAssertEqual(viewModel.jobSearchQuery, "")
    }

    func testShowFailuresOnly() async {
        let sha = "bbb2222222222222222222222222222222222222"
        setPRResponse(makePRResponseJSON())

        let jobs: [JobJSON] = [
            JobJSON(id: 1, name: "build", workflowName: "pull", jobName: "build", conclusion: "failure"),
            JobJSON(id: 2, name: "lint", workflowName: "Lint", jobName: "lint", conclusion: "success"),
        ]
        setCommitResponse(makeCommitResponseJSON(sha: sha, jobs: jobs), for: sha)

        await viewModel.loadPR()

        viewModel.showFailuresOnly()
        XCTAssertEqual(viewModel.jobFilter, .failures)
        // Workflows with failures should be expanded
        XCTAssertTrue(viewModel.expandedWorkflows.contains("pull"))
    }

    // MARK: - Workflow Expand/Collapse

    func testToggleWorkflow() {
        viewModel.expandedWorkflows = ["pull"]

        viewModel.toggleWorkflow("pull")
        XCTAssertFalse(viewModel.expandedWorkflows.contains("pull"))

        viewModel.toggleWorkflow("pull")
        XCTAssertTrue(viewModel.expandedWorkflows.contains("pull"))
    }

    func testExpandAllWorkflows() async {
        let sha = "bbb2222222222222222222222222222222222222"
        setPRResponse(makePRResponseJSON())

        let jobs: [JobJSON] = [
            JobJSON(id: 1, name: "build", workflowName: "pull", jobName: "build", conclusion: "success"),
            JobJSON(id: 2, name: "lint", workflowName: "Lint", jobName: "lint", conclusion: "success"),
        ]
        setCommitResponse(makeCommitResponseJSON(sha: sha, jobs: jobs), for: sha)

        await viewModel.loadPR()

        // Neither workflow has failures, so none are expanded
        XCTAssertTrue(viewModel.expandedWorkflows.isEmpty)

        viewModel.expandAllWorkflows()
        XCTAssertTrue(viewModel.expandedWorkflows.contains("pull"))
        XCTAssertTrue(viewModel.expandedWorkflows.contains("Lint"))
    }

    func testCollapseAllWorkflows() async {
        let sha = "bbb2222222222222222222222222222222222222"
        setPRResponse(makePRResponseJSON())

        let jobs: [JobJSON] = [
            JobJSON(id: 1, name: "build", workflowName: "pull", jobName: "build", conclusion: "failure"),
        ]
        setCommitResponse(makeCommitResponseJSON(sha: sha, jobs: jobs), for: sha)

        await viewModel.loadPR()

        XCTAssertFalse(viewModel.expandedWorkflows.isEmpty)

        viewModel.collapseAllWorkflows()
        XCTAssertTrue(viewModel.expandedWorkflows.isEmpty)
    }

    // MARK: - Body Toggle

    func testToggleBodyExpanded() {
        XCTAssertFalse(viewModel.isBodyExpanded)

        viewModel.toggleBodyExpanded()
        XCTAssertTrue(viewModel.isBodyExpanded)

        viewModel.toggleBodyExpanded()
        XCTAssertFalse(viewModel.isBodyExpanded)
    }

    // MARK: - Refresh

    func testRefreshPreservesSelectedSha() async {
        let sha1 = "aaa1111111111111111111111111111111111111"
        let sha2 = "bbb2222222222222222222222222222222222222"

        setPRResponse(makePRResponseJSON())
        setCommitResponse(makeCommitResponseJSON(sha: sha1), for: sha1)
        setCommitResponse(makeCommitResponseJSON(sha: sha2), for: sha2)

        await viewModel.loadPR()
        // Switch to sha1
        await viewModel.selectSha(sha1)
        XCTAssertEqual(viewModel.selectedSha, sha1)

        // Refresh should preserve sha1 (it's still in the shas list)
        await viewModel.refresh()
        XCTAssertEqual(viewModel.selectedSha, sha1)
        XCTAssertEqual(viewModel.state, .loaded)
    }

    func testRefreshFallsBackToHeadIfSelectedShaGone() async {
        let sha2 = "bbb2222222222222222222222222222222222222"
        let sha3 = "ddd4444444444444444444444444444444444444"

        setPRResponse(makePRResponseJSON())
        setCommitResponse(makeCommitResponseJSON(sha: sha2), for: sha2)

        await viewModel.loadPR()
        XCTAssertEqual(viewModel.selectedSha, sha2)

        // Simulate PR update: old sha2 is gone, new sha3 is head
        let updatedJSON = makePRResponseJSON(
            shas: [(sha: sha3, title: "New commit")]
        )
        setPRResponse(updatedJSON)
        setCommitResponse(makeCommitResponseJSON(sha: sha3), for: sha3)

        await viewModel.refresh()
        XCTAssertEqual(viewModel.selectedSha, sha3)
    }

    // MARK: - Commits

    func testCommitsFromShas() async {
        let sha = "bbb2222222222222222222222222222222222222"
        setPRResponse(makePRResponseJSON())
        setCommitResponse(makeCommitResponseJSON(sha: sha), for: sha)

        await viewModel.loadPR()

        XCTAssertEqual(viewModel.commits.count, 2)
        XCTAssertEqual(viewModel.commits[0].shortSha, "aaa1111")
        XCTAssertEqual(viewModel.commits[1].shortSha, "bbb2222")
        XCTAssertEqual(viewModel.commits[0].title, "Initial commit")
        XCTAssertEqual(viewModel.commits[1].title, "Address review feedback")
    }

    func testSelectedCommitTitle() async {
        let sha = "bbb2222222222222222222222222222222222222"
        setPRResponse(makePRResponseJSON())
        setCommitResponse(makeCommitResponseJSON(sha: sha), for: sha)

        await viewModel.loadPR()

        XCTAssertEqual(viewModel.selectedCommitTitle, "Address review feedback")
    }

    func testHeadShaIsLastInList() async {
        let sha = "bbb2222222222222222222222222222222222222"
        setPRResponse(makePRResponseJSON())
        setCommitResponse(makeCommitResponseJSON(sha: sha), for: sha)

        await viewModel.loadPR()

        XCTAssertEqual(viewModel.prResponse?.headSha, sha)
    }

    // MARK: - Empty Shas

    func testLoadPRWithNoShas() async {
        let json = """
        {
            "title": "Empty PR",
            "body": "No commits yet.",
            "shas": []
        }
        """
        setPRResponse(json)

        await viewModel.loadPR()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertTrue(viewModel.commits.isEmpty)
        XCTAssertNil(viewModel.selectedSha)
        XCTAssertNil(viewModel.prResponse?.headSha)
    }

    // MARK: - PRResponse Model Tests

    func testPRResponseDecodesMinimalJSON() throws {
        let json = """
        {"title":"Test","body":"Body","shas":[{"sha":"abc123","title":"Commit"}]}
        """
        let data = json.data(using: .utf8)!
        let response = try JSONDecoder().decode(PRResponse.self, from: data)

        XCTAssertEqual(response.title, "Test")
        XCTAssertEqual(response.body, "Body")
        XCTAssertEqual(response.shas?.count, 1)
        XCTAssertNil(response.state)
        XCTAssertNil(response.author)
        XCTAssertNil(response.number)
        XCTAssertNil(response.createdAt)
        XCTAssertNil(response.updatedAt)
        XCTAssertNil(response.mergedAt)
        XCTAssertNil(response.closedAt)
        XCTAssertNil(response.headRef)
        XCTAssertNil(response.baseRef)
        XCTAssertNil(response.branchInfo)
        XCTAssertFalse(response.hasMetadata)
    }

    func testPRResponseDecodesFullJSON() throws {
        let json = """
        {
            "title":"Test","body":"Body",
            "shas":[{"sha":"abc123","title":"Commit"}],
            "state":"open",
            "author":{"login":"user1","avatar_url":"https://example.com/avatar","url":"https://api.github.com/users/user1"},
            "number":42,
            "created_at":"2026-01-01T00:00:00Z",
            "updated_at":"2026-01-02T00:00:00Z",
            "merged_at":null,
            "closed_at":null,
            "head_ref":"feat",
            "base_ref":"main"
        }
        """
        let data = json.data(using: .utf8)!
        let response = try JSONDecoder().decode(PRResponse.self, from: data)

        XCTAssertEqual(response.state, "open")
        XCTAssertEqual(response.author?.login, "user1")
        XCTAssertEqual(response.number, 42)
        XCTAssertEqual(response.branchInfo, "feat → main")
        XCTAssertTrue(response.hasMetadata)
    }

    func testPRResponseHasMetadataWithOnlyState() throws {
        let json = """
        {"title":"T","body":"B","shas":[],"state":"open"}
        """
        let data = json.data(using: .utf8)!
        let response = try JSONDecoder().decode(PRResponse.self, from: data)
        XCTAssertTrue(response.hasMetadata)
    }

    func testPRResponseHasMetadataWithOnlyAuthor() throws {
        let json = """
        {"title":"T","body":"B","shas":[],"author":{"login":"u"}}
        """
        let data = json.data(using: .utf8)!
        let response = try JSONDecoder().decode(PRResponse.self, from: data)
        XCTAssertTrue(response.hasMetadata)
    }

    // MARK: - Relative Time

    func testRelativeTimeJustNow() {
        let formatter = ISO8601DateFormatter()
        let now = formatter.string(from: Date())
        let result = PRDetailViewModel.relativeTime(from: now)
        XCTAssertEqual(result, "just now")
    }

    func testRelativeTimeMinutesAgo() {
        let formatter = ISO8601DateFormatter()
        let fiveMinutesAgo = Date().addingTimeInterval(-300)
        let result = PRDetailViewModel.relativeTime(from: formatter.string(from: fiveMinutesAgo))
        XCTAssertEqual(result, "5m ago")
    }

    func testRelativeTimeHoursAgo() {
        let formatter = ISO8601DateFormatter()
        let twoHoursAgo = Date().addingTimeInterval(-7200)
        let result = PRDetailViewModel.relativeTime(from: formatter.string(from: twoHoursAgo))
        XCTAssertEqual(result, "2h ago")
    }

    func testRelativeTimeDaysAgo() {
        let formatter = ISO8601DateFormatter()
        let threeDaysAgo = Date().addingTimeInterval(-259200)
        let result = PRDetailViewModel.relativeTime(from: formatter.string(from: threeDaysAgo))
        XCTAssertEqual(result, "3d ago")
    }

    func testRelativeTimeWeeksAgo() {
        let formatter = ISO8601DateFormatter()
        let twoWeeksAgo = Date().addingTimeInterval(-1_209_600)
        let result = PRDetailViewModel.relativeTime(from: formatter.string(from: twoWeeksAgo))
        XCTAssertEqual(result, "2w ago")
    }

    func testRelativeTimeInvalidString() {
        let result = PRDetailViewModel.relativeTime(from: "not-a-date")
        XCTAssertNil(result)
    }

    // MARK: - ViewState Equatable

    func testViewStateEquality() {
        XCTAssertEqual(PRDetailViewModel.ViewState.loading, .loading)
        XCTAssertEqual(PRDetailViewModel.ViewState.loaded, .loaded)
        XCTAssertEqual(PRDetailViewModel.ViewState.error("a"), .error("a"))
    }

    func testViewStateInequality() {
        XCTAssertNotEqual(PRDetailViewModel.ViewState.loading, .loaded)
        XCTAssertNotEqual(PRDetailViewModel.ViewState.loading, .error("x"))
        XCTAssertNotEqual(PRDetailViewModel.ViewState.error("a"), .error("b"))
    }

    // MARK: - JobFilter Enum

    func testJobFilterCases() {
        let allCases = PRDetailViewModel.JobFilter.allCases
        XCTAssertEqual(allCases.count, 3)
        XCTAssertEqual(PRDetailViewModel.JobFilter.all.rawValue, "All")
        XCTAssertEqual(PRDetailViewModel.JobFilter.failures.rawValue, "Failures")
        XCTAssertEqual(PRDetailViewModel.JobFilter.pending.rawValue, "Pending")
    }

    // MARK: - API Calls

    func testLoadPRCallsPREndpointAndCommitEndpoint() async {
        let sha = "bbb2222222222222222222222222222222222222"
        setPRResponse(makePRResponseJSON())
        setCommitResponse(makeCommitResponseJSON(sha: sha), for: sha)

        await viewModel.loadPR()

        let paths = mockClient.callPaths()
        // Should call PR endpoint then commit endpoint for head SHA
        XCTAssertTrue(paths.contains("/api/pytorch/pytorch/pull/12345"))
        XCTAssertTrue(paths.contains("/api/pytorch/pytorch/commit/\(sha)"))
    }
}
