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

        // V3 benchmark IDs added for compiler and other benchmarks
        let compilerInductorConfig = BenchmarkDashboardViewModel.benchmarkConfig["compiler_inductor"]
        XCTAssertNotNil(compilerInductorConfig)
        XCTAssertEqual(compilerInductorConfig?.repo, "pytorch/pytorch")

        let compilerPrecomputeConfig = BenchmarkDashboardViewModel.benchmarkConfig["compiler_precompute"]
        XCTAssertNotNil(compilerPrecomputeConfig)
        XCTAssertEqual(compilerPrecomputeConfig?.repo, "pytorch/pytorch")

        let vllmConfig = BenchmarkDashboardViewModel.benchmarkConfig["vllm_benchmark"]
        XCTAssertNotNil(vllmConfig)
        XCTAssertEqual(vllmConfig?.repo, "vllm-project/vllm")

        let gptfastConfig = BenchmarkDashboardViewModel.benchmarkConfig["pytorch_gptfast"]
        XCTAssertNotNil(gptfastConfig)
        XCTAssertEqual(gptfastConfig?.repo, "pytorch/pytorch")

        let torchaoConfig = BenchmarkDashboardViewModel.benchmarkConfig["torchao_micro_api_benchmark"]
        XCTAssertNotNil(torchaoConfig)
        XCTAssertEqual(torchaoConfig?.repo, "pytorch/ao")

        let pytorchVllmConfig = BenchmarkDashboardViewModel.benchmarkConfig["pytorch_x_vllm_benchmark"]
        XCTAssertNotNil(pytorchVllmConfig)
        XCTAssertEqual(pytorchVllmConfig?.repo, "pytorch/pytorch")

        let sglangConfig = BenchmarkDashboardViewModel.benchmarkConfig["sglang_benchmark"]
        XCTAssertNotNil(sglangConfig)
        XCTAssertEqual(sglangConfig?.repo, "sgl-project/sglang")
    }

    // MARK: - Compiler Benchmark IDs

    func testCompilerBenchmarkIdsSet() {
        XCTAssertTrue(BenchmarkDashboardViewModel.compilerBenchmarkIds.contains("compiler_inductor"))
        XCTAssertTrue(BenchmarkDashboardViewModel.compilerBenchmarkIds.contains("compiler_precompute"))
        XCTAssertFalse(BenchmarkDashboardViewModel.compilerBenchmarkIds.contains("pytorch_operator_microbenchmark"))
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

    // MARK: - Compiler Benchmark Routing

    func testCompilerBenchmarkCallsCompilersEndpoint() async {
        let compilerBenchmark = BenchmarkMetadata(
            id: "compiler_inductor",
            name: "TorchInductor",
            description: nil,
            suites: nil,
            lastUpdated: nil
        )
        let compilerVM = BenchmarkDashboardViewModel(benchmark: compilerBenchmark, apiClient: mockClient)

        mockClient.setResponse("[]", for: "/api/clickhouse/compilers_benchmark_performance")
        mockClient.setResponse(BenchmarkDashboardViewModelTests.emptyRegressionJSON,
                               for: "/api/benchmark/list_regression_summary_reports")

        await compilerVM.loadData()

        let paths = mockClient.callPaths()
        XCTAssertTrue(paths.contains("/api/clickhouse/compilers_benchmark_performance"),
                       "Compiler benchmarks should call compilers_benchmark_performance")
        XCTAssertFalse(paths.contains("/api/clickhouse/oss_ci_benchmark_llms"),
                        "Compiler benchmarks should NOT call oss_ci_benchmark_llms")
    }

    func testNonCompilerBenchmarkCallsLLMEndpoint() async {
        // The default viewModel uses pytorch_operator_microbenchmark which is not a compiler benchmark
        registerAllResponses()

        await viewModel.loadData()

        let paths = mockClient.callPaths()
        XCTAssertTrue(paths.contains("/api/clickhouse/oss_ci_benchmark_llms"),
                       "Non-compiler benchmarks should call oss_ci_benchmark_llms")
        XCTAssertFalse(paths.contains("/api/clickhouse/compilers_benchmark_performance"),
                        "Non-compiler benchmarks should NOT call compilers_benchmark_performance")
    }

    func testIsCompilerBenchmarkProperty() {
        // compiler_inductor is a compiler benchmark
        let compilerBenchmark = BenchmarkMetadata(
            id: "compiler_inductor",
            name: "TorchInductor",
            description: nil,
            suites: nil,
            lastUpdated: nil
        )
        let compilerVM = BenchmarkDashboardViewModel(benchmark: compilerBenchmark, apiClient: mockClient)
        XCTAssertTrue(compilerVM.isCompilerBenchmark)

        // pytorch_operator_microbenchmark is NOT a compiler benchmark
        XCTAssertFalse(viewModel.isCompilerBenchmark)
    }

    // MARK: - ConvertCompilerRawRows

    func testConvertCompilerRawRowsEmpty() {
        let (timeSeries, groupData) = BenchmarkDashboardViewModel.convertCompilerRawRows([])
        XCTAssertTrue(timeSeries.isEmpty)
        XCTAssertNil(groupData)
    }

    func testConvertCompilerRawRowsProducesTimeSeries() throws {
        let json = """
        [
            {
                "workflow_id": 200, "job_id": 1, "backend": "inductor", "suite": "torchbench",
                "model": "resnet50", "metric": "speedup", "value": 1.45,
                "extra_info": null, "output": null,
                "granularity_bucket": "2025-01-10 10:00:00.000"
            },
            {
                "workflow_id": 200, "job_id": 1, "backend": "inductor", "suite": "torchbench",
                "model": "resnet50", "metric": "compilation_latency", "value": 12.5,
                "extra_info": null, "output": null,
                "granularity_bucket": "2025-01-10 10:00:00.000"
            }
        ]
        """
        let data = json.data(using: .utf8)!
        let rows = try JSONDecoder().decode([CompilerBenchmarkRawRow].self, from: data)

        let (timeSeries, groupData) = BenchmarkDashboardViewModel.convertCompilerRawRows(rows)

        // Should produce 2 time series points: one for speedup, one for compilation_latency
        XCTAssertEqual(timeSeries.count, 2)

        let speedupPoints = timeSeries.filter { $0.metric == "speedup" }
        XCTAssertEqual(speedupPoints.count, 1)
        XCTAssertEqual(speedupPoints.first?.value, 1.45)

        let latencyPoints = timeSeries.filter { $0.metric == "compilation_latency" }
        XCTAssertEqual(latencyPoints.count, 1)
        XCTAssertEqual(latencyPoints.first?.value, 12.5)

        // Group data should have one entry for resnet50
        XCTAssertNotNil(groupData)
        XCTAssertEqual(groupData?.data.count, 1)
        XCTAssertEqual(groupData?.data.first?.name, "resnet50")
        XCTAssertEqual(groupData?.data.first?.speedup, 1.45)
    }

    // MARK: - Error Handling & Edge Cases

    func testLoadDataNetworkErrorSetsErrorState() async {
        // Both endpoints fail with a network error -> state should be .error
        let networkError = APIError.networkError(
            NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet)
        )
        mockClient.setError(networkError, for: "/api/clickhouse/oss_ci_benchmark_llms")
        mockClient.setError(networkError, for: "/api/benchmark/list_regression_summary_reports")

        await viewModel.loadData()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty, "Error message should not be empty")
        } else {
            XCTFail("Expected .error state, got \(viewModel.state)")
        }
        XCTAssertTrue(viewModel.timeSeriesData.isEmpty)
        XCTAssertNil(viewModel.groupData)
    }

    func testPartialLoadErrorWhenRegressionsFail() async {
        // Time series endpoint succeeds, regression endpoint fails
        // The combined fetch will throw because regressionFetch fails.
        // The fallback calls loadTimeSeriesFromClickHouse (succeeds) and loadRegressions (fails).
        mockClient.setResponse(
            BenchmarkDashboardViewModelTests.sampleDataJSON,
            for: "/api/clickhouse/oss_ci_benchmark_llms"
        )
        mockClient.setError(
            APIError.serverError(500),
            for: "/api/benchmark/list_regression_summary_reports"
        )

        await viewModel.loadData()

        // Should still be .loaded because time series data was retrieved
        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertFalse(viewModel.timeSeriesData.isEmpty,
                       "Time series data should be populated despite regression failure")
        // partialLoadError should be set from the regression failure
        XCTAssertNotNil(viewModel.partialLoadError,
                        "partialLoadError should be set when regressions fail")
        XCTAssertTrue(viewModel.regressionReports.isEmpty,
                      "Regression reports should be empty when endpoint fails")
    }

    // MARK: - Statistics Edge Cases

    func testStatisticsWithSingleDataPoint() async {
        // A single data point: mean == median == value, stddev == 0
        let singlePointJSON = """
        [
            {
                "workflow_id": 100, "job_id": 1, "model": "add", "backend": "eager",
                "metric": "throughput", "actual": 42.0, "actual_geomean": 42.0, "target": 40.0,
                "mode": "inference", "dtype": "float32", "device": "cuda", "arch": "A100",
                "granularity_bucket": "2025-01-10T00:00:00.000Z"
            }
        ]
        """
        registerAllResponses(data: singlePointJSON)

        await viewModel.loadData()
        viewModel.selectedMetric = "throughput"

        let stats = viewModel.statistics
        XCTAssertEqual(stats.mean, 42.0, accuracy: 0.001)
        XCTAssertEqual(stats.median, 42.0, accuracy: 0.001)
        XCTAssertEqual(stats.stddev, 0.0, accuracy: 0.001)
        XCTAssertEqual(stats.min, 42.0)
        XCTAssertEqual(stats.max, 42.0)
        XCTAssertEqual(stats.p25, 42.0, accuracy: 0.001)
        XCTAssertEqual(stats.p75, 42.0, accuracy: 0.001)
        XCTAssertEqual(stats.p90, 42.0, accuracy: 0.001)
        XCTAssertEqual(stats.p95, 42.0, accuracy: 0.001)
    }

    func testStatisticsWithAllSameValues() async {
        // All identical values: stddev should be exactly 0
        let sameValuesJSON = """
        [
            {
                "workflow_id": 100, "job_id": 1, "model": "add", "backend": "eager",
                "metric": "throughput", "actual": 100.0, "actual_geomean": 100.0, "target": 90.0,
                "mode": "inference", "dtype": "float32", "device": "cuda", "arch": "A100",
                "granularity_bucket": "2025-01-10T00:00:00.000Z"
            },
            {
                "workflow_id": 101, "job_id": 2, "model": "add", "backend": "eager",
                "metric": "throughput", "actual": 100.0, "actual_geomean": 100.0, "target": 90.0,
                "mode": "inference", "dtype": "float32", "device": "cuda", "arch": "A100",
                "granularity_bucket": "2025-01-11T00:00:00.000Z"
            },
            {
                "workflow_id": 102, "job_id": 3, "model": "add", "backend": "eager",
                "metric": "throughput", "actual": 100.0, "actual_geomean": 100.0, "target": 90.0,
                "mode": "inference", "dtype": "float32", "device": "cuda", "arch": "A100",
                "granularity_bucket": "2025-01-12T00:00:00.000Z"
            }
        ]
        """
        registerAllResponses(data: sameValuesJSON)

        await viewModel.loadData()
        viewModel.selectedMetric = "throughput"

        let stats = viewModel.statistics
        XCTAssertEqual(stats.mean, 100.0, accuracy: 0.001)
        XCTAssertEqual(stats.median, 100.0, accuracy: 0.001)
        XCTAssertEqual(stats.stddev, 0.0, accuracy: 0.001,
                       "Standard deviation of identical values must be zero")
        XCTAssertEqual(stats.min, 100.0)
        XCTAssertEqual(stats.max, 100.0)
    }

    // MARK: - Performance Trend Detection

    func testPerformanceTrendImproving() async {
        // Older half has lower values, recent half has significantly higher values (>5% increase)
        var rows: [[String: Any]] = []
        for i in 0..<20 {
            let value: Double = i < 10 ? 100.0 : 120.0  // 20% jump
            rows.append([
                "workflow_id": 100 + i,
                "job_id": i + 1,
                "model": "add",
                "backend": "eager",
                "metric": "throughput",
                "actual": value,
                "actual_geomean": value,
                "target": 90.0,
                "mode": "inference",
                "dtype": "float32",
                "device": "cuda",
                "arch": "A100",
                "granularity_bucket": "2025-01-\(String(format: "%02d", i + 1))T00:00:00.000Z"
            ])
        }
        let jsonData = try! JSONSerialization.data(withJSONObject: rows)
        let jsonString = String(data: jsonData, encoding: .utf8)!

        registerAllResponses(data: jsonString)

        await viewModel.loadData()
        viewModel.selectedMetric = "throughput"

        XCTAssertEqual(viewModel.performanceTrend, .improving,
                       "A 20% increase from older to recent values should be detected as improving")
        XCTAssertEqual(viewModel.performanceTrend.label, "Improving")
    }

    func testPerformanceTrendRegressing() async {
        // Older half has higher values, recent half has significantly lower values (>5% decrease)
        var rows: [[String: Any]] = []
        for i in 0..<20 {
            let value: Double = i < 10 ? 120.0 : 100.0  // 16.7% drop
            rows.append([
                "workflow_id": 100 + i,
                "job_id": i + 1,
                "model": "add",
                "backend": "eager",
                "metric": "throughput",
                "actual": value,
                "actual_geomean": value,
                "target": 90.0,
                "mode": "inference",
                "dtype": "float32",
                "device": "cuda",
                "arch": "A100",
                "granularity_bucket": "2025-01-\(String(format: "%02d", i + 1))T00:00:00.000Z"
            ])
        }
        let jsonData = try! JSONSerialization.data(withJSONObject: rows)
        let jsonString = String(data: jsonData, encoding: .utf8)!

        registerAllResponses(data: jsonString)

        await viewModel.loadData()
        viewModel.selectedMetric = "throughput"

        XCTAssertEqual(viewModel.performanceTrend, .regressing,
                       "A 16.7% decrease from older to recent values should be detected as regressing")
        XCTAssertEqual(viewModel.performanceTrend.label, "Regressing")
    }

    func testPerformanceTrendStable() async {
        // Values stay within 5% of each other -> stable
        var rows: [[String: Any]] = []
        for i in 0..<20 {
            // Alternate between 100 and 101 (1% variation)
            let value: Double = i % 2 == 0 ? 100.0 : 101.0
            rows.append([
                "workflow_id": 100 + i,
                "job_id": i + 1,
                "model": "add",
                "backend": "eager",
                "metric": "throughput",
                "actual": value,
                "actual_geomean": value,
                "target": 90.0,
                "mode": "inference",
                "dtype": "float32",
                "device": "cuda",
                "arch": "A100",
                "granularity_bucket": "2025-01-\(String(format: "%02d", i + 1))T00:00:00.000Z"
            ])
        }
        let jsonData = try! JSONSerialization.data(withJSONObject: rows)
        let jsonString = String(data: jsonData, encoding: .utf8)!

        registerAllResponses(data: jsonString)

        await viewModel.loadData()
        viewModel.selectedMetric = "throughput"

        XCTAssertEqual(viewModel.performanceTrend, .stable,
                       "Values within 5% should be classified as stable")
        XCTAssertEqual(viewModel.performanceTrend.label, "Stable")
    }

    // MARK: - Variance Level Detection

    func testVarianceLevelLow() async {
        // Coefficient of variation < 5%: values tightly clustered around mean
        // Values: 100, 101, 100, 101, 100 -> mean ~100.4, stddev ~0.49, CV ~0.49%
        let lowVarianceJSON = """
        [
            {
                "workflow_id": 100, "job_id": 1, "model": "add", "backend": "eager",
                "metric": "throughput", "actual": 100.0, "actual_geomean": 100.0, "target": 90.0,
                "mode": "inference", "dtype": "float32", "device": "cuda", "arch": "A100",
                "granularity_bucket": "2025-01-01T00:00:00.000Z"
            },
            {
                "workflow_id": 101, "job_id": 2, "model": "add", "backend": "eager",
                "metric": "throughput", "actual": 101.0, "actual_geomean": 101.0, "target": 90.0,
                "mode": "inference", "dtype": "float32", "device": "cuda", "arch": "A100",
                "granularity_bucket": "2025-01-02T00:00:00.000Z"
            },
            {
                "workflow_id": 102, "job_id": 3, "model": "add", "backend": "eager",
                "metric": "throughput", "actual": 100.0, "actual_geomean": 100.0, "target": 90.0,
                "mode": "inference", "dtype": "float32", "device": "cuda", "arch": "A100",
                "granularity_bucket": "2025-01-03T00:00:00.000Z"
            },
            {
                "workflow_id": 103, "job_id": 4, "model": "add", "backend": "eager",
                "metric": "throughput", "actual": 101.0, "actual_geomean": 101.0, "target": 90.0,
                "mode": "inference", "dtype": "float32", "device": "cuda", "arch": "A100",
                "granularity_bucket": "2025-01-04T00:00:00.000Z"
            },
            {
                "workflow_id": 104, "job_id": 5, "model": "add", "backend": "eager",
                "metric": "throughput", "actual": 100.0, "actual_geomean": 100.0, "target": 90.0,
                "mode": "inference", "dtype": "float32", "device": "cuda", "arch": "A100",
                "granularity_bucket": "2025-01-05T00:00:00.000Z"
            }
        ]
        """
        registerAllResponses(data: lowVarianceJSON)

        await viewModel.loadData()
        viewModel.selectedMetric = "throughput"

        XCTAssertEqual(viewModel.varianceLevel, .low,
                       "CV < 5% should produce .low variance level")
        XCTAssertEqual(viewModel.varianceLevel.label, "Low Variance (Stable)")
    }

    func testVarianceLevelHigh() async {
        // Coefficient of variation > 15%: widely spread values
        // Values: 50, 100, 150, 50, 150 -> mean = 100, stddev ~40, CV = 40%
        let highVarianceJSON = """
        [
            {
                "workflow_id": 100, "job_id": 1, "model": "add", "backend": "eager",
                "metric": "throughput", "actual": 50.0, "actual_geomean": 50.0, "target": 90.0,
                "mode": "inference", "dtype": "float32", "device": "cuda", "arch": "A100",
                "granularity_bucket": "2025-01-01T00:00:00.000Z"
            },
            {
                "workflow_id": 101, "job_id": 2, "model": "add", "backend": "eager",
                "metric": "throughput", "actual": 100.0, "actual_geomean": 100.0, "target": 90.0,
                "mode": "inference", "dtype": "float32", "device": "cuda", "arch": "A100",
                "granularity_bucket": "2025-01-02T00:00:00.000Z"
            },
            {
                "workflow_id": 102, "job_id": 3, "model": "add", "backend": "eager",
                "metric": "throughput", "actual": 150.0, "actual_geomean": 150.0, "target": 90.0,
                "mode": "inference", "dtype": "float32", "device": "cuda", "arch": "A100",
                "granularity_bucket": "2025-01-03T00:00:00.000Z"
            },
            {
                "workflow_id": 103, "job_id": 4, "model": "add", "backend": "eager",
                "metric": "throughput", "actual": 50.0, "actual_geomean": 50.0, "target": 90.0,
                "mode": "inference", "dtype": "float32", "device": "cuda", "arch": "A100",
                "granularity_bucket": "2025-01-04T00:00:00.000Z"
            },
            {
                "workflow_id": 104, "job_id": 5, "model": "add", "backend": "eager",
                "metric": "throughput", "actual": 150.0, "actual_geomean": 150.0, "target": 90.0,
                "mode": "inference", "dtype": "float32", "device": "cuda", "arch": "A100",
                "granularity_bucket": "2025-01-05T00:00:00.000Z"
            }
        ]
        """
        registerAllResponses(data: highVarianceJSON)

        await viewModel.loadData()
        viewModel.selectedMetric = "throughput"

        XCTAssertEqual(viewModel.varianceLevel, .high,
                       "CV > 15% should produce .high variance level")
        XCTAssertEqual(viewModel.varianceLevel.label, "High Variance (Unstable)")
    }

    // MARK: - Compiler Benchmark Routing (isCompilerBenchmark)

    func testCompilerBenchmarkRouting() {
        // compiler_inductor should be recognized as a compiler benchmark
        let compilerBenchmark = BenchmarkMetadata(
            id: "compiler_inductor",
            name: "TorchInductor",
            description: nil,
            suites: nil,
            lastUpdated: nil
        )
        let compilerVM = BenchmarkDashboardViewModel(
            benchmark: compilerBenchmark, apiClient: mockClient
        )
        XCTAssertTrue(compilerVM.isCompilerBenchmark,
                       "compiler_inductor must be identified as a compiler benchmark")
        XCTAssertTrue(
            BenchmarkDashboardViewModel.compilerBenchmarkIds.contains(compilerBenchmark.id),
            "compiler_inductor must be in the compilerBenchmarkIds set"
        )

        // Verify it has a config entry
        let config = BenchmarkDashboardViewModel.benchmarkConfig["compiler_inductor"]
        XCTAssertNotNil(config, "compiler_inductor should have a benchmarkConfig entry")
        XCTAssertEqual(config?.repo, "pytorch/pytorch")

        // Non-compiler benchmark should NOT be identified as compiler
        XCTAssertFalse(viewModel.isCompilerBenchmark,
                        "pytorch_operator_microbenchmark must NOT be a compiler benchmark")
    }
}
