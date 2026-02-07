import XCTest
@testable import TorchCI

@MainActor
final class RunnersViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: RunnersViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = RunnersViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        viewModel.stopAutoRefresh()
        viewModel.stopTimer()
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// Build a valid JSON response string for the runners API.
    private func makeRunnersJSON(groups: [(label: String, runners: [(id: Int, name: String, os: String, status: String, busy: Bool, labels: [(id: Int, name: String, type: String)])])]) -> String {
        let groupsJSON = groups.map { group in
            let runnersJSON = group.runners.map { runner in
                let labelsJSON = runner.labels.map { label in
                    """
                    {"id":\(label.id),"name":"\(label.name)","type":"\(label.type)"}
                    """
                }.joined(separator: ",")

                return """
                {"id":\(runner.id),"name":"\(runner.name)","os":"\(runner.os)","status":"\(runner.status)","busy":\(runner.busy),"labels":[\(labelsJSON)]}
                """
            }.joined(separator: ",")

            let runners = group.runners
            let totalCount = runners.count
            let busyCount = runners.filter(\.busy).count
            let offlineCount = runners.filter { $0.status != "online" }.count
            let idleCount = runners.filter { $0.status == "online" && !$0.busy }.count

            return """
            {"label":"\(group.label)","totalCount":\(totalCount),"idleCount":\(idleCount),"busyCount":\(busyCount),"offlineCount":\(offlineCount),"runners":[\(runnersJSON)]}
            """
        }.joined(separator: ",")

        let totalRunners = groups.reduce(0) { $0 + $1.runners.count }
        return """
        {"groups":[\(groupsJSON)],"total_runners":\(totalRunners)}
        """
    }

    /// Convenience: register a runners response for a given org.
    private func setRunnersResponse(
        org: String = "pytorch",
        groups: [(label: String, runners: [(id: Int, name: String, os: String, status: String, busy: Bool, labels: [(id: Int, name: String, type: String)])])]
    ) {
        let json = makeRunnersJSON(groups: groups)
        let endpoint = APIEndpoint.runners(org: org)
        mockClient.setResponse(json, for: endpoint.path)
    }

    /// A default set of runner groups for quick tests.
    private func setDefaultResponse(org: String = "pytorch") {
        setRunnersResponse(org: org, groups: [
            (label: "linux.large", runners: [
                (id: 1, name: "runner-linux-1", os: "Linux", status: "online", busy: false, labels: [(id: 10, name: "linux", type: "custom")]),
                (id: 2, name: "runner-linux-2", os: "Linux", status: "online", busy: true, labels: [(id: 10, name: "linux", type: "custom")]),
                (id: 3, name: "runner-linux-3", os: "Linux", status: "offline", busy: false, labels: [(id: 10, name: "linux", type: "custom")]),
            ]),
            (label: "macos.m1", runners: [
                (id: 4, name: "runner-macos-1", os: "macOS", status: "online", busy: false, labels: [(id: 20, name: "macos", type: "custom")]),
                (id: 5, name: "runner-macos-2", os: "macOS", status: "online", busy: true, labels: [(id: 20, name: "macos", type: "custom")]),
            ]),
        ])
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertNil(viewModel.response)
        XCTAssertEqual(viewModel.selectedOrg, "pytorch")
        XCTAssertEqual(viewModel.searchFilter, "")
        XCTAssertTrue(viewModel.expandedGroups.isEmpty)
        XCTAssertEqual(viewModel.sortOrder, .alphabetical)
        XCTAssertEqual(viewModel.statusFilter, .all)
        XCTAssertEqual(viewModel.totalRunners, 0)
        XCTAssertEqual(viewModel.idleCount, 0)
        XCTAssertEqual(viewModel.busyCount, 0)
        XCTAssertEqual(viewModel.offlineCount, 0)
        XCTAssertTrue(viewModel.filteredGroups.isEmpty)
        XCTAssertFalse(viewModel.isLoading)
    }

    // MARK: - Load Data Success

    func testLoadDataSuccessPopulatesResponse() async {
        setDefaultResponse()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertNotNil(viewModel.response)
        XCTAssertEqual(viewModel.groups.count, 2)
        XCTAssertEqual(viewModel.totalRunners, 5)
    }

    func testLoadDataComputesCounts() async {
        setDefaultResponse()

        await viewModel.loadData()

        // linux.large: 1 idle, 1 busy, 1 offline
        // macos.m1: 1 idle, 1 busy
        XCTAssertEqual(viewModel.idleCount, 2)
        XCTAssertEqual(viewModel.busyCount, 2)
        XCTAssertEqual(viewModel.offlineCount, 1)
        XCTAssertEqual(viewModel.onlineCount, 4)
    }

    func testLoadDataSetsLoadingState() async {
        setDefaultResponse()

        XCTAssertEqual(viewModel.state, .idle)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
    }

    // MARK: - Load Data Error

    func testLoadDataErrorSetsErrorState() async {
        let endpoint = APIEndpoint.runners(org: "pytorch")
        mockClient.setError(APIError.serverError(500), for: endpoint.path)

        await viewModel.loadData()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
        XCTAssertNil(viewModel.response)
    }

    func testLoadDataNotFoundSetsErrorState() async {
        // No registered response => MockAPIClient throws .notFound
        await viewModel.loadData()

        if case .error = viewModel.state {
            // expected
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    // MARK: - Refresh

    func testRefreshReloadsData() async {
        setDefaultResponse()

        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(mockClient.callCount, 1)
    }

    // MARK: - Organization Selection

    func testSelectOrgChangesOrg() {
        XCTAssertEqual(viewModel.selectedOrg, "pytorch")

        // Register response for meta-pytorch
        setDefaultResponse(org: "meta-pytorch")

        viewModel.selectOrg("meta-pytorch")

        XCTAssertEqual(viewModel.selectedOrg, "meta-pytorch")
        XCTAssertNil(viewModel.response)
        XCTAssertTrue(viewModel.expandedGroups.isEmpty)
    }

    func testSelectSameOrgDoesNothing() async {
        setDefaultResponse()
        await viewModel.loadData()

        let callCountBefore = mockClient.callCount

        viewModel.selectOrg("pytorch")

        // Should not have triggered another load
        XCTAssertEqual(mockClient.callCount, callCountBefore)
    }

    func testOrgsListContainsExpected() {
        XCTAssertTrue(RunnersViewModel.orgs.contains("pytorch"))
        XCTAssertTrue(RunnersViewModel.orgs.contains("meta-pytorch"))
    }

    // MARK: - Search Filter

    func testSearchFilterByRunnerName() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.searchFilter = "macos"

        XCTAssertEqual(viewModel.filteredGroups.count, 1)
        XCTAssertEqual(viewModel.filteredGroups.first?.name, "macos.m1")
    }

    func testSearchFilterByGroupName() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.searchFilter = "linux.large"

        // Should match the group name itself, returning all runners in it
        XCTAssertEqual(viewModel.filteredGroups.count, 1)
        XCTAssertEqual(viewModel.filteredGroups.first?.runners.count, 3)
    }

    func testSearchFilterByOS() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.searchFilter = "macOS"

        // Runners with os "macOS" are in macos.m1 group
        XCTAssertEqual(viewModel.filteredGroups.count, 1)
    }

    func testSearchFilterByLabel() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.searchFilter = "linux"

        // "linux" matches label name in linux.large group runners,
        // and also matches the group name "linux.large"
        XCTAssertTrue(viewModel.filteredGroups.contains { $0.name == "linux.large" })
    }

    func testSearchFilterByID() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.searchFilter = "4"

        // Runner with id=4 is runner-macos-1
        let allRunners = viewModel.filteredGroups.flatMap(\.runners)
        XCTAssertTrue(allRunners.contains { $0.id == 4 })
    }

    func testSearchFilterIsCaseInsensitive() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.searchFilter = "LINUX"

        XCTAssertFalse(viewModel.filteredGroups.isEmpty)
    }

    func testEmptySearchFilterReturnsAll() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.searchFilter = ""

        XCTAssertEqual(viewModel.filteredGroups.count, 2)
    }

    func testSearchWithNoResultsReturnsEmpty() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.searchFilter = "nonexistent-runner-xyz"

        XCTAssertTrue(viewModel.filteredGroups.isEmpty)
    }

    // MARK: - Status Filter

    func testStatusFilterIdle() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.statusFilter = .idle

        // Should only contain idle runners
        let allRunners = viewModel.filteredGroups.flatMap(\.runners)
        XCTAssertTrue(allRunners.allSatisfy { $0.isOnline && !$0.isBusy })
        XCTAssertEqual(allRunners.count, 2) // runner-linux-1 and runner-macos-1
    }

    func testStatusFilterBusy() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.statusFilter = .busy

        let allRunners = viewModel.filteredGroups.flatMap(\.runners)
        XCTAssertTrue(allRunners.allSatisfy(\.isBusy))
        XCTAssertEqual(allRunners.count, 2) // runner-linux-2 and runner-macos-2
    }

    func testStatusFilterOffline() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.statusFilter = .offline

        let allRunners = viewModel.filteredGroups.flatMap(\.runners)
        XCTAssertTrue(allRunners.allSatisfy { !$0.isOnline })
        XCTAssertEqual(allRunners.count, 1) // runner-linux-3
    }

    func testStatusFilterAllReturnsEverything() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.statusFilter = .all

        let allRunners = viewModel.filteredGroups.flatMap(\.runners)
        XCTAssertEqual(allRunners.count, 5)
    }

    func testStatusFilterRemovesEmptyGroups() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.statusFilter = .offline

        // Only linux.large has an offline runner
        XCTAssertEqual(viewModel.filteredGroups.count, 1)
        XCTAssertEqual(viewModel.filteredGroups.first?.name, "linux.large")
    }

    func testToggleStatusFilterOnAndOff() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.toggleStatusFilter(.busy)
        XCTAssertEqual(viewModel.statusFilter, .busy)

        viewModel.toggleStatusFilter(.busy)
        XCTAssertEqual(viewModel.statusFilter, .all)
    }

    func testToggleStatusFilterSwitchesFilter() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.toggleStatusFilter(.idle)
        XCTAssertEqual(viewModel.statusFilter, .idle)

        viewModel.toggleStatusFilter(.busy)
        XCTAssertEqual(viewModel.statusFilter, .busy)
    }

    func testCombinedSearchAndStatusFilter() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.searchFilter = "linux"
        viewModel.statusFilter = .idle

        let allRunners = viewModel.filteredGroups.flatMap(\.runners)
        // Only runner-linux-1 is idle and matches "linux"
        XCTAssertEqual(allRunners.count, 1)
        XCTAssertEqual(allRunners.first?.name, "runner-linux-1")
    }

    // MARK: - Count for Filter

    func testCountForFilter() async {
        setDefaultResponse()
        await viewModel.loadData()

        XCTAssertEqual(viewModel.count(for: .all), 5)
        XCTAssertEqual(viewModel.count(for: .idle), 2)
        XCTAssertEqual(viewModel.count(for: .busy), 2)
        XCTAssertEqual(viewModel.count(for: .offline), 1)
    }

    // MARK: - Sort Order

    func testSortAlphabetical() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.sortOrder = .alphabetical

        let names = viewModel.filteredGroups.map(\.name)
        XCTAssertEqual(names, ["linux.large", "macos.m1"])
    }

    func testSortByCount() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.sortOrder = .count

        let names = viewModel.filteredGroups.map(\.name)
        // linux.large has 3 runners, macos.m1 has 2
        XCTAssertEqual(names, ["linux.large", "macos.m1"])
    }

    func testUnknownGroupAlwaysSortsLast() async {
        setRunnersResponse(groups: [
            (label: "unknown", runners: [
                (id: 1, name: "r1", os: "Linux", status: "online", busy: false, labels: []),
            ]),
            (label: "alpha", runners: [
                (id: 2, name: "r2", os: "Linux", status: "online", busy: false, labels: []),
            ]),
            (label: "beta", runners: [
                (id: 3, name: "r3", os: "Linux", status: "online", busy: false, labels: []),
            ]),
        ])
        await viewModel.loadData()

        viewModel.sortOrder = .alphabetical

        let names = viewModel.filteredGroups.map(\.name)
        XCTAssertEqual(names.last, "unknown")
        XCTAssertEqual(names, ["alpha", "beta", "unknown"])
    }

    func testUnknownGroupLastEvenWithSortByCount() async {
        setRunnersResponse(groups: [
            (label: "unknown", runners: [
                (id: 1, name: "r1", os: "Linux", status: "online", busy: false, labels: []),
                (id: 2, name: "r2", os: "Linux", status: "online", busy: false, labels: []),
                (id: 3, name: "r3", os: "Linux", status: "online", busy: false, labels: []),
            ]),
            (label: "small", runners: [
                (id: 4, name: "r4", os: "Linux", status: "online", busy: false, labels: []),
            ]),
        ])
        await viewModel.loadData()

        viewModel.sortOrder = .count

        // "unknown" has more runners but should still sort last
        let names = viewModel.filteredGroups.map(\.name)
        XCTAssertEqual(names.last, "unknown")
    }

    // MARK: - Group Expand/Collapse

    func testToggleGroupExpand() async {
        setDefaultResponse()
        await viewModel.loadData()

        let group = viewModel.filteredGroups[0]

        XCTAssertFalse(viewModel.isGroupExpanded(group))

        viewModel.toggleGroup(group)
        XCTAssertTrue(viewModel.isGroupExpanded(group))

        viewModel.toggleGroup(group)
        XCTAssertFalse(viewModel.isGroupExpanded(group))
    }

    func testExpandAll() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.expandAll()

        for group in viewModel.filteredGroups {
            XCTAssertTrue(viewModel.isGroupExpanded(group))
        }
    }

    func testCollapseAll() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.expandAll()
        viewModel.collapseAll()

        for group in viewModel.filteredGroups {
            // Only auto-expanded if search is active with small group
            XCTAssertFalse(viewModel.expandedGroups.contains(group.id))
        }
    }

    func testAutoExpandDuringSearchForSmallGroups() async {
        setDefaultResponse()
        await viewModel.loadData()

        let group = viewModel.filteredGroups.first { $0.name == "macos.m1" }!
        XCTAssertFalse(viewModel.isGroupExpanded(group))

        viewModel.searchFilter = "macos"

        // Group has 2 runners (<= 10), so should auto-expand during search
        let filteredGroup = viewModel.filteredGroups.first { $0.name == "macos.m1" }!
        XCTAssertTrue(viewModel.isGroupExpanded(filteredGroup))
    }

    func testNoAutoExpandForLargeGroupsDuringSearch() async {
        // Create a group with >10 runners
        var bigRunners: [(id: Int, name: String, os: String, status: String, busy: Bool, labels: [(id: Int, name: String, type: String)])] = []
        for i in 1...15 {
            bigRunners.append((id: i, name: "runner-\(i)", os: "Linux", status: "online", busy: false, labels: []))
        }
        setRunnersResponse(groups: [
            (label: "big-group", runners: bigRunners),
        ])
        await viewModel.loadData()

        viewModel.searchFilter = "runner"

        let group = viewModel.filteredGroups.first!
        XCTAssertEqual(group.runners.count, 15)
        // Not manually expanded, and group has >10 runners, so no auto-expand
        XCTAssertFalse(viewModel.isGroupExpanded(group))
    }

    // MARK: - StatusFilter Enum

    func testStatusFilterLabels() {
        XCTAssertEqual(RunnersViewModel.StatusFilter.all.label, "Total")
        XCTAssertEqual(RunnersViewModel.StatusFilter.idle.label, "Idle")
        XCTAssertEqual(RunnersViewModel.StatusFilter.busy.label, "Busy")
        XCTAssertEqual(RunnersViewModel.StatusFilter.offline.label, "Offline")
    }

    func testStatusFilterAllCases() {
        let allCases = RunnersViewModel.StatusFilter.allCases
        XCTAssertEqual(allCases.count, 4)
        XCTAssertTrue(allCases.contains(.all))
        XCTAssertTrue(allCases.contains(.idle))
        XCTAssertTrue(allCases.contains(.busy))
        XCTAssertTrue(allCases.contains(.offline))
    }

    // MARK: - API Endpoint

    func testCorrectEndpointPathUsed() async {
        setDefaultResponse()
        await viewModel.loadData()

        XCTAssertEqual(mockClient.callPaths(), ["/api/runners/pytorch"])
    }

    func testOrgChangeCallsCorrectEndpoint() async {
        setDefaultResponse(org: "meta-pytorch")

        viewModel.selectOrg("meta-pytorch")

        // Wait for the internal Task to complete
        try? await Task.sleep(nanoseconds: 100_000_000) // 100ms

        XCTAssertTrue(mockClient.callPaths().contains("/api/runners/meta-pytorch"))
    }

    // MARK: - ViewState Equality

    func testViewStateEquality() {
        XCTAssertEqual(RunnersViewModel.ViewState.idle, .idle)
        XCTAssertEqual(RunnersViewModel.ViewState.loading, .loading)
        XCTAssertEqual(RunnersViewModel.ViewState.loaded, .loaded)
        XCTAssertEqual(RunnersViewModel.ViewState.error("a"), .error("a"))
        XCTAssertNotEqual(RunnersViewModel.ViewState.error("a"), .error("b"))
        XCTAssertNotEqual(RunnersViewModel.ViewState.idle, .loading)
        XCTAssertNotEqual(RunnersViewModel.ViewState.loaded, .error("x"))
    }

    // MARK: - Empty Response

    func testEmptyGroupsResponse() async {
        let json = """
        {"groups":[],"total_runners":0}
        """
        let endpoint = APIEndpoint.runners(org: "pytorch")
        mockClient.setResponse(json, for: endpoint.path)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertTrue(viewModel.groups.isEmpty)
        XCTAssertTrue(viewModel.filteredGroups.isEmpty)
        XCTAssertEqual(viewModel.totalRunners, 0)
    }

    // MARK: - Auto Refresh

    func testStartAutoRefreshCreatesTimer() {
        setDefaultResponse()
        viewModel.startAutoRefresh()

        // Calling stop should not crash (timer exists)
        viewModel.stopAutoRefresh()
    }

    func testStopAutoRefreshIsIdempotent() {
        viewModel.stopAutoRefresh()
        viewModel.stopAutoRefresh()
        // No crash
    }

    // MARK: - RunnerGroup Convenience Init

    func testRunnerGroupConvenienceInitComputesCounts() {
        let runners = [
            makeRunner(id: 1, status: "online", busy: false),
            makeRunner(id: 2, status: "online", busy: true),
            makeRunner(id: 3, status: "offline", busy: false),
            makeRunner(id: 4, status: "online", busy: false),
        ]

        let group = RunnerGroup(name: "test-group", runners: runners)

        XCTAssertEqual(group.name, "test-group")
        XCTAssertEqual(group.totalCount, 4)
        XCTAssertEqual(group.idleCount, 2)
        XCTAssertEqual(group.busyCount, 1)
        XCTAssertEqual(group.offlineCount, 1)
        XCTAssertEqual(group.onlineCount, 3)
        XCTAssertEqual(group.id, "test-group")
    }

    // MARK: - Runner Model

    func testRunnerStatusDisplay() {
        let idle = makeRunner(id: 1, status: "online", busy: false)
        XCTAssertEqual(idle.statusDisplay, "Idle")
        XCTAssertEqual(idle.statusColor, "green")

        let busy = makeRunner(id: 2, status: "online", busy: true)
        XCTAssertEqual(busy.statusDisplay, "Busy")
        XCTAssertEqual(busy.statusColor, "orange")

        let offline = makeRunner(id: 3, status: "offline", busy: false)
        XCTAssertEqual(offline.statusDisplay, "Offline")
        XCTAssertEqual(offline.statusColor, "gray")
    }

    func testRunnerIsOnline() {
        let online = makeRunner(id: 1, status: "online", busy: false)
        XCTAssertTrue(online.isOnline)

        let offline = makeRunner(id: 2, status: "offline", busy: false)
        XCTAssertFalse(offline.isOnline)
    }

    func testRunnerIsBusy() {
        let busy = makeRunner(id: 1, status: "online", busy: true)
        XCTAssertTrue(busy.isBusy)

        let notBusy = makeRunner(id: 2, status: "online", busy: false)
        XCTAssertFalse(notBusy.isBusy)
    }

    // MARK: - RunnerLabel Model

    func testRunnerLabelId() {
        let labelWithId = makeRunnerLabel(id: 42, name: "linux")
        XCTAssertEqual(labelWithId.id, "42")

        let labelWithoutId = makeRunnerLabel(id: nil, name: "custom-label")
        XCTAssertEqual(labelWithoutId.id, "custom-label")
    }

    // MARK: - Private Helpers

    /// Decode a Runner from JSON since Runner is Decodable-only (no public memberwise init).
    private func makeRunner(id: Int, name: String = "runner", os: String = "Linux", status: String, busy: Bool) -> Runner {
        let json = """
        {"id":\(id),"name":"\(name)","os":"\(os)","status":"\(status)","busy":\(busy),"labels":[]}
        """
        return try! JSONDecoder().decode(Runner.self, from: json.data(using: .utf8)!)
    }

    private func makeRunnerLabel(id: Int?, name: String, type: String = "custom") -> RunnerLabel {
        let idPart = id.map { "\"id\":\($0)," } ?? ""
        let json = """
        {\(idPart)"name":"\(name)","type":"\(type)"}
        """
        return try! JSONDecoder().decode(RunnerLabel.self, from: json.data(using: .utf8)!)
    }
}
