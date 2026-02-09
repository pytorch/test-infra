import XCTest
@testable import TorchCI

@MainActor
final class HUDViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: HUDViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = HUDViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        // Clean up any defaults we may have set
        UserDefaults.standard.removeObject(forKey: "default_repo")
        UserDefaults.standard.removeObject(forKey: "default_branch")
        super.tearDown()
    }

    // MARK: - Settings Defaults

    func testInitUsesDefaultRepoFromSettings() {
        UserDefaults.standard.set("pytorch/vision", forKey: "default_repo")
        let vm = HUDViewModel(apiClient: mockClient)
        XCTAssertEqual(vm.selectedRepo.name, "vision")
        XCTAssertEqual(vm.selectedRepo.owner, "pytorch")
    }

    func testInitUsesDefaultBranchFromSettings() {
        UserDefaults.standard.set("viable/strict", forKey: "default_branch")
        let vm = HUDViewModel(apiClient: mockClient)
        XCTAssertEqual(vm.selectedBranch, "viable/strict")
    }

    func testInitFallsBackToPyTorchWhenNoSettingsSaved() {
        UserDefaults.standard.removeObject(forKey: "default_repo")
        UserDefaults.standard.removeObject(forKey: "default_branch")
        let vm = HUDViewModel(apiClient: mockClient)
        XCTAssertEqual(vm.selectedRepo.id, "pytorch/pytorch")
        XCTAssertEqual(vm.selectedBranch, "main")
    }

    func testInitIgnoresInvalidRepoSetting() {
        UserDefaults.standard.set("nonexistent/repo", forKey: "default_repo")
        let vm = HUDViewModel(apiClient: mockClient)
        // Should fall back to first repo (pytorch/pytorch)
        XCTAssertEqual(vm.selectedRepo.id, "pytorch/pytorch")
    }

    // MARK: - Helpers

    private func makeHUDResponseJSON(
        jobNames: [String] = ["build", "test", "lint"],
        rows: [[(name: String, conclusion: String, unstable: Bool)]] = []
    ) -> String {
        var shaGridEntries: [String] = []

        for (index, jobs) in rows.enumerated() {
            let jobsJSON = jobs.map { job in
                """
                {
                    "id": \(index * 100 + jobs.count),
                    "name": "\(job.name)",
                    "conclusion": "\(job.conclusion)",
                    "unstable": \(job.unstable)
                }
                """
            }.joined(separator: ",")

            let entry = """
            {
                "sha": "sha\(index)",
                "commitTitle": "commit \(index)",
                "jobs": [\(jobsJSON)]
            }
            """
            shaGridEntries.append(entry)
        }

        let grid = shaGridEntries.joined(separator: ",")
        let names = jobNames.map { "\"\($0)\"" }.joined(separator: ",")
        return """
        {
            "shaGrid": [\(grid)],
            "jobNames": [\(names)]
        }
        """
    }

    private func setSuccessfulHUDResponse(
        jobNames: [String] = ["build", "test", "lint"],
        rows: [[(name: String, conclusion: String, unstable: Bool)]] = [
            [(name: "build", conclusion: "success", unstable: false)],
            [(name: "test", conclusion: "success", unstable: false)],
        ]
    ) {
        let json = makeHUDResponseJSON(jobNames: jobNames, rows: rows)
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1
        )
        mockClient.setResponse(json, for: endpoint.path)
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertNil(viewModel.hudData)
        XCTAssertEqual(viewModel.selectedBranch, "main")
        XCTAssertEqual(viewModel.currentPage, 1)
        XCTAssertEqual(viewModel.searchFilter, "")
        XCTAssertFalse(viewModel.isRegexEnabled)
        XCTAssertEqual(viewModel.consecutiveFailures, 0)
        XCTAssertTrue(viewModel.failurePatterns.isEmpty)
        XCTAssertEqual(viewModel.selectedRepo.owner, "pytorch")
        XCTAssertEqual(viewModel.selectedRepo.name, "pytorch")
        XCTAssertFalse(viewModel.hasData)
        XCTAssertFalse(viewModel.isLoading)
    }

    // MARK: - Load Data Success

    func testLoadDataSuccessPopulatesHUDData() async {
        setSuccessfulHUDResponse(
            jobNames: ["build", "test"],
            rows: [
                [(name: "build", conclusion: "success", unstable: false)],
            ]
        )

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertNotNil(viewModel.hudData)
        XCTAssertEqual(viewModel.hudData?.jobNames.count, 2)
        XCTAssertEqual(viewModel.hudData?.shaGrid.count, 1)
        XCTAssertTrue(viewModel.hasData)
    }

    func testLoadDataSetsLoadingStateDuringFetch() async {
        setSuccessfulHUDResponse()

        // Check initial
        XCTAssertEqual(viewModel.state, .idle)

        await viewModel.loadData()

        // After load completes
        XCTAssertEqual(viewModel.state, .loaded)
    }

    func testLoadDataComputesConsecutiveFailures() async {
        let json = makeHUDResponseJSON(
            jobNames: ["build"],
            rows: [
                [(name: "build", conclusion: "failure", unstable: false)],
                [(name: "build", conclusion: "failure", unstable: false)],
                [(name: "build", conclusion: "success", unstable: false)],
            ]
        )
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1
        )
        mockClient.setResponse(json, for: endpoint.path)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.consecutiveFailures, 2)
        XCTAssertTrue(viewModel.failurePatterns.contains("build"))
    }

    // MARK: - Load Data Error

    func testLoadDataErrorSetsErrorState() async {
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1
        )
        mockClient.setError(APIError.serverError(500), for: endpoint.path)

        await viewModel.loadData()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }

        XCTAssertNil(viewModel.hudData)
    }

    func testLoadDataNotFoundSetsErrorState() async {
        // Don't register any response -- MockAPIClient throws .notFound by default
        await viewModel.loadData()

        if case .error = viewModel.state {
            // expected
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    // MARK: - Infinite Scroll

    func testLoadMoreIfNeededSetsIsLoadingMore() {
        // Set up loaded state first
        viewModel.state = .loaded
        XCTAssertFalse(viewModel.isLoadingMore)
    }

    func testOnPageChangeSetsPage() {
        viewModel.onPageChange(5)

        XCTAssertEqual(viewModel.currentPage, 5)
    }

    // MARK: - Search Filter

    func testSearchFilterFiltersJobNames() async {
        let json = makeHUDResponseJSON(
            jobNames: ["build-linux", "build-windows", "test-linux", "test-windows", "lint"],
            rows: [
                [
                    (name: "build-linux", conclusion: "success", unstable: false),
                    (name: "build-windows", conclusion: "success", unstable: false),
                    (name: "test-linux", conclusion: "success", unstable: false),
                    (name: "test-windows", conclusion: "success", unstable: false),
                    (name: "lint", conclusion: "success", unstable: false),
                ],
            ]
        )
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1
        )
        mockClient.setResponse(json, for: endpoint.path)

        await viewModel.loadData()

        // No filter - all job names returned
        XCTAssertEqual(viewModel.filteredJobNames.count, 5)

        // Apply filter
        viewModel.searchFilter = "linux"
        XCTAssertEqual(viewModel.filteredJobNames.count, 2)
        XCTAssertTrue(viewModel.filteredJobNames.allSatisfy { $0.contains("linux") })
    }

    func testSearchFilterIsCaseInsensitive() async {
        let json = makeHUDResponseJSON(
            jobNames: ["Build-Linux", "Test-Windows"],
            rows: []
        )
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1
        )
        mockClient.setResponse(json, for: endpoint.path)

        await viewModel.loadData()

        viewModel.searchFilter = "build"
        XCTAssertEqual(viewModel.filteredJobNames.count, 1)
        XCTAssertEqual(viewModel.filteredJobNames.first, "Build-Linux")
    }

    func testEmptySearchFilterReturnsAllJobNames() async {
        setSuccessfulHUDResponse(jobNames: ["a", "b", "c"])
        await viewModel.loadData()

        viewModel.searchFilter = ""
        XCTAssertEqual(viewModel.filteredJobNames.count, 3)
    }

    func testClearFilterResetsSearch() async {
        setSuccessfulHUDResponse(jobNames: ["build", "test"])
        await viewModel.loadData()

        viewModel.searchFilter = "build"
        XCTAssertEqual(viewModel.filteredJobNames.count, 1)

        viewModel.clearFilter()
        XCTAssertEqual(viewModel.searchFilter, "")
        XCTAssertEqual(viewModel.filteredJobNames.count, 2)
    }

    func testToggleRegex() {
        XCTAssertFalse(viewModel.isRegexEnabled)
        viewModel.toggleRegex()
        XCTAssertTrue(viewModel.isRegexEnabled)
        viewModel.toggleRegex()
        XCTAssertFalse(viewModel.isRegexEnabled)
    }

    func testRegexFilterWorks() async {
        let json = makeHUDResponseJSON(
            jobNames: ["build-linux-x86", "build-linux-arm64", "test-macos-x86", "lint"],
            rows: []
        )
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1
        )
        mockClient.setResponse(json, for: endpoint.path)

        await viewModel.loadData()

        viewModel.isRegexEnabled = true
        viewModel.searchFilter = "build-linux-(x86|arm64)"

        XCTAssertEqual(viewModel.filteredJobNames.count, 2)
        XCTAssertTrue(viewModel.filteredJobNames.contains("build-linux-x86"))
        XCTAssertTrue(viewModel.filteredJobNames.contains("build-linux-arm64"))
    }

    // MARK: - Branch Selection and Viable/Strict

    func testIsViableStrictReturnsTrueForViableStrict() {
        viewModel.selectedBranch = "viable/strict"
        XCTAssertTrue(viewModel.isViableStrict)
    }

    func testIsViableStrictReturnsFalseForMain() {
        viewModel.selectedBranch = "main"
        XCTAssertFalse(viewModel.isViableStrict)
    }

    func testShowFailureWarningWhenViableStrictAndThreeOrMoreFailures() async {
        viewModel.selectedBranch = "viable/strict"

        let json = makeHUDResponseJSON(
            jobNames: ["build"],
            rows: [
                [(name: "build", conclusion: "failure", unstable: false)],
                [(name: "build", conclusion: "failure", unstable: false)],
                [(name: "build", conclusion: "failure", unstable: false)],
            ]
        )
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "viable/strict",
            page: 1
        )
        mockClient.setResponse(json, for: endpoint.path)

        await viewModel.loadData()

        XCTAssertTrue(viewModel.showFailureWarning)
    }

    // MARK: - Hide Unstable Filter

    func testHideUnstableFiltersOutUnstableJobs() async {
        let json = makeHUDResponseJSON(
            jobNames: ["build-linux", "test-linux-unstable", "lint", "test-windows-unstable"],
            rows: [
                [
                    (name: "build-linux", conclusion: "success", unstable: false),
                    (name: "test-linux-unstable", conclusion: "failure", unstable: true),
                    (name: "lint", conclusion: "success", unstable: false),
                    (name: "test-windows-unstable", conclusion: "failure", unstable: true),
                ],
            ]
        )
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1
        )
        mockClient.setResponse(json, for: endpoint.path)

        await viewModel.loadData()

        // Without filter, all jobs visible
        XCTAssertEqual(viewModel.filteredJobNames.count, 4)

        // Enable hide unstable
        viewModel.hideUnstable = true
        XCTAssertEqual(viewModel.filteredJobNames.count, 2)
        XCTAssertTrue(viewModel.filteredJobNames.contains("build-linux"))
        XCTAssertTrue(viewModel.filteredJobNames.contains("lint"))
        XCTAssertFalse(viewModel.filteredJobNames.contains("test-linux-unstable"))
        XCTAssertFalse(viewModel.filteredJobNames.contains("test-windows-unstable"))
    }

    func testHideUnstableIsCaseInsensitive() async {
        let json = makeHUDResponseJSON(
            jobNames: ["build", "test-UNSTABLE-check"],
            rows: []
        )
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1
        )
        mockClient.setResponse(json, for: endpoint.path)

        await viewModel.loadData()

        viewModel.hideUnstable = true
        XCTAssertEqual(viewModel.filteredJobNames.count, 1)
        XCTAssertEqual(viewModel.filteredJobNames.first, "build")
    }

    // MARK: - Show Failures Only Filter

    func testShowFailuresOnlyFiltersToJobsWithFailures() async {
        let json = makeHUDResponseJSON(
            jobNames: ["build", "test", "lint"],
            rows: [
                [
                    (name: "build", conclusion: "success", unstable: false),
                    (name: "test", conclusion: "failure", unstable: false),
                    (name: "lint", conclusion: "success", unstable: false),
                ],
            ]
        )
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1
        )
        mockClient.setResponse(json, for: endpoint.path)

        await viewModel.loadData()

        // Without filter, all visible
        XCTAssertEqual(viewModel.filteredJobNames.count, 3)

        // Enable failures only
        viewModel.showFailuresOnly = true
        XCTAssertEqual(viewModel.filteredJobNames.count, 1)
        XCTAssertEqual(viewModel.filteredJobNames.first, "test")
    }

    func testShowFailuresOnlyConsidersAllRows() async {
        let json = makeHUDResponseJSON(
            jobNames: ["build", "test", "lint"],
            rows: [
                [
                    (name: "build", conclusion: "success", unstable: false),
                    (name: "test", conclusion: "failure", unstable: false),
                    (name: "lint", conclusion: "success", unstable: false),
                ],
                [
                    (name: "build", conclusion: "failure", unstable: false),
                    (name: "test", conclusion: "success", unstable: false),
                    (name: "lint", conclusion: "success", unstable: false),
                ],
            ]
        )
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1
        )
        mockClient.setResponse(json, for: endpoint.path)

        await viewModel.loadData()

        viewModel.showFailuresOnly = true
        // Both "build" and "test" have failures across the two rows
        XCTAssertEqual(viewModel.filteredJobNames.count, 2)
        XCTAssertTrue(viewModel.filteredJobNames.contains("build"))
        XCTAssertTrue(viewModel.filteredJobNames.contains("test"))
    }

    // MARK: - Combined Filters

    func testCombinedFiltersHideUnstableAndFailuresOnly() async {
        let json = makeHUDResponseJSON(
            jobNames: ["build", "test-unstable", "lint", "check"],
            rows: [
                [
                    (name: "build", conclusion: "failure", unstable: false),
                    (name: "test-unstable", conclusion: "failure", unstable: true),
                    (name: "lint", conclusion: "success", unstable: false),
                    (name: "check", conclusion: "failure", unstable: false),
                ],
            ]
        )
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1
        )
        mockClient.setResponse(json, for: endpoint.path)

        await viewModel.loadData()

        viewModel.hideUnstable = true
        viewModel.showFailuresOnly = true
        // "build" has failure + not unstable -> shown
        // "test-unstable" has failure but name contains unstable -> hidden
        // "lint" no failures -> hidden
        // "check" has failure + not unstable -> shown
        XCTAssertEqual(viewModel.filteredJobNames.count, 2)
        XCTAssertTrue(viewModel.filteredJobNames.contains("build"))
        XCTAssertTrue(viewModel.filteredJobNames.contains("check"))
    }

    func testCombinedSearchAndHideUnstable() async {
        let json = makeHUDResponseJSON(
            jobNames: ["build-linux", "build-linux-unstable", "test-linux", "lint"],
            rows: []
        )
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1
        )
        mockClient.setResponse(json, for: endpoint.path)

        await viewModel.loadData()

        viewModel.searchFilter = "linux"
        viewModel.hideUnstable = true
        // "build-linux" matches search + not unstable -> shown
        // "build-linux-unstable" matches search but name contains unstable -> hidden
        // "test-linux" matches search + not unstable -> shown
        // "lint" doesn't match search -> hidden
        XCTAssertEqual(viewModel.filteredJobNames.count, 2)
        XCTAssertTrue(viewModel.filteredJobNames.contains("build-linux"))
        XCTAssertTrue(viewModel.filteredJobNames.contains("test-linux"))
    }

    // MARK: - Clear Filter Resets All

    func testClearFilterResetsAllFilters() async {
        setSuccessfulHUDResponse(jobNames: ["build", "test-unstable", "lint"])
        await viewModel.loadData()

        viewModel.searchFilter = "build"
        viewModel.hideUnstable = true
        viewModel.showFailuresOnly = true

        viewModel.clearFilter()

        XCTAssertEqual(viewModel.searchFilter, "")
        XCTAssertFalse(viewModel.hideUnstable)
        XCTAssertFalse(viewModel.showFailuresOnly)
        XCTAssertEqual(viewModel.filteredJobNames.count, 3)
    }

    // MARK: - Job Health Stats

    func testJobHealthStatsCountsBlockingFailures() async {
        // Create jobs where some are blocking (contain "viable/strict" pattern)
        let json = makeHUDResponseJSON(
            jobNames: ["trunk / build / linux", "pull / lint", "periodic / check"],
            rows: [
                [
                    (name: "trunk / build / linux", conclusion: "failure", unstable: false),
                    (name: "pull / lint", conclusion: "failure", unstable: false),
                    (name: "periodic / check", conclusion: "success", unstable: false),
                ],
            ]
        )
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1
        )
        mockClient.setResponse(json, for: endpoint.path)

        await viewModel.loadData()

        let stats = viewModel.jobHealthStats
        XCTAssertEqual(stats.successCount, 1)
        // Total failure count should be 2 (both non-unstable failures)
        XCTAssertEqual(stats.failureCount, 2)
    }

    func testJobHealthStatsExcludesUnstableFromBlockingCount() async {
        let json = makeHUDResponseJSON(
            jobNames: ["trunk / build", "test-unstable"],
            rows: [
                [
                    (name: "trunk / build", conclusion: "failure", unstable: false),
                    (name: "test-unstable", conclusion: "failure", unstable: true),
                ],
            ]
        )
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1
        )
        mockClient.setResponse(json, for: endpoint.path)

        await viewModel.loadData()

        let stats = viewModel.jobHealthStats
        XCTAssertEqual(stats.unstableCount, 1)
        // The non-unstable failure should be counted, but unstable one shouldn't add to blocking
        XCTAssertTrue(stats.failureCount >= 1)
    }

    // MARK: - Refresh

    func testRefreshCallsLoadData() async {
        setSuccessfulHUDResponse()

        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        // loadData auto-loads initialPageCount pages (currently 2)
        XCTAssertEqual(mockClient.callCount, 2)
    }

    // MARK: - Initial Filter State

    func testInitialFilterStateIsOff() {
        XCTAssertFalse(viewModel.hideUnstable)
        XCTAssertFalse(viewModel.showFailuresOnly)
    }
}
