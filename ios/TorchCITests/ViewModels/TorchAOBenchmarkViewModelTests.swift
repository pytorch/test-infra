import XCTest
@testable import TorchCI

@MainActor
final class TorchAOBenchmarkViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: TorchAOBenchmarkViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = TorchAOBenchmarkViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertNil(viewModel.groupData)
        XCTAssertEqual(viewModel.selectedSuite, "all")
        XCTAssertEqual(viewModel.selectedQuantization, "all")
        XCTAssertEqual(viewModel.selectedMode, "inference")
        XCTAssertEqual(viewModel.selectedDevice, "cuda")
        XCTAssertTrue(viewModel.sortBySpeedup)
    }

    // MARK: - Filter Options

    func testAvailableSuites() {
        XCTAssertEqual(viewModel.availableSuites, ["all", "torchbench", "huggingface", "timm_models"])
    }

    func testAvailableQuantizations() {
        XCTAssertEqual(viewModel.availableQuantizations, ["all", "autoquant", "int8dynamic", "int8weightonly", "noquant"])
    }

    func testAvailableModes() {
        XCTAssertEqual(viewModel.availableModes, ["inference", "training"])
    }

    func testAvailableDevices() {
        XCTAssertEqual(viewModel.availableDevices, ["cuda", "cpu"])
    }

    // MARK: - Filtered Data Points (No Data)

    func testFilteredDataPointsEmptyWhenNoGroupData() {
        XCTAssertTrue(viewModel.filteredDataPoints.isEmpty)
    }

    func testFilteredDataPointsEmptyWhenGroupDataHasNoPoints() {
        viewModel.groupData = BenchmarkGroupData(data: [], metadata: nil)
        XCTAssertTrue(viewModel.filteredDataPoints.isEmpty)
    }

    // MARK: - Filtered Data Points (With Data)

    func testFilteredDataPointsReturnsAllWhenAllSelected() {
        viewModel.groupData = BenchmarkGroupData(data: makeSampleDataPoints(), metadata: nil)
        viewModel.selectedSuite = "all"
        viewModel.selectedQuantization = "all"

        XCTAssertEqual(viewModel.filteredDataPoints.count, 4)
    }

    func testFilteredDataPointsFiltersBySuite() {
        viewModel.groupData = BenchmarkGroupData(data: makeSampleDataPoints(), metadata: nil)
        viewModel.selectedSuite = "torchbench"
        viewModel.selectedQuantization = "all"

        let filtered = viewModel.filteredDataPoints
        XCTAssertTrue(filtered.allSatisfy {
            $0.name.lowercased().contains("torchbench") ||
            $0.metric?.lowercased().contains("torchbench") ?? false
        })
    }

    func testFilteredDataPointsFiltersByQuantization() {
        viewModel.groupData = BenchmarkGroupData(data: makeSampleDataPoints(), metadata: nil)
        viewModel.selectedSuite = "all"
        viewModel.selectedQuantization = "autoquant"

        let filtered = viewModel.filteredDataPoints
        XCTAssertTrue(filtered.allSatisfy {
            $0.name.lowercased().contains("autoquant") ||
            $0.metric?.lowercased().contains("autoquant") ?? false
        })
    }

    func testFilteredDataPointsFiltersBySuiteAndQuantization() {
        viewModel.groupData = BenchmarkGroupData(data: makeSampleDataPoints(), metadata: nil)
        viewModel.selectedSuite = "torchbench"
        viewModel.selectedQuantization = "autoquant"

        let filtered = viewModel.filteredDataPoints
        // Must match both suite AND quantization
        for point in filtered {
            let matchesSuite = point.name.lowercased().contains("torchbench") ||
                               point.metric?.lowercased().contains("torchbench") ?? false
            let matchesQuant = point.name.lowercased().contains("autoquant") ||
                               point.metric?.lowercased().contains("autoquant") ?? false
            XCTAssertTrue(matchesSuite && matchesQuant, "Point \(point.name) should match both filters")
        }
    }

    func testFilteredDataPointsSortedBySpeedupDescending() {
        viewModel.groupData = BenchmarkGroupData(data: makeSampleDataPoints(), metadata: nil)

        let filtered = viewModel.filteredDataPoints
        for i in 0..<(filtered.count - 1) {
            let currentSpeedup = filtered[i].speedup ?? 1.0
            let nextSpeedup = filtered[i + 1].speedup ?? 1.0
            XCTAssertGreaterThanOrEqual(currentSpeedup, nextSpeedup,
                "Points should be sorted by speedup descending")
        }
    }

    // MARK: - Sorted Data Points

    func testSortedDataPointsBySpeedup() {
        viewModel.groupData = BenchmarkGroupData(data: makeSampleDataPoints(), metadata: nil)
        viewModel.sortBySpeedup = true

        let sorted = viewModel.sortedDataPoints
        // Should be same order as filteredDataPoints (speedup descending)
        XCTAssertEqual(sorted.map(\.id), viewModel.filteredDataPoints.map(\.id))
    }

    func testSortedDataPointsByName() {
        viewModel.groupData = BenchmarkGroupData(data: makeSampleDataPoints(), metadata: nil)
        viewModel.sortBySpeedup = false

        let sorted = viewModel.sortedDataPoints
        for i in 0..<(sorted.count - 1) {
            let comparison = sorted[i].name.localizedCaseInsensitiveCompare(sorted[i + 1].name)
            XCTAssertNotEqual(comparison, .orderedDescending,
                "Points should be sorted alphabetically when sortBySpeedup is false")
        }
    }

    // MARK: - Model Count

    func testModelCountMatchesFilteredCount() {
        viewModel.groupData = BenchmarkGroupData(data: makeSampleDataPoints(), metadata: nil)

        XCTAssertEqual(viewModel.modelCount, viewModel.filteredDataPoints.count)
    }

    func testModelCountZeroWhenNoData() {
        XCTAssertEqual(viewModel.modelCount, 0)
    }

    // MARK: - Average Speedup

    func testAverageSpeedupNilWhenNoData() {
        XCTAssertNil(viewModel.averageSpeedup)
    }

    func testAverageSpeedupNilWhenNoSpeedups() {
        let points = [
            BenchmarkDataPoint(name: "model_a", metric: nil, value: 1.0, baseline: nil, speedup: nil, status: nil),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        XCTAssertNil(viewModel.averageSpeedup)
    }

    func testAverageSpeedupCalculation() {
        let points = [
            BenchmarkDataPoint(name: "model_a", metric: nil, value: 1.0, baseline: 1.0, speedup: 1.2, status: "pass"),
            BenchmarkDataPoint(name: "model_b", metric: nil, value: 1.0, baseline: 1.0, speedup: 0.8, status: "fail"),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        XCTAssertNotNil(viewModel.averageSpeedup)
        XCTAssertEqual(viewModel.averageSpeedup!, 1.0, accuracy: 0.001)
    }

    func testAverageSpeedupWithSinglePoint() {
        let points = [
            BenchmarkDataPoint(name: "model_a", metric: nil, value: 1.0, baseline: 1.0, speedup: 1.5, status: "pass"),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        XCTAssertNotNil(viewModel.averageSpeedup)
        XCTAssertEqual(viewModel.averageSpeedup!, 1.5, accuracy: 0.001)
    }

    // MARK: - Pass Rate

    func testPassRateNilWhenNoData() {
        XCTAssertNil(viewModel.passRate)
    }

    func testPassRateAllPassing() {
        let points = [
            BenchmarkDataPoint(name: "model_a", metric: nil, value: 1.0, baseline: 1.0, speedup: 1.2, status: "pass"),
            BenchmarkDataPoint(name: "model_b", metric: nil, value: 1.0, baseline: 1.0, speedup: 0.96, status: "pass"),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        XCTAssertNotNil(viewModel.passRate)
        XCTAssertEqual(viewModel.passRate!, 100.0, accuracy: 0.001)
    }

    func testPassRateWithFailures() {
        let points = [
            BenchmarkDataPoint(name: "model_a", metric: nil, value: 1.0, baseline: 1.0, speedup: 1.2, status: "pass"),
            BenchmarkDataPoint(name: "model_b", metric: nil, value: 1.0, baseline: 1.0, speedup: 0.8, status: "fail"),
            BenchmarkDataPoint(name: "model_c", metric: nil, value: 1.0, baseline: 1.0, speedup: 0.96, status: "pass"),
            BenchmarkDataPoint(name: "model_d", metric: nil, value: 1.0, baseline: 1.0, speedup: 0.5, status: "fail"),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        // 2 out of 4 pass (speedup >= 0.95)
        XCTAssertNotNil(viewModel.passRate)
        XCTAssertEqual(viewModel.passRate!, 50.0, accuracy: 0.001)
    }

    func testPassRateCountsNilSpeedupAsFailing() {
        let points = [
            BenchmarkDataPoint(name: "model_a", metric: nil, value: 1.0, baseline: 1.0, speedup: nil, status: nil),
            BenchmarkDataPoint(name: "model_b", metric: nil, value: 1.0, baseline: 1.0, speedup: 1.1, status: "pass"),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        // Only 1 of 2 passes (nil speedup doesn't pass)
        XCTAssertNotNil(viewModel.passRate)
        XCTAssertEqual(viewModel.passRate!, 50.0, accuracy: 0.001)
    }

    func testPassRateThresholdExact() {
        let points = [
            BenchmarkDataPoint(name: "model_a", metric: nil, value: 1.0, baseline: 1.0, speedup: 0.95, status: "pass"),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        // speedup == 0.95 passes (>= 0.95)
        XCTAssertEqual(viewModel.passRate!, 100.0, accuracy: 0.001)
    }

    func testPassRateThresholdJustBelow() {
        let points = [
            BenchmarkDataPoint(name: "model_a", metric: nil, value: 1.0, baseline: 1.0, speedup: 0.9499, status: "fail"),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        // speedup < 0.95 fails
        XCTAssertEqual(viewModel.passRate!, 0.0, accuracy: 0.001)
    }

    // MARK: - Average Memory Savings

    func testAverageMemorySavingsNilWhenNoData() {
        XCTAssertNil(viewModel.averageMemorySavings)
    }

    func testAverageMemorySavingsNilWhenNoBaselines() {
        let points = [
            BenchmarkDataPoint(name: "model_a", metric: nil, value: 1.0, baseline: nil, speedup: 1.0, status: nil),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        XCTAssertNil(viewModel.averageMemorySavings)
    }

    func testAverageMemorySavingsCalculation() {
        // baseline = 1.0, value = 0.8 -> savings = (1.0 - 0.8) / 1.0 * 100 = 20%
        let points = [
            BenchmarkDataPoint(name: "model_a", metric: nil, value: 0.8, baseline: 1.0, speedup: 1.0, status: nil),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        XCTAssertNotNil(viewModel.averageMemorySavings)
        XCTAssertEqual(viewModel.averageMemorySavings!, 20.0, accuracy: 0.001)
    }

    func testAverageMemorySavingsMultiplePoints() {
        // point1: baseline=1.0, value=0.8 -> 20% savings
        // point2: baseline=2.0, value=1.0 -> 50% savings
        // average = 35%
        let points = [
            BenchmarkDataPoint(name: "model_a", metric: nil, value: 0.8, baseline: 1.0, speedup: 1.0, status: nil),
            BenchmarkDataPoint(name: "model_b", metric: nil, value: 1.0, baseline: 2.0, speedup: 1.0, status: nil),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        XCTAssertNotNil(viewModel.averageMemorySavings)
        XCTAssertEqual(viewModel.averageMemorySavings!, 35.0, accuracy: 0.001)
    }

    func testAverageMemorySavingsSkipsZeroBaseline() {
        let points = [
            BenchmarkDataPoint(name: "model_a", metric: nil, value: 0.8, baseline: 0.0, speedup: 1.0, status: nil),
            BenchmarkDataPoint(name: "model_b", metric: nil, value: 0.8, baseline: 1.0, speedup: 1.0, status: nil),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        // Only model_b contributes (20% savings)
        XCTAssertNotNil(viewModel.averageMemorySavings)
        XCTAssertEqual(viewModel.averageMemorySavings!, 20.0, accuracy: 0.001)
    }

    func testAverageMemorySavingsNegativeWhenValueExceedsBaseline() {
        // baseline = 1.0, value = 1.5 -> savings = (1.0 - 1.5) / 1.0 * 100 = -50%
        let points = [
            BenchmarkDataPoint(name: "model_a", metric: nil, value: 1.5, baseline: 1.0, speedup: 1.0, status: nil),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        XCTAssertNotNil(viewModel.averageMemorySavings)
        XCTAssertEqual(viewModel.averageMemorySavings!, -50.0, accuracy: 0.001)
    }

    // MARK: - Chart X Domain

    func testChartXDomainDefaultWhenNoData() {
        let domain = viewModel.chartXDomain
        XCTAssertEqual(domain.lowerBound, 0.5, accuracy: 0.001)
        XCTAssertEqual(domain.upperBound, 2.0, accuracy: 0.001)
    }

    func testChartXDomainCalculation() {
        let points = [
            BenchmarkDataPoint(name: "a", metric: nil, value: 1.0, baseline: 1.0, speedup: 0.8, status: nil),
            BenchmarkDataPoint(name: "b", metric: nil, value: 1.0, baseline: 1.0, speedup: 1.5, status: nil),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        let domain = viewModel.chartXDomain
        let expectedPadding = (1.5 - 0.8) * 0.15

        XCTAssertEqual(domain.lowerBound, max(0, 0.8 - expectedPadding), accuracy: 0.001)
        XCTAssertEqual(domain.upperBound, 1.5 + expectedPadding, accuracy: 0.001)
    }

    func testChartXDomainNeverNegative() {
        let points = [
            BenchmarkDataPoint(name: "a", metric: nil, value: 1.0, baseline: 1.0, speedup: 0.01, status: nil),
            BenchmarkDataPoint(name: "b", metric: nil, value: 1.0, baseline: 1.0, speedup: 0.02, status: nil),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        let domain = viewModel.chartXDomain
        XCTAssertGreaterThanOrEqual(domain.lowerBound, 0)
    }

    // MARK: - Quantization Comparison

    func testQuantizationComparisonEmptyWhenNoData() {
        XCTAssertTrue(viewModel.quantizationComparison.isEmpty)
    }

    func testQuantizationComparisonGroupsByName() {
        let points = [
            BenchmarkDataPoint(name: "resnet50_autoquant", metric: nil, value: 1.0, baseline: 1.0, speedup: 1.2, status: nil),
            BenchmarkDataPoint(name: "bert_autoquant", metric: nil, value: 1.0, baseline: 1.0, speedup: 1.4, status: nil),
            BenchmarkDataPoint(name: "resnet50_int8dynamic", metric: nil, value: 1.0, baseline: 1.0, speedup: 1.1, status: nil),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        let comparison = viewModel.quantizationComparison
        XCTAssertEqual(comparison.count, 2) // autoquant and int8dynamic

        let autoquant = comparison.first { $0.quantization == "autoquant" }
        XCTAssertNotNil(autoquant)
        XCTAssertEqual(autoquant!.avgSpeedup, 1.3, accuracy: 0.001) // (1.2 + 1.4) / 2
        XCTAssertEqual(autoquant!.modelCount, 2)

        let int8 = comparison.first { $0.quantization == "int8dynamic" }
        XCTAssertNotNil(int8)
        XCTAssertEqual(int8!.avgSpeedup, 1.1, accuracy: 0.001)
        XCTAssertEqual(int8!.modelCount, 1)
    }

    func testQuantizationComparisonSortedBySpeedupDescending() {
        let points = [
            BenchmarkDataPoint(name: "model_noquant", metric: nil, value: 1.0, baseline: 1.0, speedup: 0.9, status: nil),
            BenchmarkDataPoint(name: "model_autoquant", metric: nil, value: 1.0, baseline: 1.0, speedup: 1.5, status: nil),
            BenchmarkDataPoint(name: "model_int8dynamic", metric: nil, value: 1.0, baseline: 1.0, speedup: 1.2, status: nil),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        let comparison = viewModel.quantizationComparison
        for i in 0..<(comparison.count - 1) {
            XCTAssertGreaterThanOrEqual(comparison[i].avgSpeedup, comparison[i + 1].avgSpeedup)
        }
    }

    func testQuantizationComparisonMatchesByMetricToo() {
        let points = [
            BenchmarkDataPoint(name: "resnet50", metric: "autoquant_speedup", value: 1.0, baseline: 1.0, speedup: 1.3, status: nil),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        let comparison = viewModel.quantizationComparison
        let autoquant = comparison.first { $0.quantization == "autoquant" }
        XCTAssertNotNil(autoquant, "Should match 'autoquant' via metric field")
    }

    // MARK: - Max Comparison Speedup

    func testMaxComparisonSpeedupDefaultWhenEmpty() {
        XCTAssertEqual(viewModel.maxComparisonSpeedup, 2.0 * 1.1, accuracy: 0.001)
    }

    func testMaxComparisonSpeedupCalculation() {
        let points = [
            BenchmarkDataPoint(name: "model_autoquant", metric: nil, value: 1.0, baseline: 1.0, speedup: 1.5, status: nil),
            BenchmarkDataPoint(name: "model_int8dynamic", metric: nil, value: 1.0, baseline: 1.0, speedup: 1.2, status: nil),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        XCTAssertEqual(viewModel.maxComparisonSpeedup, 1.5 * 1.1, accuracy: 0.001)
    }

    // MARK: - Load Data Success

    func testLoadDataSuccess() async {
        mockClient.setResponse(makeClickHouseResponseJSON(), for: "/api/clickhouse/torchao_query")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertNotNil(viewModel.groupData)
        XCTAssertFalse(viewModel.groupData!.data.isEmpty)
    }

    func testLoadDataSetsLoadingState() async {
        mockClient.setResponse(makeClickHouseResponseJSON(), for: "/api/clickhouse/torchao_query")

        // State should transition to .loading and then .loaded
        await viewModel.loadData()

        // After completion, should be .loaded
        XCTAssertEqual(viewModel.state, .loaded)
    }

    func testLoadDataKeepsLatestWorkflowPerModelDtype() async {
        // Two workflows for the same (model, dtype) – only the latest should be kept
        let json = """
        [
            {"suite": "torchbench", "model": "resnet50", "dtype": "autoquant", "metric": "speedup", "value": 1.2, "workflow_id": 100, "job_id": 1, "granularity_bucket": "2025-01-01T00:00:00Z"},
            {"suite": "torchbench", "model": "resnet50", "dtype": "autoquant", "metric": "speedup", "value": 1.5, "workflow_id": 200, "job_id": 2, "granularity_bucket": "2025-01-01T01:00:00Z"}
        ]
        """
        mockClient.setResponse(json, for: "/api/clickhouse/torchao_query")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertNotNil(viewModel.groupData)
        XCTAssertEqual(viewModel.groupData!.data.count, 1)

        let point = viewModel.groupData!.data.first!
        XCTAssertEqual(point.name, "resnet50")
        // Latest workflow (200) has speedup 1.5
        XCTAssertEqual(point.speedup!, 1.5, accuracy: 0.001)
    }

    func testLoadDataSetsPassStatusForHighSpeedup() async {
        let json = """
        [
            {"suite": "torchbench", "model": "fast_model", "dtype": "autoquant", "metric": "speedup", "value": 2.0, "workflow_id": 100, "job_id": 1, "granularity_bucket": "2025-01-01T00:00:00Z"}
        ]
        """
        mockClient.setResponse(json, for: "/api/clickhouse/torchao_query")

        await viewModel.loadData()

        let point = viewModel.groupData!.data.first!
        // speedup = 2.0 which is >= 0.95, so status should be "pass"
        XCTAssertEqual(point.status, "pass")
    }

    func testLoadDataSetsFailStatusForLowSpeedup() async {
        let json = """
        [
            {"suite": "torchbench", "model": "slow_model", "dtype": "autoquant", "metric": "speedup", "value": 0.5, "workflow_id": 100, "job_id": 1, "granularity_bucket": "2025-01-01T00:00:00Z"}
        ]
        """
        mockClient.setResponse(json, for: "/api/clickhouse/torchao_query")

        await viewModel.loadData()

        let point = viewModel.groupData!.data.first!
        // speedup = 0.5 which is < 0.95, so status should be "fail"
        XCTAssertEqual(point.status, "fail")
    }

    // MARK: - Load Data Error

    func testLoadDataError() async {
        mockClient.setError(APIError.notFound, for: "/api/clickhouse/torchao_query")

        await viewModel.loadData()

        if case .error = viewModel.state {
            // Expected
        } else {
            XCTFail("Expected error state, got \(viewModel.state)")
        }
    }

    func testLoadDataErrorPreservesExistingData() async {
        // First, load some data successfully
        mockClient.setResponse(makeClickHouseResponseJSON(), for: "/api/clickhouse/torchao_query")
        await viewModel.loadData()
        XCTAssertNotNil(viewModel.groupData)

        // Now simulate an error on reload
        mockClient.setError(APIError.notFound, for: "/api/clickhouse/torchao_query")
        await viewModel.loadData()

        // groupData should still be present from the first load
        // because loadData only replaces it on success
        if case .error = viewModel.state {
            XCTAssertNotNil(viewModel.groupData)
        } else {
            XCTFail("Expected error state")
        }
    }

    // MARK: - Load Data Makes Correct API Call

    func testLoadDataCallsCorrectEndpoint() async {
        mockClient.setResponse(makeClickHouseResponseJSON(), for: "/api/clickhouse/torchao_query")

        await viewModel.loadData()

        XCTAssertEqual(mockClient.callCount, 1)
        XCTAssertEqual(mockClient.callPaths(), ["/api/clickhouse/torchao_query"])
    }

    // MARK: - ViewState Equatable

    func testViewStateEquality() {
        XCTAssertEqual(TorchAOBenchmarkViewModel.ViewState.idle, .idle)
        XCTAssertEqual(TorchAOBenchmarkViewModel.ViewState.loading, .loading)
        XCTAssertEqual(TorchAOBenchmarkViewModel.ViewState.loaded, .loaded)
        XCTAssertEqual(TorchAOBenchmarkViewModel.ViewState.error("test"), .error("test"))

        XCTAssertNotEqual(TorchAOBenchmarkViewModel.ViewState.idle, .loading)
        XCTAssertNotEqual(TorchAOBenchmarkViewModel.ViewState.error("a"), .error("b"))
        XCTAssertNotEqual(TorchAOBenchmarkViewModel.ViewState.idle, .error("test"))
    }

    // MARK: - Sort Toggle

    func testSortToggleChangesOrder() {
        let points = [
            BenchmarkDataPoint(name: "zebra_model", metric: nil, value: 1.0, baseline: 1.0, speedup: 0.5, status: nil),
            BenchmarkDataPoint(name: "alpha_model", metric: nil, value: 1.0, baseline: 1.0, speedup: 2.0, status: nil),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)

        // Default: sort by speedup descending
        viewModel.sortBySpeedup = true
        let bySpeedup = viewModel.sortedDataPoints
        XCTAssertEqual(bySpeedup.first?.name, "alpha_model") // higher speedup
        XCTAssertEqual(bySpeedup.last?.name, "zebra_model")

        // Toggle to alphabetical
        viewModel.sortBySpeedup = false
        let byName = viewModel.sortedDataPoints
        XCTAssertEqual(byName.first?.name, "alpha_model") // alphabetically first
        XCTAssertEqual(byName.last?.name, "zebra_model")
    }

    // MARK: - Edge Cases

    func testLoadDataHandlesZeroSpeedupValue() async {
        let json = """
        [
            {"suite": "torchbench", "model": "zero_model", "dtype": "autoquant", "metric": "speedup", "value": 0.0, "workflow_id": 100, "job_id": 1, "granularity_bucket": "2025-01-01T00:00:00Z"}
        ]
        """
        mockClient.setResponse(json, for: "/api/clickhouse/torchao_query")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        let point = viewModel.groupData!.data.first!
        // speedup of 0.0 is < 0.95, so status should be "fail"
        XCTAssertEqual(point.speedup!, 0.0, accuracy: 0.001)
        XCTAssertEqual(point.status, "fail")
    }

    func testLoadDataHandlesModelWithOnlyAbsLatency() async {
        // A row with metric "abs_latency" but no speedup row
        let json = """
        [
            {"suite": "torchbench", "model": "simple_model", "dtype": "autoquant", "metric": "abs_latency", "value": 42.5, "workflow_id": 100, "job_id": 1, "granularity_bucket": "2025-01-01T00:00:00Z"}
        ]
        """
        mockClient.setResponse(json, for: "/api/clickhouse/torchao_query")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        let point = viewModel.groupData!.data.first!
        XCTAssertEqual(point.name, "simple_model")
        XCTAssertEqual(point.value, 42.5, accuracy: 0.001)
        // No speedup row, so speedup is nil
        XCTAssertNil(point.speedup)
    }

    func testFilteredDataPointsWithMetricMatch() {
        let points = [
            BenchmarkDataPoint(name: "resnet50", metric: "torchbench_speedup", value: 1.0, baseline: 1.0, speedup: 1.2, status: nil),
            BenchmarkDataPoint(name: "bert", metric: "huggingface_accuracy", value: 1.0, baseline: 1.0, speedup: 1.1, status: nil),
        ]
        viewModel.groupData = BenchmarkGroupData(data: points, metadata: nil)
        viewModel.selectedSuite = "torchbench"

        let filtered = viewModel.filteredDataPoints
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered.first?.name, "resnet50")
    }

    // MARK: - QuantizationStats

    func testQuantizationStatsId() {
        let stats = TorchAOBenchmarkViewModel.QuantizationStats(
            quantization: "autoquant",
            avgSpeedup: 1.5,
            modelCount: 10
        )
        XCTAssertEqual(stats.id, "autoquant")
    }

    // MARK: - Helpers

    private func makeSampleDataPoints() -> [BenchmarkDataPoint] {
        [
            BenchmarkDataPoint(
                name: "torchbench_resnet50_autoquant",
                metric: nil,
                value: 0.8,
                baseline: 1.0,
                speedup: 1.25,
                status: "pass"
            ),
            BenchmarkDataPoint(
                name: "torchbench_bert_int8dynamic",
                metric: nil,
                value: 1.1,
                baseline: 1.0,
                speedup: 0.91,
                status: "fail"
            ),
            BenchmarkDataPoint(
                name: "huggingface_gpt2_autoquant",
                metric: nil,
                value: 0.9,
                baseline: 1.0,
                speedup: 1.11,
                status: "pass"
            ),
            BenchmarkDataPoint(
                name: "timm_models_vit_noquant",
                metric: nil,
                value: 0.95,
                baseline: 1.0,
                speedup: 1.05,
                status: "pass"
            ),
        ]
    }

    private func makeClickHouseResponseJSON() -> String {
        """
        [
            {"suite": "torchbench", "model": "resnet50", "dtype": "autoquant", "metric": "speedup", "value": 1.25, "workflow_id": 100, "job_id": 1, "granularity_bucket": "2025-01-01T00:00:00Z"},
            {"suite": "torchbench", "model": "resnet50", "dtype": "autoquant", "metric": "abs_latency", "value": 0.8, "workflow_id": 100, "job_id": 1, "granularity_bucket": "2025-01-01T00:00:00Z"},
            {"suite": "huggingface", "model": "bert_base", "dtype": "int8dynamic", "metric": "speedup", "value": 0.83, "workflow_id": 100, "job_id": 2, "granularity_bucket": "2025-01-01T00:00:00Z"},
            {"suite": "huggingface", "model": "bert_base", "dtype": "int8dynamic", "metric": "abs_latency", "value": 1.2, "workflow_id": 100, "job_id": 2, "granularity_bucket": "2025-01-01T00:00:00Z"}
        ]
        """
    }
}
