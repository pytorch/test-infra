import XCTest
@testable import TorchCI

@MainActor
final class UtilizationViewModelTests: XCTestCase {
    private var mockClient: MockAPIClient!
    private var sut: UtilizationViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        sut = UtilizationViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        sut = nil
        mockClient = nil
        super.tearDown()
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(sut.state, .idle)
        XCTAssertTrue(sut.reports.isEmpty)
        XCTAssertEqual(sut.selectedGroupBy, .workflow)
        XCTAssertEqual(sut.sortField, .totalJobs)
        XCTAssertFalse(sut.sortAscending)
        XCTAssertEqual(sut.selectedTimeRange, .last7Days)
        XCTAssertFalse(sut.showingDatePicker)
    }

    // MARK: - Load Data

    func testLoadDataSuccess() async {
        setResponse(makeReportResponse(reports: [
            ("pull", 100, 75.0, 60.0),
            ("trunk", 50, 40.0, 30.0),
        ]))

        await sut.loadData()

        XCTAssertEqual(sut.state, .loaded)
        XCTAssertEqual(sut.reports.count, 2)
    }

    func testLoadDataError() async {
        // Don't set any response — will get notFound
        await sut.loadData()

        if case .error = sut.state {
            // Expected
        } else {
            XCTFail("Expected error state, got \(sut.state)")
        }
    }

    func testLoadDataEmptyResponse() async {
        setResponse(makeReportResponse(reports: []))

        await sut.loadData()

        XCTAssertEqual(sut.state, .loaded)
        XCTAssertTrue(sut.reports.isEmpty)
    }

    // MARK: - Sorting

    func testSortedReportsByTotalJobsDescending() async {
        setResponse(makeReportResponse(reports: [
            ("small", 10, 50.0, 50.0),
            ("large", 100, 50.0, 50.0),
            ("medium", 50, 50.0, 50.0),
        ]))

        await sut.loadData()
        sut.sortField = .totalJobs
        sut.sortAscending = false

        let names = sut.sortedReports.map(\.name)
        XCTAssertEqual(names, ["large", "medium", "small"])
    }

    func testSortedReportsByTotalJobsAscending() async {
        setResponse(makeReportResponse(reports: [
            ("small", 10, 50.0, 50.0),
            ("large", 100, 50.0, 50.0),
            ("medium", 50, 50.0, 50.0),
        ]))

        await sut.loadData()
        sut.sortField = .totalJobs
        sut.sortAscending = true

        let names = sut.sortedReports.map(\.name)
        XCTAssertEqual(names, ["small", "medium", "large"])
    }

    func testSortedReportsByCPU() async {
        setResponse(makeReportResponse(reports: [
            ("low-cpu", 10, 20.0, 50.0),
            ("high-cpu", 10, 90.0, 50.0),
            ("mid-cpu", 10, 55.0, 50.0),
        ]))

        await sut.loadData()
        sut.sortField = .cpu
        sut.sortAscending = false

        let names = sut.sortedReports.map(\.name)
        XCTAssertEqual(names, ["high-cpu", "mid-cpu", "low-cpu"])
    }

    func testSortedReportsByMemory() async {
        setResponse(makeReportResponse(reports: [
            ("low-mem", 10, 50.0, 20.0),
            ("high-mem", 10, 50.0, 90.0),
        ]))

        await sut.loadData()
        sut.sortField = .memory
        sut.sortAscending = false

        XCTAssertEqual(sut.sortedReports.first?.name, "high-mem")
    }

    func testSortedReportsByName() async {
        setResponse(makeReportResponse(reports: [
            ("Charlie", 10, 50.0, 50.0),
            ("Alpha", 10, 50.0, 50.0),
            ("Bravo", 10, 50.0, 50.0),
        ]))

        await sut.loadData()
        sut.sortField = .name
        sut.sortAscending = true

        let names = sut.sortedReports.map(\.name)
        XCTAssertEqual(names, ["Alpha", "Bravo", "Charlie"])
    }

    func testToggleSortSameField() {
        sut.sortField = .cpu
        sut.sortAscending = false

        sut.toggleSort(.cpu)
        XCTAssertTrue(sut.sortAscending)

        sut.toggleSort(.cpu)
        XCTAssertFalse(sut.sortAscending)
    }

    func testToggleSortDifferentField() {
        sut.sortField = .cpu
        sut.sortAscending = true

        sut.toggleSort(.memory)
        XCTAssertEqual(sut.sortField, .memory)
        XCTAssertFalse(sut.sortAscending)
    }

    func testSortIcon() {
        sut.sortField = .cpu
        sut.sortAscending = false

        XCTAssertEqual(sut.sortIcon(for: .cpu), "chevron.down")
        XCTAssertNil(sut.sortIcon(for: .memory))

        sut.sortAscending = true
        XCTAssertEqual(sut.sortIcon(for: .cpu), "chevron.up")
    }

    // MARK: - Computed Properties

    func testAverageCPU() async {
        setResponse(makeReportResponse(reports: [
            ("a", 10, 80.0, 50.0),
            ("b", 10, 60.0, 50.0),
        ]))

        await sut.loadData()

        XCTAssertEqual(sut.averageCPU, 70.0, accuracy: 0.1)
    }

    func testAverageCPUEmpty() {
        XCTAssertEqual(sut.averageCPU, 0.0)
    }

    func testAverageMemory() async {
        setResponse(makeReportResponse(reports: [
            ("a", 10, 50.0, 40.0),
            ("b", 10, 50.0, 60.0),
        ]))

        await sut.loadData()

        XCTAssertEqual(sut.averageMemory, 50.0, accuracy: 0.1)
    }

    func testTotalJobsCount() async {
        setResponse(makeReportResponse(reports: [
            ("a", 100, 50.0, 50.0),
            ("b", 200, 50.0, 50.0),
            ("c", 50, 50.0, 50.0),
        ]))

        await sut.loadData()

        XCTAssertEqual(sut.totalJobsCount, 350)
    }

    // MARK: - Utilization Distribution

    func testUtilizationDistribution() async {
        setResponse(makeReportResponse(reports: [
            ("low", 10, 20.0, 20.0),         // Low: cpu < 40
            ("medium", 10, 55.0, 55.0),       // Medium: 40-70
            ("high", 10, 80.0, 80.0),         // High: >= 70 both
        ]))

        await sut.loadData()

        XCTAssertEqual(sut.lowUtilizationCount, 1)
        XCTAssertEqual(sut.mediumUtilizationCount, 1)
        XCTAssertEqual(sut.highUtilizationCount, 1)
        XCTAssertEqual(sut.utilizationDistribution.count, 3)
    }

    // MARK: - Utilization Level

    func testUtilizationLevelHigh() {
        let result = sut.utilizationLevel(cpu: 80.0, memory: 70.0)
        XCTAssertEqual(result.text, "High")
    }

    func testUtilizationLevelMedium() {
        let result = sut.utilizationLevel(cpu: 50.0, memory: 50.0)
        XCTAssertEqual(result.text, "Medium")
    }

    func testUtilizationLevelLow() {
        let result = sut.utilizationLevel(cpu: 20.0, memory: 20.0)
        XCTAssertEqual(result.text, "Low")
    }

    func testUtilizationLevelNilValues() {
        let result = sut.utilizationLevel(cpu: nil, memory: nil)
        XCTAssertEqual(result.text, "Low")
    }

    func testUtilizationLevelBoundaryAt40() {
        // Exactly 40% should be medium, not low
        let result = sut.utilizationLevel(cpu: 40.0, memory: 40.0)
        XCTAssertEqual(result.text, "Medium")
    }

    func testUtilizationLevelBoundaryAt70() {
        // Exactly 70% for both should be high
        let result = sut.utilizationLevel(cpu: 70.0, memory: 70.0)
        XCTAssertEqual(result.text, "High")
    }

    func testUtilizationLevelHighCPULowMemory() {
        // High CPU but low memory should be medium
        let result = sut.utilizationLevel(cpu: 90.0, memory: 20.0)
        XCTAssertNotEqual(result.text, "High", "Need both CPU and memory high for High level")
    }

    func testUtilizationLevelJustBelow40() {
        let result = sut.utilizationLevel(cpu: 39.9, memory: 39.9)
        XCTAssertEqual(result.text, "Low")
    }

    // MARK: - Group By

    func testSelectGroupByChangesAndClearsReports() async {
        setResponse(makeReportResponse(reports: [("a", 10, 50.0, 50.0)]))
        await sut.loadData()
        XCTAssertFalse(sut.reports.isEmpty)

        // Change group by — reports should clear immediately
        // Need to set response for new path too
        let newPath = "/api/list_util_reports/job_name"
        mockClient.setResponse(makeReportResponse(reports: [("b", 20, 60.0, 60.0)]), for: newPath)

        sut.selectGroupBy(.job)

        XCTAssertEqual(sut.selectedGroupBy, .job)
        XCTAssertTrue(sut.reports.isEmpty) // Cleared immediately
    }

    func testSelectSameGroupByNoOp() {
        sut.selectedGroupBy = .workflow
        sut.selectGroupBy(.workflow)
        // No crash, no side effects
        XCTAssertEqual(sut.selectedGroupBy, .workflow)
    }

    // MARK: - Time Range

    func testTimeRangeDateRange() {
        let today = UtilizationViewModel.TimeRange.today.dateRange
        XCTAssertNotNil(today)

        let yesterday = UtilizationViewModel.TimeRange.yesterday.dateRange
        XCTAssertNotNil(yesterday)

        let last7 = UtilizationViewModel.TimeRange.last7Days.dateRange
        XCTAssertNotNil(last7)

        let last30 = UtilizationViewModel.TimeRange.last30Days.dateRange
        XCTAssertNotNil(last30)

        let custom = UtilizationViewModel.TimeRange.custom.dateRange
        XCTAssertNil(custom)
    }

    func testSelectTimeRangeCustomShowsDatePicker() {
        sut.selectTimeRange(.custom)
        XCTAssertTrue(sut.showingDatePicker)
    }

    func testApplyCustomDateRangeHidesPicker() {
        sut.showingDatePicker = true
        sut.applyCustomDateRange()
        XCTAssertFalse(sut.showingDatePicker)
    }

    func testResolvedDateRangeCustom() {
        let start = Date(timeIntervalSince1970: 1000000)
        let end = Date(timeIntervalSince1970: 2000000)
        sut.selectedTimeRange = .custom
        sut.customStartDate = start
        sut.customEndDate = end

        let range = sut.resolvedDateRange
        XCTAssertEqual(range.start, start)
        XCTAssertEqual(range.end, end)
    }

    // MARK: - Endpoint Construction

    func testUtilizationEndpointFormat() {
        let date1 = Date(timeIntervalSince1970: 1706140800) // 2024-01-25
        let date2 = Date(timeIntervalSince1970: 1706745600) // 2024-01-31

        let endpoint = UtilizationViewModel.utilizationEndpoint(
            groupBy: "workflow_name",
            startDate: date1,
            endDate: date2
        )

        XCTAssertEqual(endpoint.path, "/api/list_util_reports/workflow_name")
        XCTAssertNotNil(endpoint.queryItems)
        let queryDict = Dictionary(uniqueKeysWithValues: endpoint.queryItems!.map { ($0.name, $0.value) })
        XCTAssertEqual(queryDict["repo"], "pytorch/pytorch")
        XCTAssertEqual(queryDict["group_by"], "workflow_name")
        XCTAssertEqual(queryDict["granularity"], "day")
    }

    // MARK: - isLoading

    func testIsLoading() {
        XCTAssertFalse(sut.isLoading)
        sut.state = .loading
        XCTAssertTrue(sut.isLoading)
        sut.state = .loaded
        XCTAssertFalse(sut.isLoading)
    }

    // MARK: - GroupBy descriptions

    func testGroupByDescriptions() {
        XCTAssertEqual(UtilizationViewModel.GroupBy.workflow.description, "Workflow")
        XCTAssertEqual(UtilizationViewModel.GroupBy.job.description, "Job")
        XCTAssertEqual(UtilizationViewModel.GroupBy.runnerType.description, "Runner Type")
    }

    // MARK: - SortField labels

    func testSortFieldLabels() {
        XCTAssertEqual(UtilizationViewModel.SortField.name.label, "Name")
        XCTAssertEqual(UtilizationViewModel.SortField.cpu.label, "Avg CPU")
        XCTAssertEqual(UtilizationViewModel.SortField.memory.label, "Avg Memory")
        XCTAssertEqual(UtilizationViewModel.SortField.totalJobs.label, "Total Jobs")
    }

    // MARK: - Helpers

    private func setResponse(_ json: String) {
        // The path depends on the groupBy; default is workflow_name
        mockClient.setResponse(json, for: "/api/list_util_reports/workflow_name")
    }

    private func makeReportResponse(reports: [(String, Int, Double, Double)]) -> String {
        let items = reports.map { (name, totalJobs, cpu, memory) in
            """
            {
                "group_key": "\(name)",
                "parent_group": null,
                "time_group": null,
                "total_runs": \(totalJobs),
                "metrics": {"cpu_avg": \(cpu), "memory_avg": \(memory)}
            }
            """
        }
        return """
        {
            "group_key": "workflow_name",
            "metadata_list": [\(items.joined(separator: ","))]
        }
        """
    }
}
