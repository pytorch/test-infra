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

    // MARK: - Test Data Helpers

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
        {"groups":[\(groupsJSON)],"totalRunners":\(totalRunners)}
        """
    }

    /// Build a runners response JSON with optional nil fields on runners.
    private func makeRunnersJSONWithNilFields(groups: [(label: String, runners: [(id: Int, name: String, os: String?, status: String?, busy: Bool?, labels: String)])]) -> String {
        let groupsJSON = groups.map { group in
            let runnersJSON = group.runners.map { runner in
                let osStr = runner.os.map { "\"\($0)\"" } ?? "null"
                let statusStr = runner.status.map { "\"\($0)\"" } ?? "null"
                let busyStr = runner.busy.map { "\($0)" } ?? "null"

                return """
                {"id":\(runner.id),"name":"\(runner.name)","os":\(osStr),"status":\(statusStr),"busy":\(busyStr),"labels":\(runner.labels)}
                """
            }.joined(separator: ",")

            let totalCount = group.runners.count
            let busyCount = group.runners.filter { $0.busy == true }.count
            let offlineCount = group.runners.filter { $0.status != "online" }.count
            let idleCount = group.runners.filter { $0.status == "online" && $0.busy != true }.count

            return """
            {"label":"\(group.label)","totalCount":\(totalCount),"idleCount":\(idleCount),"busyCount":\(busyCount),"offlineCount":\(offlineCount),"runners":[\(runnersJSON)]}
            """
        }.joined(separator: ",")

        let totalRunners = groups.reduce(0) { $0 + $1.runners.count }
        return """
        {"groups":[\(groupsJSON)],"totalRunners":\(totalRunners)}
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

    /// Convenience: register a raw JSON string for a given org.
    private func setRunnersResponseJSON(_ json: String, org: String = "pytorch") {
        let endpoint = APIEndpoint.runners(org: org)
        mockClient.setResponse(json, for: endpoint.path)
    }

    /// Convenience: register an error for a given org.
    private func setRunnersError(_ error: Error, org: String = "pytorch") {
        let endpoint = APIEndpoint.runners(org: org)
        mockClient.setError(error, for: endpoint.path)
    }

    /// A default set of runner groups for quick tests.
    /// linux.large: 1 idle (id:1), 1 busy (id:2), 1 offline (id:3)
    /// macos.m1:    1 idle (id:4), 1 busy (id:5)
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

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertNil(viewModel.response)
        XCTAssertEqual(viewModel.selectedOrg, "pytorch")
        XCTAssertEqual(viewModel.searchFilter, "")
        XCTAssertTrue(viewModel.expandedGroups.isEmpty)
        XCTAssertEqual(viewModel.sortOrder, .alphabetical)
        XCTAssertEqual(viewModel.statusFilter, .all)
        XCTAssertNil(viewModel.lastRefreshed)
        XCTAssertFalse(viewModel.isLoading)
    }

    func testInitialComputedProperties() {
        XCTAssertTrue(viewModel.groups.isEmpty)
        XCTAssertTrue(viewModel.filteredGroups.isEmpty)
        XCTAssertEqual(viewModel.totalRunners, 0)
        XCTAssertEqual(viewModel.onlineCount, 0)
        XCTAssertEqual(viewModel.idleCount, 0)
        XCTAssertEqual(viewModel.busyCount, 0)
        XCTAssertEqual(viewModel.offlineCount, 0)
    }

    func testInitialCountForAllFilters() {
        XCTAssertEqual(viewModel.count(for: .all), 0)
        XCTAssertEqual(viewModel.count(for: .idle), 0)
        XCTAssertEqual(viewModel.count(for: .busy), 0)
        XCTAssertEqual(viewModel.count(for: .offline), 0)
    }

    // MARK: - Static Configuration

    func testOrgsListContainsExpected() {
        XCTAssertTrue(RunnersViewModel.orgs.contains("pytorch"))
        XCTAssertTrue(RunnersViewModel.orgs.contains("meta-pytorch"))
        XCTAssertEqual(RunnersViewModel.orgs.count, 2)
    }

    // MARK: - ViewState Equatable

    func testViewStateEquality() {
        XCTAssertEqual(RunnersViewModel.ViewState.idle, .idle)
        XCTAssertEqual(RunnersViewModel.ViewState.loading, .loading)
        XCTAssertEqual(RunnersViewModel.ViewState.loaded, .loaded)
        XCTAssertEqual(RunnersViewModel.ViewState.error("a"), .error("a"))
        XCTAssertNotEqual(RunnersViewModel.ViewState.error("a"), .error("b"))
        XCTAssertNotEqual(RunnersViewModel.ViewState.idle, .loading)
        XCTAssertNotEqual(RunnersViewModel.ViewState.loading, .loaded)
        XCTAssertNotEqual(RunnersViewModel.ViewState.loaded, .error("x"))
        XCTAssertNotEqual(RunnersViewModel.ViewState.idle, .loaded)
        XCTAssertNotEqual(RunnersViewModel.ViewState.idle, .error("z"))
    }

    func testIsLoadingReflectsState() {
        viewModel.state = .loading
        XCTAssertTrue(viewModel.isLoading)

        viewModel.state = .loaded
        XCTAssertFalse(viewModel.isLoading)

        viewModel.state = .idle
        XCTAssertFalse(viewModel.isLoading)

        viewModel.state = .error("oops")
        XCTAssertFalse(viewModel.isLoading)
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

    func testStatusFilterRawValues() {
        XCTAssertEqual(RunnersViewModel.StatusFilter.all.rawValue, "all")
        XCTAssertEqual(RunnersViewModel.StatusFilter.idle.rawValue, "idle")
        XCTAssertEqual(RunnersViewModel.StatusFilter.busy.rawValue, "busy")
        XCTAssertEqual(RunnersViewModel.StatusFilter.offline.rawValue, "offline")
    }

    // MARK: - Load Data (Success)

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

    func testLoadDataSetsLoadingStateTransition() async {
        setDefaultResponse()

        XCTAssertEqual(viewModel.state, .idle)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
    }

    func testLoadDataSetsLastRefreshed() async {
        setDefaultResponse()
        let before = Date()

        await viewModel.loadData()

        let after = Date()
        XCTAssertNotNil(viewModel.lastRefreshed)
        XCTAssertGreaterThanOrEqual(viewModel.lastRefreshed!, before)
        XCTAssertLessThanOrEqual(viewModel.lastRefreshed!, after)
    }

    func testLoadDataRecordsAPICall() async {
        setDefaultResponse()

        await viewModel.loadData()

        XCTAssertEqual(mockClient.callCount, 1)
        XCTAssertEqual(mockClient.callPaths(), ["/api/runners/pytorch"])
    }

    func testLoadDataParsesRunnerFields() async {
        setRunnersResponse(groups: [
            (label: "test-group", runners: [
                (id: 42, name: "my-runner", os: "Linux", status: "online", busy: true, labels: [(id: 99, name: "self-hosted", type: "read-only")]),
            ]),
        ])
        await viewModel.loadData()

        let runner = viewModel.groups[0].runners[0]
        XCTAssertEqual(runner.id, 42)
        XCTAssertEqual(runner.name, "my-runner")
        XCTAssertEqual(runner.os, "Linux")
        XCTAssertTrue(runner.isOnline)
        XCTAssertTrue(runner.isBusy)
        XCTAssertEqual(runner.labels?.count, 1)
        XCTAssertEqual(runner.labels?[0].name, "self-hosted")
    }

    func testLoadDataParsesGroupCounts() async {
        setDefaultResponse()
        await viewModel.loadData()

        let linuxGroup = viewModel.groups.first { $0.name == "linux.large" }!
        XCTAssertEqual(linuxGroup.totalCount, 3)
        XCTAssertEqual(linuxGroup.idleCount, 1)
        XCTAssertEqual(linuxGroup.busyCount, 1)
        XCTAssertEqual(linuxGroup.offlineCount, 1)
        XCTAssertEqual(linuxGroup.onlineCount, 2)
    }

    func testTotalRunnersUsesResponseFieldWhenPresent() async {
        // totalRunners in response is 100, but group only has 1 runner
        let json = """
        {"groups":[{"label":"g","totalCount":1,"idleCount":1,"busyCount":0,"offlineCount":0,"runners":[{"id":1,"name":"r1","os":"Linux","status":"online","busy":false}]}],"totalRunners":100}
        """
        setRunnersResponseJSON(json)
        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalRunners, 100)
    }

    func testTotalRunnersFallsBackToGroupSum() async {
        let json = """
        {"groups":[{"label":"g","totalCount":2,"idleCount":2,"busyCount":0,"offlineCount":0,"runners":[{"id":1,"name":"r1","os":"Linux","status":"online","busy":false},{"id":2,"name":"r2","os":"Linux","status":"online","busy":false}]}],"totalRunners":null}
        """
        setRunnersResponseJSON(json)
        await viewModel.loadData()

        XCTAssertEqual(viewModel.totalRunners, 2)
    }

    // MARK: - Load Data (Error)

    func testLoadDataErrorSetsErrorState() async {
        setRunnersError(APIError.serverError(500))

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

    func testLoadDataNetworkError() async {
        setRunnersError(APIError.networkError(URLError(.notConnectedToInternet)))

        await viewModel.loadData()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
        XCTAssertNil(viewModel.response)
    }

    func testLoadDataErrorDoesNotSetLastRefreshed() async {
        setRunnersError(APIError.serverError(500))

        await viewModel.loadData()

        XCTAssertNil(viewModel.lastRefreshed)
    }

    func testRetryAfterError() async {
        // First: error
        setRunnersError(APIError.serverError(500))
        await viewModel.loadData()

        if case .error = viewModel.state {
            // expected
        } else {
            XCTFail("Expected error state")
        }

        // Second: success after clearing error
        mockClient.errors.removeValue(forKey: "/api/runners/pytorch")
        setDefaultResponse()
        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.groups.count, 2)
        XCTAssertEqual(mockClient.callCount, 2)
    }

    // MARK: - Refresh

    func testRefreshReloadsData() async {
        setDefaultResponse()

        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(mockClient.callCount, 1)
    }

    func testRefreshUpdatesLastRefreshed() async {
        setDefaultResponse()

        await viewModel.loadData()
        let firstRefresh = viewModel.lastRefreshed

        try? await Task.sleep(nanoseconds: 10_000_000) // 10ms

        await viewModel.refresh()
        let secondRefresh = viewModel.lastRefreshed

        XCTAssertNotNil(firstRefresh)
        XCTAssertNotNil(secondRefresh)
        XCTAssertGreaterThanOrEqual(secondRefresh!, firstRefresh!)
    }

    func testRefreshReplacesOldData() async {
        // First load
        setRunnersResponse(groups: [
            (label: "first-group", runners: [
                (id: 1, name: "r1", os: "Linux", status: "online", busy: false, labels: []),
            ]),
        ])
        await viewModel.loadData()
        XCTAssertEqual(viewModel.groups.count, 1)
        XCTAssertEqual(viewModel.groups[0].name, "first-group")

        // Replace with different data
        setRunnersResponse(groups: [
            (label: "second-group", runners: [
                (id: 2, name: "r2", os: "macOS", status: "online", busy: true, labels: []),
                (id: 3, name: "r3", os: "macOS", status: "offline", busy: false, labels: []),
            ]),
        ])
        await viewModel.refresh()

        XCTAssertEqual(viewModel.groups.count, 1)
        XCTAssertEqual(viewModel.groups[0].name, "second-group")
        XCTAssertEqual(viewModel.groups[0].runners.count, 2)
        XCTAssertEqual(mockClient.callCount, 2)
    }

    // MARK: - Organization Selection

    func testSelectOrgChangesOrg() {
        setDefaultResponse(org: "meta-pytorch")

        viewModel.selectOrg("meta-pytorch")

        XCTAssertEqual(viewModel.selectedOrg, "meta-pytorch")
    }

    func testSelectOrgClearsResponse() async {
        setDefaultResponse()
        await viewModel.loadData()
        XCTAssertNotNil(viewModel.response)

        setDefaultResponse(org: "meta-pytorch")
        viewModel.selectOrg("meta-pytorch")

        XCTAssertNil(viewModel.response)
    }

    func testSelectOrgClearsExpandedGroups() async {
        setDefaultResponse()
        await viewModel.loadData()
        viewModel.expandAll()
        XCTAssertFalse(viewModel.expandedGroups.isEmpty)

        setDefaultResponse(org: "meta-pytorch")
        viewModel.selectOrg("meta-pytorch")

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

    func testSelectOrgTriggersLoadForNewOrg() async {
        setDefaultResponse(org: "meta-pytorch")

        viewModel.selectOrg("meta-pytorch")

        // Wait for the internal Task to complete
        try? await Task.sleep(nanoseconds: 100_000_000) // 100ms

        XCTAssertTrue(mockClient.callPaths().contains("/api/runners/meta-pytorch"))
    }

    func testSelectOrgPreservesSearchFilter() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.searchFilter = "some-query"

        setDefaultResponse(org: "meta-pytorch")
        viewModel.selectOrg("meta-pytorch")

        // searchFilter is not reset by selectOrg
        XCTAssertEqual(viewModel.searchFilter, "some-query")
    }

    // MARK: - Search Filtering

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
        XCTAssertEqual(viewModel.filteredGroups[0].name, "macos.m1")
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

    func testSearchGroupNameMatchShowsAllRunners() async {
        // When search matches the group name but not individual runners,
        // all runners in that group should be shown
        setRunnersResponse(groups: [
            (label: "special-fleet", runners: [
                (id: 1, name: "abc-runner", os: "Linux", status: "online", busy: false, labels: []),
                (id: 2, name: "xyz-runner", os: "Linux", status: "online", busy: true, labels: []),
            ]),
        ])
        await viewModel.loadData()

        viewModel.searchFilter = "special-fleet"

        XCTAssertEqual(viewModel.filteredGroups.count, 1)
        XCTAssertEqual(viewModel.filteredGroups[0].runners.count, 2)
    }

    func testSearchMatchingRunnerButNotGroupNameShowsOnlyMatchingRunners() async {
        setRunnersResponse(groups: [
            (label: "all-workers", runners: [
                (id: 1, name: "linux-worker-1", os: "Linux", status: "online", busy: false, labels: []),
                (id: 2, name: "macos-worker-1", os: "macOS", status: "online", busy: true, labels: []),
            ]),
        ])
        await viewModel.loadData()

        viewModel.searchFilter = "linux-worker"

        XCTAssertEqual(viewModel.filteredGroups.count, 1)
        XCTAssertEqual(viewModel.filteredGroups[0].runners.count, 1)
        XCTAssertEqual(viewModel.filteredGroups[0].runners[0].name, "linux-worker-1")
    }

    func testSearchByPartialRunnerName() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.searchFilter = "runner-linux"

        let allRunners = viewModel.filteredGroups.flatMap(\.runners)
        XCTAssertEqual(allRunners.count, 3) // All linux runners match
    }

    // MARK: - Status Filtering

    func testStatusFilterIdle() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.statusFilter = .idle

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

    func testStatusFilterIdleRemovesGroupWithOnlyBusyAndOffline() async {
        setRunnersResponse(groups: [
            (label: "busy-only", runners: [
                (id: 1, name: "r1", os: "Linux", status: "online", busy: true, labels: []),
            ]),
            (label: "mixed", runners: [
                (id: 2, name: "r2", os: "Linux", status: "online", busy: false, labels: []),
                (id: 3, name: "r3", os: "Linux", status: "online", busy: true, labels: []),
            ]),
        ])
        await viewModel.loadData()

        viewModel.statusFilter = .idle

        // busy-only group should be removed; mixed should have 1 runner
        XCTAssertEqual(viewModel.filteredGroups.count, 1)
        XCTAssertEqual(viewModel.filteredGroups[0].name, "mixed")
        XCTAssertEqual(viewModel.filteredGroups[0].runners.count, 1)
    }

    // MARK: - Combined Search + Status Filtering

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

    func testCombinedSearchAndStatusFilterNoResults() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.searchFilter = "macos"
        viewModel.statusFilter = .offline

        // No macos runners are offline
        XCTAssertTrue(viewModel.filteredGroups.isEmpty)
    }

    func testCombinedSearchAndBusyFilter() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.searchFilter = "runner-linux"
        viewModel.statusFilter = .busy

        let allRunners = viewModel.filteredGroups.flatMap(\.runners)
        XCTAssertEqual(allRunners.count, 1)
        XCTAssertEqual(allRunners.first?.name, "runner-linux-2")
    }

    func testCombinedSearchByIDAndStatusFilter() async {
        setDefaultResponse()
        await viewModel.loadData()

        // Runner ID 2 is runner-linux-2 (busy)
        viewModel.searchFilter = "2"
        viewModel.statusFilter = .idle

        // Runner 2 is busy, not idle, so no results
        let allRunners = viewModel.filteredGroups.flatMap(\.runners)
        // ID "2" also matches runner-linux-2 and runner-macos-2
        // After idle filter: runner-linux-2 is busy, runner-macos-2 is busy => empty
        XCTAssertTrue(allRunners.allSatisfy { $0.isOnline && !$0.isBusy })
    }

    // MARK: - Toggle Status Filter

    func testToggleStatusFilterOnAndOff() {
        viewModel.toggleStatusFilter(.busy)
        XCTAssertEqual(viewModel.statusFilter, .busy)

        viewModel.toggleStatusFilter(.busy)
        XCTAssertEqual(viewModel.statusFilter, .all)
    }

    func testToggleStatusFilterSwitchesFilter() {
        viewModel.toggleStatusFilter(.idle)
        XCTAssertEqual(viewModel.statusFilter, .idle)

        viewModel.toggleStatusFilter(.busy)
        XCTAssertEqual(viewModel.statusFilter, .busy)
    }

    func testToggleStatusFilterAllIsNoop() {
        // Toggling .all when already .all remains .all
        viewModel.statusFilter = .all
        viewModel.toggleStatusFilter(.all)
        XCTAssertEqual(viewModel.statusFilter, .all)
    }

    func testToggleStatusFilterFromAllToSpecific() {
        viewModel.statusFilter = .all
        viewModel.toggleStatusFilter(.offline)
        XCTAssertEqual(viewModel.statusFilter, .offline)
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

    func testCountForFilterWithSingleGroupAllOffline() async {
        setRunnersResponse(groups: [
            (label: "offline-fleet", runners: [
                (id: 1, name: "r1", os: "Linux", status: "offline", busy: false, labels: []),
                (id: 2, name: "r2", os: "Linux", status: "offline", busy: false, labels: []),
            ]),
        ])
        await viewModel.loadData()

        XCTAssertEqual(viewModel.count(for: .all), 2)
        XCTAssertEqual(viewModel.count(for: .idle), 0)
        XCTAssertEqual(viewModel.count(for: .busy), 0)
        XCTAssertEqual(viewModel.count(for: .offline), 2)
    }

    func testCountForFilterWithSingleGroupAllBusy() async {
        setRunnersResponse(groups: [
            (label: "busy-fleet", runners: [
                (id: 1, name: "r1", os: "Linux", status: "online", busy: true, labels: []),
                (id: 2, name: "r2", os: "Linux", status: "online", busy: true, labels: []),
                (id: 3, name: "r3", os: "Linux", status: "online", busy: true, labels: []),
            ]),
        ])
        await viewModel.loadData()

        XCTAssertEqual(viewModel.count(for: .all), 3)
        XCTAssertEqual(viewModel.count(for: .idle), 0)
        XCTAssertEqual(viewModel.count(for: .busy), 3)
        XCTAssertEqual(viewModel.count(for: .offline), 0)
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

    func testSortByCountWithDifferentSizes() async {
        setRunnersResponse(groups: [
            (label: "small", runners: [
                (id: 1, name: "r1", os: "Linux", status: "online", busy: false, labels: []),
            ]),
            (label: "large", runners: [
                (id: 2, name: "r2", os: "Linux", status: "online", busy: false, labels: []),
                (id: 3, name: "r3", os: "Linux", status: "online", busy: false, labels: []),
                (id: 4, name: "r4", os: "Linux", status: "online", busy: false, labels: []),
            ]),
            (label: "medium", runners: [
                (id: 5, name: "r5", os: "Linux", status: "online", busy: false, labels: []),
                (id: 6, name: "r6", os: "Linux", status: "online", busy: false, labels: []),
            ]),
        ])
        await viewModel.loadData()

        viewModel.sortOrder = .count

        let names = viewModel.filteredGroups.map(\.name)
        XCTAssertEqual(names, ["large", "medium", "small"])
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

        XCTAssertTrue(viewModel.expandedGroups.isEmpty)
        for group in viewModel.filteredGroups {
            XCTAssertFalse(viewModel.expandedGroups.contains(group.id))
        }
    }

    func testExpandAllOnlyExpandsFilteredGroups() async {
        setDefaultResponse()
        await viewModel.loadData()

        // Filter to only show one group
        viewModel.statusFilter = .offline
        // Only linux.large has offline runners
        XCTAssertEqual(viewModel.filteredGroups.count, 1)

        viewModel.expandAll()

        XCTAssertTrue(viewModel.expandedGroups.contains("linux.large"))
        XCTAssertFalse(viewModel.expandedGroups.contains("macos.m1"))
    }

    func testToggleGroupIndependentOfOtherGroups() async {
        setDefaultResponse()
        await viewModel.loadData()

        let group0 = viewModel.filteredGroups[0]
        let group1 = viewModel.filteredGroups[1]

        viewModel.toggleGroup(group0)
        XCTAssertTrue(viewModel.isGroupExpanded(group0))
        XCTAssertFalse(viewModel.isGroupExpanded(group1))

        viewModel.toggleGroup(group1)
        XCTAssertTrue(viewModel.isGroupExpanded(group0))
        XCTAssertTrue(viewModel.isGroupExpanded(group1))

        viewModel.toggleGroup(group0)
        XCTAssertFalse(viewModel.isGroupExpanded(group0))
        XCTAssertTrue(viewModel.isGroupExpanded(group1))
    }

    // MARK: - Auto-Expand Behavior

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

    func testAutoExpandExactly10Runners() async {
        var tenRunners: [(id: Int, name: String, os: String, status: String, busy: Bool, labels: [(id: Int, name: String, type: String)])] = []
        for i in 1...10 {
            tenRunners.append((id: i, name: "runner-\(i)", os: "Linux", status: "online", busy: false, labels: []))
        }
        setRunnersResponse(groups: [
            (label: "exact-10", runners: tenRunners),
        ])
        await viewModel.loadData()

        viewModel.searchFilter = "runner"

        let group = viewModel.filteredGroups.first!
        XCTAssertEqual(group.runners.count, 10)
        XCTAssertTrue(viewModel.isGroupExpanded(group))
    }

    func testAutoExpandExactly11RunnersDoesNotExpand() async {
        var elevenRunners: [(id: Int, name: String, os: String, status: String, busy: Bool, labels: [(id: Int, name: String, type: String)])] = []
        for i in 1...11 {
            elevenRunners.append((id: i, name: "runner-\(i)", os: "Linux", status: "online", busy: false, labels: []))
        }
        setRunnersResponse(groups: [
            (label: "exact-11", runners: elevenRunners),
        ])
        await viewModel.loadData()

        viewModel.searchFilter = "runner"

        let group = viewModel.filteredGroups.first!
        XCTAssertEqual(group.runners.count, 11)
        XCTAssertFalse(viewModel.isGroupExpanded(group))
    }

    func testAutoExpandDoesNotApplyWithoutSearch() async {
        setDefaultResponse()
        await viewModel.loadData()

        // No search filter - should not auto-expand even with few runners
        viewModel.searchFilter = ""
        for group in viewModel.filteredGroups {
            XCTAssertFalse(viewModel.isGroupExpanded(group))
        }
    }

    func testAutoExpandUsesFiltededRunnerCount() async {
        // 15 runners total, but search narrows to 3 which is <= 10
        var allRunners: [(id: Int, name: String, os: String, status: String, busy: Bool, labels: [(id: Int, name: String, type: String)])] = []
        for i in 1...12 {
            allRunners.append((id: i, name: "worker-\(i)", os: "Linux", status: "online", busy: false, labels: []))
        }
        for i in 13...15 {
            allRunners.append((id: i, name: "special-\(i)", os: "Linux", status: "online", busy: false, labels: []))
        }
        setRunnersResponse(groups: [
            (label: "mixed-group", runners: allRunners),
        ])
        await viewModel.loadData()

        viewModel.searchFilter = "special"

        XCTAssertEqual(viewModel.filteredGroups.count, 1)
        XCTAssertEqual(viewModel.filteredGroups[0].runners.count, 3)
        XCTAssertTrue(viewModel.isGroupExpanded(viewModel.filteredGroups[0]))
    }

    func testManuallyExpandedGroupStaysExpandedWithoutSearch() async {
        setDefaultResponse()
        await viewModel.loadData()

        let group = viewModel.filteredGroups[0]
        viewModel.toggleGroup(group)
        XCTAssertTrue(viewModel.isGroupExpanded(group))

        // Clear search - manually expanded state should persist
        viewModel.searchFilter = ""
        XCTAssertTrue(viewModel.isGroupExpanded(group))
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

    // MARK: - Empty Response

    func testEmptyGroupsResponse() async {
        let json = """
        {"groups":[],"totalRunners":0}
        """
        setRunnersResponseJSON(json)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertTrue(viewModel.groups.isEmpty)
        XCTAssertTrue(viewModel.filteredGroups.isEmpty)
        XCTAssertEqual(viewModel.totalRunners, 0)
        XCTAssertEqual(viewModel.idleCount, 0)
        XCTAssertEqual(viewModel.busyCount, 0)
        XCTAssertEqual(viewModel.offlineCount, 0)
        XCTAssertEqual(viewModel.onlineCount, 0)
    }

    func testGroupWithNoRunners() async {
        let json = """
        {"groups":[{"label":"empty-group","totalCount":0,"idleCount":0,"busyCount":0,"offlineCount":0,"runners":[]}],"totalRunners":0}
        """
        setRunnersResponseJSON(json)
        await viewModel.loadData()

        XCTAssertEqual(viewModel.groups.count, 1)
        XCTAssertEqual(viewModel.groups[0].name, "empty-group")
        XCTAssertEqual(viewModel.groups[0].runners.count, 0)
    }

    // MARK: - Edge Cases: Nil Fields

    func testRunnerWithNilOSAndStatus() async {
        let json = makeRunnersJSONWithNilFields(groups: [
            (label: "minimal-group", runners: [
                (id: 1, name: "minimal-runner", os: nil, status: nil, busy: nil, labels: "null"),
            ]),
        ])
        setRunnersResponseJSON(json)
        await viewModel.loadData()

        let runner = viewModel.groups[0].runners[0]
        XCTAssertEqual(runner.id, 1)
        XCTAssertEqual(runner.name, "minimal-runner")
        XCTAssertNil(runner.os)
        XCTAssertNil(runner.status)
        XCTAssertNil(runner.busy)
        XCTAssertNil(runner.labels)
        XCTAssertFalse(runner.isOnline)
        XCTAssertFalse(runner.isBusy)
        XCTAssertEqual(runner.statusDisplay, "Offline")
        XCTAssertEqual(runner.statusColor, "gray")
    }

    func testSearchDoesNotCrashWithNilOS() async {
        let json = makeRunnersJSONWithNilFields(groups: [
            (label: "grp", runners: [
                (id: 1, name: "runner-1", os: nil, status: "online", busy: false, labels: "null"),
            ]),
        ])
        setRunnersResponseJSON(json)
        await viewModel.loadData()

        viewModel.searchFilter = "linux"

        // Should not crash and should return no results
        XCTAssertTrue(viewModel.filteredGroups.isEmpty)
    }

    func testSearchDoesNotCrashWithNilLabels() async {
        let json = makeRunnersJSONWithNilFields(groups: [
            (label: "grp", runners: [
                (id: 1, name: "runner-1", os: "Linux", status: "online", busy: false, labels: "null"),
            ]),
        ])
        setRunnersResponseJSON(json)
        await viewModel.loadData()

        viewModel.searchFilter = "self-hosted"

        // Should not crash; name/os don't match
        XCTAssertTrue(viewModel.filteredGroups.isEmpty)
    }

    func testStatusFilterWithNilStatusRunners() async {
        let json = makeRunnersJSONWithNilFields(groups: [
            (label: "grp", runners: [
                (id: 1, name: "normal", os: "Linux", status: "online", busy: false, labels: "[]"),
                (id: 2, name: "nil-status", os: nil, status: nil, busy: nil, labels: "null"),
            ]),
        ])
        setRunnersResponseJSON(json)
        await viewModel.loadData()

        // nil status means not online -> offline
        viewModel.statusFilter = .offline
        let runners = viewModel.filteredGroups.flatMap(\.runners)
        XCTAssertEqual(runners.count, 1)
        XCTAssertEqual(runners[0].name, "nil-status")

        viewModel.statusFilter = .idle
        let idleRunners = viewModel.filteredGroups.flatMap(\.runners)
        XCTAssertEqual(idleRunners.count, 1)
        XCTAssertEqual(idleRunners[0].name, "normal")
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

    func testStopTimerIsIdempotent() {
        viewModel.stopTimer()
        viewModel.stopTimer()
        // No crash
    }

    func testStartAutoRefreshRestartsTimer() {
        viewModel.startAutoRefresh()
        viewModel.startAutoRefresh() // Should stop old timer and create new one
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

    func testRunnerGroupConvenienceInitEmpty() {
        let group = RunnerGroup(name: "empty", runners: [])

        XCTAssertEqual(group.totalCount, 0)
        XCTAssertEqual(group.idleCount, 0)
        XCTAssertEqual(group.busyCount, 0)
        XCTAssertEqual(group.offlineCount, 0)
        XCTAssertEqual(group.onlineCount, 0)
    }

    func testRunnerGroupConvenienceInitAllSameStatus() {
        let runners = [
            makeRunner(id: 1, status: "online", busy: true),
            makeRunner(id: 2, status: "online", busy: true),
            makeRunner(id: 3, status: "online", busy: true),
        ]

        let group = RunnerGroup(name: "all-busy", runners: runners)

        XCTAssertEqual(group.totalCount, 3)
        XCTAssertEqual(group.idleCount, 0)
        XCTAssertEqual(group.busyCount, 3)
        XCTAssertEqual(group.offlineCount, 0)
        XCTAssertEqual(group.onlineCount, 3)
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

    func testRunnerOfflineAndBusy() {
        // Edge case: a runner that is offline but marked busy
        let runner = makeRunner(id: 1, status: "offline", busy: true)
        XCTAssertFalse(runner.isOnline)
        XCTAssertTrue(runner.isBusy)
        // statusDisplay checks isOnline first
        XCTAssertEqual(runner.statusDisplay, "Offline")
        XCTAssertEqual(runner.statusColor, "gray")
    }

    // MARK: - RunnerLabel Model

    func testRunnerLabelIdWithLabelId() {
        let label = makeRunnerLabel(id: 42, name: "linux")
        XCTAssertEqual(label.id, "42")
    }

    func testRunnerLabelIdFallsBackToName() {
        let label = makeRunnerLabel(id: nil, name: "custom-label")
        XCTAssertEqual(label.id, "custom-label")
    }

    // MARK: - Multiple Loads Replace Data

    func testMultipleLoadsReplaceData() async {
        // First load
        setRunnersResponse(groups: [
            (label: "first-group", runners: [
                (id: 1, name: "r1", os: "Linux", status: "online", busy: false, labels: []),
            ]),
        ])
        await viewModel.loadData()
        XCTAssertEqual(viewModel.groups[0].name, "first-group")

        // Second load with different data
        setRunnersResponse(groups: [
            (label: "second-group", runners: [
                (id: 2, name: "r2", os: "macOS", status: "online", busy: true, labels: []),
                (id: 3, name: "r3", os: "macOS", status: "offline", busy: false, labels: []),
            ]),
        ])
        await viewModel.loadData()

        XCTAssertEqual(viewModel.groups.count, 1)
        XCTAssertEqual(viewModel.groups[0].name, "second-group")
        XCTAssertEqual(viewModel.groups[0].runners.count, 2)
        XCTAssertEqual(mockClient.callCount, 2)
    }

    // MARK: - Filtering After Status Filter Recomputes Group Counts

    func testFilteredGroupCountsAreRecomputed() async {
        setDefaultResponse()
        await viewModel.loadData()

        viewModel.statusFilter = .idle

        // After filtering, the filtered groups are rebuilt with RunnerGroup(name:runners:)
        // So their counts should reflect only the filtered runners
        for group in viewModel.filteredGroups {
            for runner in group.runners {
                XCTAssertTrue(runner.isOnline && !runner.isBusy,
                    "Runner \(runner.name) should be idle in filtered group \(group.name)")
            }
        }
    }

    // MARK: - Large Dataset

    func testLargeNumberOfGroups() async {
        var groups: [(label: String, runners: [(id: Int, name: String, os: String, status: String, busy: Bool, labels: [(id: Int, name: String, type: String)])])] = []
        for i in 0..<50 {
            groups.append((
                label: "group-\(String(format: "%03d", i))",
                runners: [
                    (id: i, name: "runner-\(i)", os: "Linux", status: i % 3 == 0 ? "offline" : "online", busy: i % 2 == 0 && i % 3 != 0, labels: []),
                ]
            ))
        }
        setRunnersResponse(groups: groups)
        await viewModel.loadData()

        XCTAssertEqual(viewModel.groups.count, 50)
        XCTAssertEqual(viewModel.filteredGroups.count, 50)

        // Verify status filter
        viewModel.statusFilter = .offline
        let offlineGroups = viewModel.filteredGroups
        // Every 3rd runner (i % 3 == 0) is offline: 0, 3, 6, ... 48 -> 17 runners
        XCTAssertEqual(offlineGroups.count, 17)
    }

    func testLargeNumberOfRunnersPerGroup() async {
        var runners: [(id: Int, name: String, os: String, status: String, busy: Bool, labels: [(id: Int, name: String, type: String)])] = []
        for i in 1...100 {
            runners.append((id: i, name: "runner-\(i)", os: "Linux", status: "online", busy: i % 2 == 0, labels: []))
        }
        setRunnersResponse(groups: [
            (label: "mega-group", runners: runners),
        ])
        await viewModel.loadData()

        XCTAssertEqual(viewModel.groups[0].runners.count, 100)
        XCTAssertEqual(viewModel.count(for: .all), 100)
        XCTAssertEqual(viewModel.count(for: .busy), 50)
        XCTAssertEqual(viewModel.count(for: .idle), 50)

        // Search should filter correctly
        viewModel.searchFilter = "runner-1"
        // Matches: runner-1, runner-10..19, runner-100 = 12 runners
        let matchedRunners = viewModel.filteredGroups.flatMap(\.runners)
        XCTAssertEqual(matchedRunners.count, 12)
    }

    // MARK: - Expanded Groups Persist Through Filter Changes

    func testExpandedGroupsPersistThroughSearchFilterChange() async {
        setDefaultResponse()
        await viewModel.loadData()

        let linuxGroup = viewModel.filteredGroups.first { $0.name == "linux.large" }!
        viewModel.toggleGroup(linuxGroup)
        XCTAssertTrue(viewModel.expandedGroups.contains("linux.large"))

        // Apply search that still includes linux.large
        viewModel.searchFilter = "linux"
        XCTAssertTrue(viewModel.expandedGroups.contains("linux.large"))

        // Clear search
        viewModel.searchFilter = ""
        XCTAssertTrue(viewModel.expandedGroups.contains("linux.large"))
    }

    func testExpandedGroupsPersistThroughStatusFilterChange() async {
        setDefaultResponse()
        await viewModel.loadData()

        let linuxGroup = viewModel.filteredGroups.first { $0.name == "linux.large" }!
        viewModel.toggleGroup(linuxGroup)
        XCTAssertTrue(viewModel.expandedGroups.contains("linux.large"))

        viewModel.statusFilter = .busy
        // linux.large still appears (has busy runners)
        XCTAssertTrue(viewModel.expandedGroups.contains("linux.large"))

        viewModel.statusFilter = .all
        XCTAssertTrue(viewModel.expandedGroups.contains("linux.large"))
    }

    // MARK: - Sort Order with Filters

    func testSortOrderAppliesAfterFiltering() async {
        setRunnersResponse(groups: [
            (label: "charlie", runners: [
                (id: 1, name: "r1", os: "Linux", status: "online", busy: false, labels: []),
            ]),
            (label: "alpha", runners: [
                (id: 2, name: "r2", os: "Linux", status: "online", busy: false, labels: []),
                (id: 3, name: "r3", os: "Linux", status: "online", busy: true, labels: []),
            ]),
            (label: "bravo", runners: [
                (id: 4, name: "r4", os: "Linux", status: "online", busy: true, labels: []),
            ]),
        ])
        await viewModel.loadData()

        viewModel.statusFilter = .busy
        viewModel.sortOrder = .count

        // After busy filter: alpha has 1 busy, bravo has 1 busy; charlie removed
        let names = viewModel.filteredGroups.map(\.name)
        XCTAssertEqual(names.count, 2)
        XCTAssertFalse(names.contains("charlie"))
    }
}
