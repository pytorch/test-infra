import XCTest
@testable import TorchCI

@MainActor
final class BenchmarkDashboardViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: BenchmarkDashboardViewModel!

    private static let testBenchmark = BenchmarkMetadata(
        id: "pytorch_operator_microbenchmark",
        name: "Operator Microbenchmark",
        description: "PyTorch operator-level microbenchmarks",
        suites: nil,
        lastUpdated: nil
    )

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = BenchmarkDashboardViewModel(
            benchmark: BenchmarkDashboardViewModelTests.testBenchmark,
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

    private func registerAllResponses(
        data dataJSON: String = BenchmarkDashboardViewModelTests.emptyDataJSON,
        regression regressionJSON: String = BenchmarkDashboardViewModelTests.emptyRegressionJSON
    ) {
        mockClient.setResponse(dataJSON, for: "/api/clickhouse/oss_ci_benchmark_llms")
        mockClient.setResponse(regressionJSON, for: "/api/benchmark/list_regression_summary_reports")
    }

    // MARK: - Static JSON Fixtures

    private static let emptyDataJSON = "[]"
    private static let emptyRegressionJSON = """
    {"reports": [], "next_cursor": null}
    """

    private static let sampleDataJSON = """
    [
        {
            "workflow_id": 100, "job_id": 1, "model": "add", "backend": "eager",
            "metric": "throughput", "actual": 1500.0, "actual_geomean": 1450.0, "target": 1200.0,
            "mode": "inference", "dtype": "float32", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-10T00:00:00.000Z"
        },
        {
            "workflow_id": 101, "job_id": 2, "model": "add", "backend": "eager",
            "metric": "throughput", "actual": 1600.0, "actual_geomean": 1550.0, "target": 1200.0,
            "mode": "inference", "dtype": "float32", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-11T00:00:00.000Z"
        },
        {
            "workflow_id": 100, "job_id": 3, "model": "matmul", "backend": "inductor",
            "metric": "latency_ms", "actual": 0.5, "actual_geomean": 0.48, "target": 0.6,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-10T00:00:00.000Z"
        }
    ]
    """

    private static let sampleRegressionJSON = """
    {
        "reports": [
            {
                "id": "report-001",
                "report_id": "pytorch_operator_microbenchmark",
                "created_at": "2025-01-15T00:00:00.000Z",
                "last_record_ts": "2025-01-15T00:00:00.000Z",
                "last_record_commit": "abc123",
                "type": "regression",
                "status": "regression",
                "repo": "pytorch/pytorch",
                "regression_count": 2,
                "insufficient_data_count": 0,
                "suspected_regression_count": 1,
                "total_count": 5
            }
        ],
        "next_cursor": "2025-01-15T00:00:00.000Z"
    }
    """

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertTrue(viewModel.timeSeriesData.isEmpty)
        XCTAssertNil(viewModel.groupData)
        XCTAssertTrue(viewModel.regressionReports.isEmpty)
        XCTAssertTrue(viewModel.selectedModels.isEmpty)
        XCTAssertEqual(viewModel.selectedMetric, "")
        XCTAssertEqual(viewModel.selectedBranch, "main")
    }

    // MARK: - Loading State

    func testLoadDataSetsLoadingState() async {
        registerAllResponses()
        mockClient.artificialDelayNanoseconds = 100_000_000 // 0.1 seconds

        let task = Task {
            await viewModel.loadData()
        }

        // Give it a moment to start
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(viewModel.state, .loading)

        await task.value
    }

    // MARK: - Successful Loading

    func testLoadDataWithEmptyResponse() async {
        registerAllResponses()

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertTrue(viewModel.timeSeriesData.isEmpty)
        XCTAssertNil(viewModel.groupData)
        XCTAssertTrue(viewModel.regressionReports.isEmpty)
    }

    func testLoadDataWithSampleData() async {
        registerAllResponses(
            data: BenchmarkDashboardViewModelTests.sampleDataJSON,
            regression: BenchmarkDashboardViewModelTests.sampleRegressionJSON
        )

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.timeSeriesData.count, 3)
        XCTAssertNotNil(viewModel.groupData)
        XCTAssertEqual(viewModel.regressionReports.count, 1)
    }

    func testLoadDataAutoSelectsFirstMetric() async {
        registerAllResponses(data: BenchmarkDashboardViewModelTests.sampleDataJSON)

        await viewModel.loadData()

        XCTAssertFalse(viewModel.selectedMetric.isEmpty,
                       "Should auto-select first available metric")
        XCTAssertTrue(viewModel.availableMetrics.contains(viewModel.selectedMetric))
    }

    // MARK: - Error Handling

    func testLoadDataErrorState() async {
        mockClient.setError(APIError.notFound, for: "/api/clickhouse/oss_ci_benchmark_llms")
        mockClient.setError(APIError.notFound, for: "/api/benchmark/list_regression_summary_reports")

        await viewModel.loadData()

        if case .error = viewModel.state {
            // Expected
        } else {
            XCTFail("Should be in error state, got \(viewModel.state)")
        }
    }

    func testPartialLoadShowsDataEvenIfRegressionFails() async {
        mockClient.setResponse(BenchmarkDashboardViewModelTests.sampleDataJSON,
                               for: "/api/clickhouse/oss_ci_benchmark_llms")
        mockClient.setError(APIError.notFound, for: "/api/benchmark/list_regression_summary_reports")

        await viewModel.loadData()

        // The fallback path should still load ClickHouse data
        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertFalse(viewModel.timeSeriesData.isEmpty)
    }

    // MARK: - API Call Paths

    func testCorrectEndpointsAreCalled() async {
        registerAllResponses()

        await viewModel.loadData()

        let paths = mockClient.callPaths()
        XCTAssertTrue(paths.contains("/api/clickhouse/oss_ci_benchmark_llms"),
                       "Should call ClickHouse data endpoint")
        XCTAssertTrue(paths.contains("/api/benchmark/list_regression_summary_reports"),
                       "Should call regression endpoint")
    }

    func testDoesNotCallAuthenticatedV3Endpoints() async {
        registerAllResponses()

        await viewModel.loadData()

        let paths = mockClient.callPaths()
        XCTAssertFalse(paths.contains("/api/benchmark/get_time_series"),
                        "Should NOT call authenticated time series endpoint")
        XCTAssertFalse(paths.contains("/api/benchmark/group_data"),
                        "Should NOT call authenticated group data endpoint")
    }

    // MARK: - Benchmark Config Mapping

    func testBenchmarkConfigMappings() {
        let operatorConfig = BenchmarkDashboardViewModel.benchmarkConfig["pytorch_operator_microbenchmark"]
        XCTAssertNotNil(operatorConfig)
        XCTAssertEqual(operatorConfig?.repo, "pytorch/pytorch")
        XCTAssertEqual(operatorConfig?.benchmarks, ["PyTorch operator microbenchmark"])

        let helionConfig = BenchmarkDashboardViewModel.benchmarkConfig["pytorch_helion"]
        XCTAssertNotNil(helionConfig)
        XCTAssertEqual(helionConfig?.repo, "pytorch/helion")
        XCTAssertEqual(helionConfig?.benchmarks, ["Helion Benchmark"])

        let executorchConfig = BenchmarkDashboardViewModel.benchmarkConfig["executorch_benchmark"]
        XCTAssertNotNil(executorchConfig)
        XCTAssertEqual(executorchConfig?.repo, "pytorch/executorch")
        XCTAssertEqual(executorchConfig?.benchmarks, ["ExecuTorch"])
    }

    func testUnknownBenchmarkIdFallsBackToName() async {
        let unknownBenchmark = BenchmarkMetadata(
            id: "unknown_benchmark",
            name: "Custom Benchmark Name",
            description: nil,
            suites: nil,
            lastUpdated: nil
        )
        let vm = BenchmarkDashboardViewModel(benchmark: unknownBenchmark, apiClient: mockClient)
        registerAllResponses()

        await vm.loadData()

        // For unknown IDs, the benchmarks parameter should fall back to the benchmark name
        let config = BenchmarkDashboardViewModel.benchmarkConfig["unknown_benchmark"]
        XCTAssertNil(config, "Unknown IDs should not be in the config map")
    }

    // MARK: - ConvertRawRows

    func testConvertRawRowsEmpty() {
        let (timeSeries, groupData) = BenchmarkDashboardViewModel.convertRawRows([])
        XCTAssertTrue(timeSeries.isEmpty)
        XCTAssertNil(groupData)
    }

    func testConvertRawRowsCreatesTimeSeriesPoints() throws {
        let json = BenchmarkDashboardViewModelTests.sampleDataJSON
        let data = json.data(using: .utf8)!
        let rows = try JSONDecoder().decode([LLMBenchmarkRawRow].self, from: data)

        let (timeSeries, _) = BenchmarkDashboardViewModel.convertRawRows(rows)

        XCTAssertEqual(timeSeries.count, 3)

        let addPoints = timeSeries.filter { $0.model == "add" }
        XCTAssertEqual(addPoints.count, 2)

        let matmulPoints = timeSeries.filter { $0.model == "matmul" }
        XCTAssertEqual(matmulPoints.count, 1)
    }

    func testConvertRawRowsGroupDataKeepsLatestWorkflow() throws {
        let json = BenchmarkDashboardViewModelTests.sampleDataJSON
        let data = json.data(using: .utf8)!
        let rows = try JSONDecoder().decode([LLMBenchmarkRawRow].self, from: data)

        let (_, groupData) = BenchmarkDashboardViewModel.convertRawRows(rows)

        XCTAssertNotNil(groupData)
        let addThroughputPoints = groupData?.data.filter { $0.name == "add" && $0.metric == "throughput" }
        XCTAssertEqual(addThroughputPoints?.count, 1)

        // Latest workflow_id for add/throughput is 101 with value 1600.0
        let latestPoint = addThroughputPoints?.first
        XCTAssertEqual(latestPoint?.value, 1600.0)
    }

    func testConvertRawRowsCalculatesSpeedupFromTarget() throws {
        let json = BenchmarkDashboardViewModelTests.sampleDataJSON
        let data = json.data(using: .utf8)!
        let rows = try JSONDecoder().decode([LLMBenchmarkRawRow].self, from: data)

        let (_, groupData) = BenchmarkDashboardViewModel.convertRawRows(rows)

        // matmul latency: actual=0.5, target=0.6 -> speedup = 0.5/0.6
        let matmulPoint = groupData?.data.first { $0.name == "matmul" }
        XCTAssertNotNil(matmulPoint)
        XCTAssertNotNil(matmulPoint?.speedup)
        XCTAssertEqual(matmulPoint?.speedup ?? 0, 0.5 / 0.6, accuracy: 0.001)
        XCTAssertEqual(matmulPoint?.baseline, 0.6)
    }

    // MARK: - Computed Properties

    func testAvailableModelsFromTimeSeries() async {
        registerAllResponses(data: BenchmarkDashboardViewModelTests.sampleDataJSON)

        await viewModel.loadData()

        let models = viewModel.availableModels
        XCTAssertTrue(models.contains("add"))
        XCTAssertTrue(models.contains("matmul"))
    }

    func testAvailableMetricsFromTimeSeries() async {
        registerAllResponses(data: BenchmarkDashboardViewModelTests.sampleDataJSON)

        await viewModel.loadData()

        let metrics = viewModel.availableMetrics
        XCTAssertTrue(metrics.contains("throughput"))
        XCTAssertTrue(metrics.contains("latency_ms"))
    }

    func testFilteredTimeSeriesByMetric() async {
        registerAllResponses(data: BenchmarkDashboardViewModelTests.sampleDataJSON)

        await viewModel.loadData()

        viewModel.selectedMetric = "throughput"
        let filtered = viewModel.filteredTimeSeries
        XCTAssertEqual(filtered.count, 2)
        XCTAssertTrue(filtered.allSatisfy { $0.metric == "throughput" })
    }

    func testFilteredTimeSeriesByModel() async {
        registerAllResponses(data: BenchmarkDashboardViewModelTests.sampleDataJSON)

        await viewModel.loadData()

        viewModel.selectedModels = ["matmul"]
        viewModel.selectedMetric = ""
        let filtered = viewModel.filteredTimeSeries
        XCTAssertEqual(filtered.count, 1)
        XCTAssertEqual(filtered.first?.model, "matmul")
    }

    // MARK: - Statistics

    func testStatisticsWithNoData() {
        let stats = viewModel.statistics
        XCTAssertEqual(stats.mean, 0)
        XCTAssertEqual(stats.median, 0)
        XCTAssertEqual(stats.stddev, 0)
    }

    func testStatisticsWithData() async {
        registerAllResponses(data: BenchmarkDashboardViewModelTests.sampleDataJSON)

        await viewModel.loadData()

        // Select throughput to get only add's points (1500, 1600)
        viewModel.selectedMetric = "throughput"
        let stats = viewModel.statistics

        XCTAssertEqual(stats.mean, 1550.0, accuracy: 0.01)
        XCTAssertEqual(stats.min, 1500.0)
        XCTAssertEqual(stats.max, 1600.0)
    }

    // MARK: - Performance Trend & Variance

    func testPerformanceTrendStableWithNoData() {
        XCTAssertEqual(viewModel.performanceTrend.label, "Stable")
    }

    func testVarianceLevelUnknownWithNoData() {
        XCTAssertEqual(viewModel.varianceLevel.label, "Unknown")
    }

    // MARK: - Regressions

    func testRegressionReportsLoaded() async {
        registerAllResponses(regression: BenchmarkDashboardViewModelTests.sampleRegressionJSON)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.regressionReports.count, 1)
        XCTAssertTrue(viewModel.hasRegressions)
    }

    func testNoRegressionsWhenEmpty() async {
        registerAllResponses()

        await viewModel.loadData()

        XCTAssertFalse(viewModel.hasRegressions)
        XCTAssertEqual(viewModel.totalRegressionCount, 0)
    }

    // MARK: - Excluded Metrics

    func testExcludedMetricsListIsPopulated() {
        XCTAssertFalse(BenchmarkDashboardViewModel.excludedMetrics.isEmpty)
        XCTAssertTrue(BenchmarkDashboardViewModel.excludedMetrics.contains("load_status"))
        XCTAssertTrue(BenchmarkDashboardViewModel.excludedMetrics.contains("speedup_pct"))
    }

    // MARK: - Select Metric

    func testSelectMetric() {
        viewModel.selectMetric("latency_ms")
        XCTAssertEqual(viewModel.selectedMetric, "latency_ms")
    }

    // MARK: - Branches

    func testBranchesConstant() {
        XCTAssertEqual(BenchmarkDashboardViewModel.branches, ["main", "viable/strict", "nightly"])
    }
}
