import XCTest
@testable import TorchCI

@MainActor
final class QueueTimeViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: QueueTimeViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = QueueTimeViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Helpers

    private func registerQueueTimeResponse(_ json: String) {
        mockClient.setResponse(json, for: "/api/clickhouse/queue_times_historical")
    }

    private func makeQueueTimeJSON(entries: [(bucket: String, queueSeconds: Double, machineType: String)]) -> String {
        let items = entries.map { entry in
            """
            {"granularity_bucket":"\(entry.bucket)","avg_queue_s":\(entry.queueSeconds),"machine_type":"\(entry.machineType)"}
            """
        }
        return "[\(items.joined(separator: ","))]"
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .loading)
        XCTAssertEqual(viewModel.selectedTimeRange, "7d")
        XCTAssertEqual(viewModel.granularity, .day)
        XCTAssertNil(viewModel.avgQueueMinutes)
        XCTAssertNil(viewModel.p90QueueMinutes)
        XCTAssertNil(viewModel.maxQueueMinutes)
        XCTAssertTrue(viewModel.queueTimeSeries.isEmpty)
        XCTAssertTrue(viewModel.machineTypeBreakdown.isEmpty)
    }

    func testDefaultSortOption() {
        XCTAssertTrue(viewModel.sortedMachineTypes.isEmpty)
    }

    // MARK: - Load Data

    func testLoadDataSuccess() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
            ("2024-01-02T00:00:00Z", 1200, "linux.2xlarge"),
            ("2024-01-01T00:00:00Z", 300, "linux.gpu.h100"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertFalse(viewModel.queueTimeSeries.isEmpty)
        XCTAssertFalse(viewModel.machineTypeBreakdown.isEmpty)
        XCTAssertNotNil(viewModel.avgQueueMinutes)
        XCTAssertNotNil(viewModel.p90QueueMinutes)
        XCTAssertNotNil(viewModel.maxQueueMinutes)
    }

    func testLoadDataError() async {
        mockClient.setError(APIError.serverError(500), for: "/api/clickhouse/queue_times_historical")

        await viewModel.loadData()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadDataEmptyResponse() async {
        registerQueueTimeResponse("[]")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertTrue(viewModel.queueTimeSeries.isEmpty)
        XCTAssertTrue(viewModel.machineTypeBreakdown.isEmpty)
        XCTAssertNil(viewModel.avgQueueMinutes)
        XCTAssertNil(viewModel.p90QueueMinutes)
        XCTAssertNil(viewModel.maxQueueMinutes)
    }

    // MARK: - Summary Computation

    func testSummaryComputesAvgCorrectly() async {
        // 3 entries: 600s (10m), 1200s (20m), 300s (5m) -> avg = 700s = 11.67m
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
            ("2024-01-02T00:00:00Z", 1200, "linux.2xlarge"),
            ("2024-01-01T00:00:00Z", 300, "linux.gpu.h100"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        XCTAssertNotNil(viewModel.avgQueueMinutes)
        let expectedAvg = (600.0 + 1200.0 + 300.0) / 3.0 / 60.0
        XCTAssertEqual(viewModel.avgQueueMinutes!, expectedAvg, accuracy: 0.01)
    }

    func testSummaryComputesMaxCorrectly() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
            ("2024-01-02T00:00:00Z", 3600, "linux.gpu.h100"),
            ("2024-01-03T00:00:00Z", 900, "macos-14"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        XCTAssertNotNil(viewModel.maxQueueMinutes)
        XCTAssertEqual(viewModel.maxQueueMinutes!, 3600.0 / 60.0, accuracy: 0.01)
    }

    func testSummaryComputesP90Correctly() async {
        // 10 values sorted: 60, 120, 180, 240, 300, 360, 420, 480, 540, 600
        // p90 index = Int(10 * 0.9) = 9, but clamped to count-1 = 9, value = 600
        var entries: [(String, Double, String)] = []
        for i in 1...10 {
            entries.append(("2024-01-0\(i)T00:00:00Z", Double(i * 60), "linux.2xlarge"))
        }
        let json = makeQueueTimeJSON(entries: entries.map { ($0.0, $0.1, $0.2) })
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        XCTAssertNotNil(viewModel.p90QueueMinutes)
        // p90 index = min(Int(10*0.9), 9) = min(9, 9) = 9 -> value = 600s = 10m
        XCTAssertEqual(viewModel.p90QueueMinutes!, 600.0 / 60.0, accuracy: 0.01)
    }

    // MARK: - Machine Type Breakdown

    func testMachineTypeBreakdownGroupsByMachineType() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
            ("2024-01-02T00:00:00Z", 900, "linux.2xlarge"),
            ("2024-01-01T00:00:00Z", 300, "linux.gpu.h100"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.machineTypeBreakdown.count, 2)

        let linuxMachine = viewModel.machineTypeBreakdown.first { $0.machineType == "linux.2xlarge" }
        XCTAssertNotNil(linuxMachine)
        XCTAssertEqual(linuxMachine!.dataPoints, 2)
        // avg = (600+900)/2 = 750 seconds = 12.5 minutes
        XCTAssertEqual(linuxMachine!.avgMinutes, 750.0 / 60.0, accuracy: 0.01)

        let gpuMachine = viewModel.machineTypeBreakdown.first { $0.machineType == "linux.gpu.h100" }
        XCTAssertNotNil(gpuMachine)
        XCTAssertEqual(gpuMachine!.dataPoints, 1)
        XCTAssertEqual(gpuMachine!.avgMinutes, 300.0 / 60.0, accuracy: 0.01)
    }

    func testMachineTypeMaxMinutes() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
            ("2024-01-02T00:00:00Z", 1800, "linux.2xlarge"),
            ("2024-01-03T00:00:00Z", 300, "linux.2xlarge"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        let machine = viewModel.machineTypeBreakdown.first { $0.machineType == "linux.2xlarge" }
        XCTAssertNotNil(machine)
        XCTAssertEqual(machine!.maxMinutes, 1800.0 / 60.0, accuracy: 0.01)
    }

    // MARK: - Short Name

    func testShortNameForLongMachineType() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.jammy.py3.10.gcc9.2xlarge"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        let machine = viewModel.machineTypeBreakdown.first
        XCTAssertNotNil(machine)
        // "linux.jammy.py3.10.gcc9.2xlarge" is > 25 chars, has 6 parts
        // suffix(2) -> ["gcc9", "2xlarge"] -> "gcc9.2xlarge"
        XCTAssertEqual(machine!.shortName, "gcc9.2xlarge")
    }

    func testShortNameForShortMachineType() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        let machine = viewModel.machineTypeBreakdown.first
        XCTAssertNotNil(machine)
        // "linux.2xlarge" is <= 25 chars
        XCTAssertEqual(machine!.shortName, "linux.2xlarge")
    }

    // MARK: - Sorting

    func testSortByAvgTime() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 300, "macos-14"),
            ("2024-01-01T00:00:00Z", 1800, "linux.gpu.h100"),
            ("2024-01-01T00:00:00Z", 900, "linux.2xlarge"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        viewModel.sortBy = .avgTime
        let sorted = viewModel.sortedMachineTypes
        XCTAssertEqual(sorted.count, 3)
        // Descending by avg time: h100(30m) > 2xlarge(15m) > macos(5m)
        XCTAssertEqual(sorted[0].machineType, "linux.gpu.h100")
        XCTAssertEqual(sorted[1].machineType, "linux.2xlarge")
        XCTAssertEqual(sorted[2].machineType, "macos-14")
    }

    func testSortByMaxTime() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 300, "macos-14"),
            ("2024-01-02T00:00:00Z", 6000, "macos-14"),
            ("2024-01-01T00:00:00Z", 1800, "linux.gpu.h100"),
            ("2024-01-01T00:00:00Z", 900, "linux.2xlarge"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        viewModel.sortBy = .maxTime
        let sorted = viewModel.sortedMachineTypes
        // Max times: macos(6000s=100m) > h100(1800s=30m) > 2xlarge(900s=15m)
        XCTAssertEqual(sorted[0].machineType, "macos-14")
        XCTAssertEqual(sorted[1].machineType, "linux.gpu.h100")
        XCTAssertEqual(sorted[2].machineType, "linux.2xlarge")
    }

    func testSortByName() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 300, "macos-14"),
            ("2024-01-01T00:00:00Z", 1800, "linux.gpu.h100"),
            ("2024-01-01T00:00:00Z", 900, "alpha-runner"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        viewModel.sortBy = .name
        let sorted = viewModel.sortedMachineTypes
        // Alphabetical: alpha-runner < linux.gpu.h100 < macos-14
        XCTAssertEqual(sorted[0].machineType, "alpha-runner")
        XCTAssertEqual(sorted[1].machineType, "linux.gpu.h100")
        XCTAssertEqual(sorted[2].machineType, "macos-14")
    }

    // MARK: - Top Wait Times

    func testTopWaitTimesLimitsToFive() async {
        var entries: [(String, Double, String)] = []
        for i in 1...8 {
            entries.append(("2024-01-01T00:00:00Z", Double(i * 100), "machine-\(i)"))
        }
        let json = makeQueueTimeJSON(entries: entries.map { ($0.0, $0.1, $0.2) })
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.topWaitTimes.count, 5)
    }

    func testTopWaitTimesWithFewerThanFive() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
            ("2024-01-01T00:00:00Z", 300, "macos-14"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.topWaitTimes.count, 2)
    }

    // MARK: - Worst Machine Type

    func testWorstMachineType() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 300, "macos-14"),
            ("2024-01-01T00:00:00Z", 1800, "linux.gpu.h100"),
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        XCTAssertNotNil(viewModel.worstMachineType)
        XCTAssertEqual(viewModel.worstMachineType!.machineType, "linux.gpu.h100")
    }

    func testWorstMachineTypeWhenEmpty() {
        XCTAssertNil(viewModel.worstMachineType)
    }

    // MARK: - Max Overall Time

    func testMaxOverallTime() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
            ("2024-01-01T00:00:00Z", 3600, "linux.gpu.h100"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.maxOverallTime, 3600.0 / 60.0, accuracy: 0.01)
    }

    func testMaxOverallTimeDefaultsToOne() {
        XCTAssertEqual(viewModel.maxOverallTime, 1.0)
    }

    // MARK: - Trend Percentage

    func testTrendPercentageWithIncreasingValues() async {
        // 6 data points: older third [100, 200], recent third [500, 600]
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 100, "linux.2xlarge"),
            ("2024-01-02T00:00:00Z", 200, "linux.2xlarge"),
            ("2024-01-03T00:00:00Z", 300, "linux.2xlarge"),
            ("2024-01-04T00:00:00Z", 400, "linux.2xlarge"),
            ("2024-01-05T00:00:00Z", 500, "linux.2xlarge"),
            ("2024-01-06T00:00:00Z", 600, "linux.2xlarge"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        XCTAssertNotNil(viewModel.trendPercentage)
        // Trend should be positive (increasing)
        XCTAssertGreaterThan(viewModel.trendPercentage!, 0)
    }

    func testTrendPercentageWithSinglePoint() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        // Only 1 time series point (all same bucket gets aggregated), need >= 2
        XCTAssertNil(viewModel.trendPercentage)
    }

    func testTrendPercentageWhenEmpty() {
        XCTAssertNil(viewModel.trendPercentage)
    }

    // MARK: - Time Series Computation

    func testTimeSeriesAggregatesByBucket() async {
        // Two entries in same bucket, one in different -> 2 time series points
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
            ("2024-01-01T00:00:00Z", 300, "linux.gpu.h100"),
            ("2024-01-02T00:00:00Z", 900, "linux.2xlarge"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.queueTimeSeries.count, 2)

        // First bucket should be 2024-01-01 with avg of (600+300)/2 = 450
        let day1 = viewModel.queueTimeSeries.first { $0.granularity_bucket == "2024-01-01T00:00:00Z" }
        XCTAssertNotNil(day1)
        XCTAssertEqual(day1!.value!, 450.0, accuracy: 0.01)

        // Second bucket should be 2024-01-02 with value 900
        let day2 = viewModel.queueTimeSeries.first { $0.granularity_bucket == "2024-01-02T00:00:00Z" }
        XCTAssertNotNil(day2)
        XCTAssertEqual(day2!.value!, 900.0, accuracy: 0.01)
    }

    func testTimeSeriesIsSortedByBucket() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-03T00:00:00Z", 300, "linux.2xlarge"),
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
            ("2024-01-02T00:00:00Z", 900, "linux.2xlarge"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.queueTimeSeries.count, 3)
        XCTAssertEqual(viewModel.queueTimeSeries[0].granularity_bucket, "2024-01-01T00:00:00Z")
        XCTAssertEqual(viewModel.queueTimeSeries[1].granularity_bucket, "2024-01-02T00:00:00Z")
        XCTAssertEqual(viewModel.queueTimeSeries[2].granularity_bucket, "2024-01-03T00:00:00Z")
    }

    // MARK: - Selected Range

    func testSelectedRangeDefault() {
        XCTAssertEqual(viewModel.selectedTimeRange, "7d")
        XCTAssertEqual(viewModel.selectedRange?.days, 7)
        XCTAssertEqual(viewModel.selectedRange?.label, "1 Week")
    }

    func testSelectedRangeChange() {
        viewModel.selectedTimeRange = "30d"
        XCTAssertEqual(viewModel.selectedRange?.days, 30)
        XCTAssertEqual(viewModel.selectedRange?.label, "1 Month")
    }

    func testSelectedRangeInvalid() {
        viewModel.selectedTimeRange = "invalid"
        XCTAssertNil(viewModel.selectedRange)
    }

    // MARK: - Refresh

    func testRefreshReloadsData() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.refresh()

        XCTAssertEqual(mockClient.callCount, 1)
        let paths = mockClient.callPaths()
        XCTAssertTrue(paths.contains("/api/clickhouse/queue_times_historical"))
    }

    func testOnParametersChangedReloadsData() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
        ])
        registerQueueTimeResponse(json)

        viewModel.granularity = .hour
        await viewModel.onParametersChanged()

        XCTAssertEqual(mockClient.callCount, 1)
    }

    // MARK: - Categorize

    func testCategorizeGPU() {
        XCTAssertEqual(QueueTimeViewModel.categorize("linux.gpu.h100"), "GPU")
        XCTAssertEqual(QueueTimeViewModel.categorize("linux.cuda.12"), "GPU")
        XCTAssertEqual(QueueTimeViewModel.categorize("linux.a100"), "GPU")
        XCTAssertEqual(QueueTimeViewModel.categorize("linux.rocm.6"), "GPU")
    }

    func testCategorizeLinux() {
        XCTAssertEqual(QueueTimeViewModel.categorize("linux.2xlarge"), "Linux")
        XCTAssertEqual(QueueTimeViewModel.categorize("linux.jammy.py3.10"), "Linux")
    }

    func testCategorizeMacOS() {
        XCTAssertEqual(QueueTimeViewModel.categorize("macos-14"), "macOS")
        XCTAssertEqual(QueueTimeViewModel.categorize("darwin-arm64"), "macOS")
    }

    func testCategorizeWindows() {
        XCTAssertEqual(QueueTimeViewModel.categorize("windows.4xlarge"), "Windows")
    }

    func testCategorizeOther() {
        XCTAssertEqual(QueueTimeViewModel.categorize("custom-runner"), "Other")
    }

    func testCategorizeGPUTakesPriorityOverLinux() {
        // A machine type like "linux.gpu.h100" should be categorized as GPU, not Linux
        XCTAssertEqual(QueueTimeViewModel.categorize("linux.gpu.h100"), "GPU")
    }

    // MARK: - Category Breakdown

    func testCategoryBreakdownGroupsByCategory() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
            ("2024-01-01T00:00:00Z", 900, "linux.4xlarge"),
            ("2024-01-01T00:00:00Z", 1800, "linux.gpu.h100"),
            ("2024-01-01T00:00:00Z", 300, "macos-14"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        let categories = viewModel.categoryBreakdown
        // Should be 3 categories: Linux, GPU, macOS
        XCTAssertEqual(categories.count, 3)

        let categoryNames = Set(categories.map(\.category))
        XCTAssertTrue(categoryNames.contains("Linux"))
        XCTAssertTrue(categoryNames.contains("GPU"))
        XCTAssertTrue(categoryNames.contains("macOS"))
    }

    func testCategoryBreakdownMachineCount() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
            ("2024-01-01T00:00:00Z", 900, "linux.4xlarge"),
            ("2024-01-01T00:00:00Z", 1200, "linux.xlarge"),
            ("2024-01-01T00:00:00Z", 300, "macos-14"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        let categories = viewModel.categoryBreakdown
        let linuxCat = categories.first { $0.category == "Linux" }
        XCTAssertNotNil(linuxCat)
        XCTAssertEqual(linuxCat!.machineCount, 3)

        let macosCat = categories.first { $0.category == "macOS" }
        XCTAssertNotNil(macosCat)
        XCTAssertEqual(macosCat!.machineCount, 1)
    }

    func testCategoryBreakdownWeightedAverage() async {
        // linux.2xlarge: 2 data points at 600s each -> avg = 10m, dataPoints = 2
        // linux.4xlarge: 1 data point at 1200s -> avg = 20m, dataPoints = 1
        // Weighted avg for Linux: (10*2 + 20*1) / (2+1) = 40/3 = 13.33m
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
            ("2024-01-02T00:00:00Z", 600, "linux.2xlarge"),
            ("2024-01-01T00:00:00Z", 1200, "linux.4xlarge"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        let categories = viewModel.categoryBreakdown
        let linuxCat = categories.first { $0.category == "Linux" }
        XCTAssertNotNil(linuxCat)
        let expectedWeightedAvg = (10.0 * 2.0 + 20.0 * 1.0) / 3.0
        XCTAssertEqual(linuxCat!.avgMinutes, expectedWeightedAvg, accuracy: 0.01)
    }

    func testCategoryBreakdownSortedByAvgDescending() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 300, "macos-14"),
            ("2024-01-01T00:00:00Z", 1800, "linux.gpu.h100"),
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        let categories = viewModel.categoryBreakdown
        XCTAssertEqual(categories.count, 3)
        // GPU (30m) > Linux (10m) > macOS (5m)
        XCTAssertEqual(categories[0].category, "GPU")
        XCTAssertEqual(categories[1].category, "Linux")
        XCTAssertEqual(categories[2].category, "macOS")
    }

    func testCategoryBreakdownMaxMinutes() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
            ("2024-01-02T00:00:00Z", 3600, "linux.4xlarge"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        let linuxCat = viewModel.categoryBreakdown.first { $0.category == "Linux" }
        XCTAssertNotNil(linuxCat)
        // Max across both machines: 3600s = 60m
        XCTAssertEqual(linuxCat!.maxMinutes, 3600.0 / 60.0, accuracy: 0.01)
    }

    func testCategoryBreakdownTotalDataPoints() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
            ("2024-01-02T00:00:00Z", 600, "linux.2xlarge"),
            ("2024-01-01T00:00:00Z", 900, "linux.4xlarge"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        let linuxCat = viewModel.categoryBreakdown.first { $0.category == "Linux" }
        XCTAssertNotNil(linuxCat)
        XCTAssertEqual(linuxCat!.totalDataPoints, 3)
    }

    func testCategoryBreakdownEmpty() {
        XCTAssertTrue(viewModel.categoryBreakdown.isEmpty)
    }

    // MARK: - ViewState Equality

    func testViewStateEquality() {
        XCTAssertEqual(QueueTimeViewModel.ViewState.loading, QueueTimeViewModel.ViewState.loading)
        XCTAssertEqual(QueueTimeViewModel.ViewState.loaded, QueueTimeViewModel.ViewState.loaded)
        XCTAssertEqual(QueueTimeViewModel.ViewState.error("test"), QueueTimeViewModel.ViewState.error("test"))
        XCTAssertNotEqual(QueueTimeViewModel.ViewState.loading, QueueTimeViewModel.ViewState.loaded)
        XCTAssertNotEqual(QueueTimeViewModel.ViewState.error("a"), QueueTimeViewModel.ViewState.error("b"))
        XCTAssertNotEqual(QueueTimeViewModel.ViewState.loading, QueueTimeViewModel.ViewState.error("x"))
    }

    // MARK: - Granularity Change

    func testGranularityValues() {
        viewModel.granularity = .hour
        XCTAssertEqual(viewModel.granularity, .hour)

        viewModel.granularity = .week
        XCTAssertEqual(viewModel.granularity, .week)

        viewModel.granularity = .day
        XCTAssertEqual(viewModel.granularity, .day)
    }

    // MARK: - Edge Cases

    func testSingleMachineTypeWithMultipleDataPoints() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 60, "linux.2xlarge"),
            ("2024-01-02T00:00:00Z", 120, "linux.2xlarge"),
            ("2024-01-03T00:00:00Z", 180, "linux.2xlarge"),
            ("2024-01-04T00:00:00Z", 240, "linux.2xlarge"),
            ("2024-01-05T00:00:00Z", 300, "linux.2xlarge"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.machineTypeBreakdown.count, 1)
        let machine = viewModel.machineTypeBreakdown.first!
        XCTAssertEqual(machine.dataPoints, 5)
        // avg = (60+120+180+240+300)/5 = 900/5 = 180s = 3m
        XCTAssertEqual(machine.avgMinutes, 180.0 / 60.0, accuracy: 0.01)
    }

    func testLoadThenLoadAgainResetsState() async {
        let json = makeQueueTimeJSON(entries: [
            ("2024-01-01T00:00:00Z", 600, "linux.2xlarge"),
        ])
        registerQueueTimeResponse(json)

        await viewModel.loadData()
        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertNotNil(viewModel.avgQueueMinutes)

        // Now load with error
        mockClient.reset()
        mockClient.setError(APIError.serverError(500), for: "/api/clickhouse/queue_times_historical")

        await viewModel.loadData()

        if case .error = viewModel.state {
            // Expected
        } else {
            XCTFail("Expected error state after failed reload")
        }
    }
}
