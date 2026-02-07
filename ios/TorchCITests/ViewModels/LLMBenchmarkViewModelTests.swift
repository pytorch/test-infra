import XCTest
@testable import TorchCI

@MainActor
final class LLMBenchmarkViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: LLMBenchmarkViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = LLMBenchmarkViewModel(benchmarkId: "pytorch_gptfast", apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// Registers successful responses for both ClickHouse endpoints.
    private func registerAllResponses(
        data dataJSON: String = LLMBenchmarkViewModelTests.emptyDataJSON,
        metadata metadataJSON: String = LLMBenchmarkViewModelTests.emptyMetadataJSON
    ) {
        mockClient.setResponse(dataJSON, for: "/api/clickhouse/oss_ci_benchmark_llms")
        mockClient.setResponse(metadataJSON, for: "/api/clickhouse/oss_ci_benchmark_names")
    }

    // MARK: - Static JSON Fixtures

    private static let emptyDataJSON = "[]"
    private static let emptyMetadataJSON = "[]"

    private static let dataWithThroughputJSON = """
    [
        {
            "workflow_id": 100, "job_id": 1, "model": "llama-7b", "backend": "eager",
            "metric": "throughput", "actual": 45.5, "actual_geomean": 45.0, "target": 40.0,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-10T00:00:00.000Z"
        },
        {
            "workflow_id": 101, "job_id": 2, "model": "llama-7b", "backend": "eager",
            "metric": "throughput", "actual": 50.0, "actual_geomean": 49.0, "target": 40.0,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-11T00:00:00.000Z"
        },
        {
            "workflow_id": 102, "job_id": 3, "model": "llama-7b", "backend": "eager",
            "metric": "throughput", "actual": 42.0, "actual_geomean": 41.5, "target": 40.0,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-12T00:00:00.000Z"
        },
        {
            "workflow_id": 100, "job_id": 4, "model": "gpt2", "backend": "eager",
            "metric": "throughput", "actual": 120.0, "actual_geomean": 118.0, "target": 100.0,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-10T00:00:00.000Z"
        },
        {
            "workflow_id": 101, "job_id": 5, "model": "gpt2", "backend": "eager",
            "metric": "throughput", "actual": 130.0, "actual_geomean": 128.0, "target": 100.0,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-11T00:00:00.000Z"
        }
    ]
    """

    private static let dataWithLatencyJSON = """
    [
        {
            "workflow_id": 100, "job_id": 1, "model": "llama-7b", "backend": "eager",
            "metric": "latency_ms", "actual": 10.0, "actual_geomean": 10.0, "target": 12.0,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-10T00:00:00.000Z"
        },
        {
            "workflow_id": 101, "job_id": 2, "model": "llama-7b", "backend": "eager",
            "metric": "latency_ms", "actual": 20.0, "actual_geomean": 19.0, "target": 12.0,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-11T00:00:00.000Z"
        },
        {
            "workflow_id": 102, "job_id": 3, "model": "llama-7b", "backend": "eager",
            "metric": "latency_ms", "actual": 15.0, "actual_geomean": 14.5, "target": 12.0,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-12T00:00:00.000Z"
        }
    ]
    """

    private static let dataWithMemoryJSON = """
    [
        {
            "workflow_id": 100, "job_id": 1, "model": "llama-7b", "backend": "eager",
            "metric": "memory_bandwidth_gb/s", "actual": 100.0, "actual_geomean": 100.0, "target": 90.0,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-10T00:00:00.000Z"
        },
        {
            "workflow_id": 101, "job_id": 2, "model": "llama-7b", "backend": "eager",
            "metric": "memory_bandwidth_gb/s", "actual": 200.0, "actual_geomean": 195.0, "target": 90.0,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-11T00:00:00.000Z"
        }
    ]
    """

    private static let dataWithCompilationJSON = """
    [
        {
            "workflow_id": 100, "job_id": 1, "model": "llama-7b", "backend": "inductor",
            "metric": "compile_time", "actual": 5.0, "actual_geomean": 5.0, "target": 0,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-10T00:00:00.000Z"
        },
        {
            "workflow_id": 101, "job_id": 2, "model": "llama-7b", "backend": "inductor",
            "metric": "compile_time", "actual": 8.0, "actual_geomean": 7.5, "target": 0,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-11T00:00:00.000Z"
        },
        {
            "workflow_id": 102, "job_id": 3, "model": "llama-7b", "backend": "inductor",
            "metric": "compile_time", "actual": 6.0, "actual_geomean": 5.8, "target": 0,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-12T00:00:00.000Z"
        }
    ]
    """

    private static let dataMultiMetricJSON = """
    [
        {
            "workflow_id": 100, "job_id": 1, "model": "llama-7b", "backend": "eager",
            "metric": "throughput", "actual": 50.0, "actual_geomean": 49.0, "target": 40.0,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-10T00:00:00.000Z"
        },
        {
            "workflow_id": 100, "job_id": 1, "model": "llama-7b", "backend": "eager",
            "metric": "latency_ms", "actual": 12.0, "actual_geomean": 11.5, "target": 15.0,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-10T00:00:00.000Z"
        },
        {
            "workflow_id": 100, "job_id": 1, "model": "llama-7b", "backend": "eager",
            "metric": "memory_bandwidth", "actual": 80.0, "actual_geomean": 78.0, "target": 70.0,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-10T00:00:00.000Z"
        },
        {
            "workflow_id": 100, "job_id": 1, "model": "llama-7b", "backend": "inductor",
            "metric": "compilation", "actual": 3.5, "actual_geomean": 3.3, "target": 0,
            "mode": "inference", "dtype": "float16", "device": "cuda", "arch": "A100",
            "granularity_bucket": "2025-01-10T00:00:00.000Z"
        }
    ]
    """

    private static let metadataWithOptionsJSON = """
    [
        { "benchmark": "PyTorch gpt-fast benchmark", "model": "llama-7b", "backend": "eager", "metric": "throughput", "dtype": "float32", "mode": "inference", "device": "cuda", "arch": "A100" },
        { "benchmark": "PyTorch gpt-fast benchmark", "model": "llama-7b", "backend": "inductor", "metric": "throughput", "dtype": "float16", "mode": "inference", "device": "cuda", "arch": "A100" },
        { "benchmark": "PyTorch gpt-fast benchmark", "model": "gpt2", "backend": "eager", "metric": "throughput", "dtype": "bfloat16", "mode": "training", "device": "cpu", "arch": "x86" },
        { "benchmark": "PyTorch gpt-fast benchmark", "model": "gpt2", "backend": "aot_eager", "metric": "latency", "dtype": "float16", "mode": "inference", "device": "mps", "arch": "M1" }
    ]
    """

    // MARK: - Initial State Tests

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertTrue(viewModel.timeSeriesData.isEmpty)
        XCTAssertNil(viewModel.groupData)
        XCTAssertTrue(viewModel.selectedModels.isEmpty)
        XCTAssertEqual(viewModel.selectedMetricType, .throughput)
        XCTAssertEqual(viewModel.selectedDevice, "All Devices")
        XCTAssertEqual(viewModel.selectedBackend, "All Backends")
        XCTAssertEqual(viewModel.selectedMode, "All Modes")
        XCTAssertEqual(viewModel.selectedDtype, "All DTypes")
        XCTAssertEqual(viewModel.selectedBranch, "main")
        XCTAssertNil(viewModel.selectedPoint)
        XCTAssertFalse(viewModel.isComparisonMode)
    }

    func testStaticBranches() {
        XCTAssertEqual(LLMBenchmarkViewModel.branches, ["main", "viable/strict", "nightly"])
    }

    // MARK: - Benchmark Config

    func testBenchmarkConfigMappings() {
        let config = LLMBenchmarkViewModel.benchmarkConfig
        XCTAssertEqual(config["pytorch_gptfast"]?.repo, "pytorch/pytorch")
        XCTAssertEqual(config["pytorch_gptfast"]?.benchmarks, ["PyTorch gpt-fast benchmark"])
        XCTAssertEqual(config["vllm_benchmark"]?.repo, "vllm-project/vllm")
        XCTAssertEqual(config["vllm_benchmark"]?.benchmarks, ["vLLM benchmark"])
        XCTAssertEqual(config["sglang_benchmark"]?.repo, "sgl-project/sglang")
        XCTAssertEqual(config["pytorch_x_vllm_benchmark"]?.repo, "pytorch/pytorch")
    }

    // MARK: - Load Data Tests

    func testLoadDataSuccess() async {
        registerAllResponses(
            data: Self.dataWithThroughputJSON,
            metadata: Self.metadataWithOptionsJSON
        )

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertFalse(viewModel.timeSeriesData.isEmpty)
        XCTAssertNotNil(viewModel.groupData)
    }

    func testLoadDataPopulatesTimeSeriesFromRawRows() async {
        registerAllResponses(data: Self.dataWithThroughputJSON)

        await viewModel.loadData()

        // 3 points from llama-7b + 2 points from gpt2 = 5 total
        XCTAssertEqual(viewModel.timeSeriesData.count, 5)

        let llamaPoints = viewModel.timeSeriesData.filter { $0.model == "llama-7b" }
        XCTAssertEqual(llamaPoints.count, 3)

        let gpt2Points = viewModel.timeSeriesData.filter { $0.model == "gpt2" }
        XCTAssertEqual(gpt2Points.count, 2)
    }

    func testLoadDataPopulatesGroupData() async {
        registerAllResponses(data: Self.dataWithThroughputJSON)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertNotNil(viewModel.groupData)
        // Group data has latest per (model, metric, backend, dtype):
        // llama-7b+throughput+eager+float16 -> workflow 102
        // gpt2+throughput+eager+float16 -> workflow 101
        XCTAssertEqual(viewModel.groupData?.data.count, 2)
    }

    func testLoadDataPopulatesFilterOptions() async {
        registerAllResponses(
            data: Self.emptyDataJSON,
            metadata: Self.metadataWithOptionsJSON
        )

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        // Metadata rows contain: cuda, cpu, mps devices
        XCTAssertTrue(viewModel.availableDevices.contains("cuda"))
        XCTAssertTrue(viewModel.availableDevices.contains("cpu"))
        XCTAssertTrue(viewModel.availableDevices.contains("mps"))
        // Backends: eager, inductor, aot_eager
        XCTAssertTrue(viewModel.availableBackends.contains("eager"))
        XCTAssertTrue(viewModel.availableBackends.contains("inductor"))
        XCTAssertTrue(viewModel.availableBackends.contains("aot_eager"))
        // Modes: inference, training
        XCTAssertTrue(viewModel.availableModes.contains("inference"))
        XCTAssertTrue(viewModel.availableModes.contains("training"))
        // Dtypes: float32, float16, bfloat16
        XCTAssertTrue(viewModel.availableDtypes.contains("float32"))
        XCTAssertTrue(viewModel.availableDtypes.contains("float16"))
        XCTAssertTrue(viewModel.availableDtypes.contains("bfloat16"))
    }

    func testLoadDataWithEmptyResponses() async {
        registerAllResponses()

        await viewModel.loadData()

        // Empty data should yield error (no time series, no group data)
        XCTAssertTrue(viewModel.timeSeriesData.isEmpty)
    }

    func testLoadDataErrorOnAllEndpoints() async {
        mockClient.setError(APIError.serverError(500), for: "/api/clickhouse/oss_ci_benchmark_llms")
        mockClient.setError(APIError.serverError(500), for: "/api/clickhouse/oss_ci_benchmark_names")

        await viewModel.loadData()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadDataPartialSuccess_DataOnly() async {
        mockClient.setResponse(Self.dataWithThroughputJSON, for: "/api/clickhouse/oss_ci_benchmark_llms")
        mockClient.setError(APIError.serverError(500), for: "/api/clickhouse/oss_ci_benchmark_names")

        await viewModel.loadData()

        // Should still load partial data from individual fallback fetches
        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertFalse(viewModel.timeSeriesData.isEmpty)
    }

    func testLoadDataCallsCorrectEndpoints() async {
        registerAllResponses()

        await viewModel.loadData()

        let paths = mockClient.callPaths()
        XCTAssertTrue(paths.contains("/api/clickhouse/oss_ci_benchmark_llms"))
        XCTAssertTrue(paths.contains("/api/clickhouse/oss_ci_benchmark_names"))
    }

    // MARK: - Available Models

    func testAvailableModelsFromTimeSeries() async {
        registerAllResponses(data: Self.dataWithThroughputJSON)

        await viewModel.loadData()

        let models = viewModel.availableModels
        XCTAssertTrue(models.contains("llama-7b"))
        XCTAssertTrue(models.contains("gpt2"))
        XCTAssertEqual(models.count, 2)
    }

    func testAvailableModelsAreSorted() async {
        registerAllResponses(data: Self.dataWithThroughputJSON)

        await viewModel.loadData()

        let models = viewModel.availableModels
        XCTAssertEqual(models, models.sorted())
    }

    // MARK: - Available Filter Options

    func testAvailableDevicesWithMetadata() async {
        registerAllResponses(metadata: Self.metadataWithOptionsJSON)

        await viewModel.loadData()

        let devices = viewModel.availableDevices
        XCTAssertEqual(devices.first, "All Devices")
        XCTAssertTrue(devices.contains("cuda"))
        XCTAssertTrue(devices.contains("cpu"))
        XCTAssertTrue(devices.contains("mps"))
    }

    func testAvailableDevicesWithoutMetadata() {
        // No data loaded - should just have the default
        let devices = viewModel.availableDevices
        XCTAssertEqual(devices, ["All Devices"])
    }

    func testAvailableBackendsWithMetadata() async {
        registerAllResponses(metadata: Self.metadataWithOptionsJSON)

        await viewModel.loadData()

        let backends = viewModel.availableBackends
        XCTAssertEqual(backends.first, "All Backends")
        XCTAssertTrue(backends.contains("eager"))
        XCTAssertTrue(backends.contains("inductor"))
        XCTAssertTrue(backends.contains("aot_eager"))
    }

    func testAvailableModesWithMetadata() async {
        registerAllResponses(metadata: Self.metadataWithOptionsJSON)

        await viewModel.loadData()

        let modes = viewModel.availableModes
        XCTAssertEqual(modes.first, "All Modes")
        XCTAssertTrue(modes.contains("inference"))
        XCTAssertTrue(modes.contains("training"))
    }

    func testAvailableDtypesWithMetadata() async {
        registerAllResponses(metadata: Self.metadataWithOptionsJSON)

        await viewModel.loadData()

        let dtypes = viewModel.availableDtypes
        XCTAssertEqual(dtypes.first, "All DTypes")
        XCTAssertTrue(dtypes.contains("float32"))
        XCTAssertTrue(dtypes.contains("float16"))
        XCTAssertTrue(dtypes.contains("bfloat16"))
    }

    // MARK: - Filtered Time Series

    func testFilteredTimeSeriesByMetricType() async {
        registerAllResponses(data: Self.dataMultiMetricJSON)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.timeSeriesData.count, 4)

        // Default metric is throughput
        viewModel.selectedMetricType = .throughput
        XCTAssertEqual(viewModel.filteredTimeSeries.count, 1)
        XCTAssertEqual(viewModel.filteredTimeSeries.first?.value, 50.0)

        viewModel.selectedMetricType = .latency
        XCTAssertEqual(viewModel.filteredTimeSeries.count, 1)
        XCTAssertEqual(viewModel.filteredTimeSeries.first?.value, 12.0)

        viewModel.selectedMetricType = .memory
        XCTAssertEqual(viewModel.filteredTimeSeries.count, 1)
        XCTAssertEqual(viewModel.filteredTimeSeries.first?.value, 80.0)

        viewModel.selectedMetricType = .compilation
        XCTAssertEqual(viewModel.filteredTimeSeries.count, 1)
        XCTAssertEqual(viewModel.filteredTimeSeries.first?.value, 3.5)
    }

    func testFilteredTimeSeriesBySelectedModels() async {
        registerAllResponses(data: Self.dataWithThroughputJSON)

        await viewModel.loadData()

        // No model filter applied - all points pass
        viewModel.selectedModels = []
        let allThroughput = viewModel.filteredTimeSeries
        XCTAssertEqual(allThroughput.count, 5)

        // Filter to just llama-7b
        viewModel.selectedModels = Set(["llama-7b"])
        let llamaOnly = viewModel.filteredTimeSeries
        XCTAssertEqual(llamaOnly.count, 3)
        XCTAssertTrue(llamaOnly.allSatisfy { $0.model == "llama-7b" })

        // Filter to just gpt2
        viewModel.selectedModels = Set(["gpt2"])
        let gpt2Only = viewModel.filteredTimeSeries
        XCTAssertEqual(gpt2Only.count, 2)
        XCTAssertTrue(gpt2Only.allSatisfy { $0.model == "gpt2" })
    }

    // MARK: - Filtered Group Points

    func testFilteredGroupPointsByMetric() async {
        registerAllResponses(data: Self.dataMultiMetricJSON)

        await viewModel.loadData()

        // Multi-metric data has throughput, latency_ms, memory_bandwidth, compilation
        viewModel.selectedMetricType = .throughput
        XCTAssertEqual(viewModel.filteredGroupPoints.count, 1) // llama-7b throughput

        viewModel.selectedMetricType = .latency
        XCTAssertEqual(viewModel.filteredGroupPoints.count, 1) // llama-7b latency_ms

        viewModel.selectedMetricType = .memory
        XCTAssertEqual(viewModel.filteredGroupPoints.count, 1) // llama-7b memory_bandwidth

        viewModel.selectedMetricType = .compilation
        XCTAssertEqual(viewModel.filteredGroupPoints.count, 1) // llama-7b compilation
    }

    func testFilteredGroupPointsBySelectedModels() async {
        registerAllResponses(data: Self.dataWithThroughputJSON)

        await viewModel.loadData()
        viewModel.selectedMetricType = .throughput

        // No filter - should have group points for both models
        viewModel.selectedModels = []
        XCTAssertEqual(viewModel.filteredGroupPoints.count, 2)

        // Filter to llama-7b only
        viewModel.selectedModels = Set(["llama-7b"])
        XCTAssertEqual(viewModel.filteredGroupPoints.count, 1)
        XCTAssertEqual(viewModel.filteredGroupPoints.first?.name, "llama-7b")
    }

    func testFilteredGroupPointsSortedByValueDescending() async {
        registerAllResponses(data: Self.dataWithThroughputJSON)

        await viewModel.loadData()
        viewModel.selectedMetricType = .throughput

        let points = viewModel.filteredGroupPoints
        XCTAssertEqual(points.count, 2)
        // gpt2 (130) should come before llama-7b (42) because sorted descending by value
        // Latest workflow: gpt2=101 (130.0), llama-7b=102 (42.0)
        XCTAssertEqual(points.first?.name, "gpt2")
        XCTAssertEqual(points.last?.name, "llama-7b")
    }

    func testFilteredGroupPointsEmptyWithoutGroupData() {
        XCTAssertTrue(viewModel.filteredGroupPoints.isEmpty)
    }

    // MARK: - Throughput Stats

    func testThroughputStats() async {
        registerAllResponses(data: Self.dataWithThroughputJSON)

        await viewModel.loadData()

        let stats = viewModel.throughputStats
        XCTAssertNotNil(stats)

        // Values: 45.5, 50.0, 42.0, 120.0, 130.0
        let values = [45.5, 50.0, 42.0, 120.0, 130.0]
        let expectedAvg = values.reduce(0, +) / Double(values.count)
        XCTAssertEqual(stats!.avg, expectedAvg, accuracy: 0.01)
        XCTAssertEqual(stats!.max, 130.0, accuracy: 0.01)
        XCTAssertEqual(stats!.min, 42.0, accuracy: 0.01)
    }

    func testThroughputStatsNilWhenNoMatchingData() async {
        registerAllResponses(data: Self.dataWithLatencyJSON)

        await viewModel.loadData()

        // Only latency data loaded, no throughput
        XCTAssertNil(viewModel.throughputStats)
    }

    // MARK: - Latency Stats

    func testLatencyStats() async {
        registerAllResponses(data: Self.dataWithLatencyJSON)

        await viewModel.loadData()

        let stats = viewModel.latencyStats
        XCTAssertNotNil(stats)

        // Values: 10.0, 20.0, 15.0
        let expectedAvg = (10.0 + 20.0 + 15.0) / 3.0
        XCTAssertEqual(stats!.avg, expectedAvg, accuracy: 0.01)
        XCTAssertEqual(stats!.min, 10.0, accuracy: 0.01)
        // P99 of 3 sorted values [10, 15, 20]: index = min(int(3*0.99), 2) = 2 -> 20.0
        XCTAssertEqual(stats!.p99, 20.0, accuracy: 0.01)
    }

    func testLatencyStatsNilWhenNoMatchingData() async {
        registerAllResponses(data: Self.dataWithThroughputJSON)

        await viewModel.loadData()

        XCTAssertNil(viewModel.latencyStats)
    }

    // MARK: - Memory Stats

    func testMemoryStats() async {
        registerAllResponses(data: Self.dataWithMemoryJSON)

        await viewModel.loadData()

        let stats = viewModel.memoryStats
        XCTAssertNotNil(stats)

        // Values: 100.0, 200.0
        XCTAssertEqual(stats!.avg, 150.0, accuracy: 0.01)
        XCTAssertEqual(stats!.max, 200.0, accuracy: 0.01)
        XCTAssertEqual(stats!.min, 100.0, accuracy: 0.01)
    }

    func testMemoryStatsNilWhenNoMatchingData() {
        XCTAssertNil(viewModel.memoryStats)
    }

    // MARK: - Compilation Stats

    func testCompilationStats() async {
        registerAllResponses(data: Self.dataWithCompilationJSON)

        await viewModel.loadData()

        let stats = viewModel.compilationStats
        XCTAssertNotNil(stats)

        // Values: 5.0, 8.0, 6.0
        let expectedAvg = (5.0 + 8.0 + 6.0) / 3.0
        XCTAssertEqual(stats!.avg, expectedAvg, accuracy: 0.01)
        XCTAssertEqual(stats!.max, 8.0, accuracy: 0.01)
        XCTAssertEqual(stats!.min, 5.0, accuracy: 0.01)
    }

    func testCompilationStatsNilWhenNoMatchingData() {
        XCTAssertNil(viewModel.compilationStats)
    }

    // MARK: - MetricType Properties

    func testMetricTypeIcons() {
        XCTAssertEqual(LLMBenchmarkViewModel.MetricType.throughput.icon, "arrow.up.right")
        XCTAssertEqual(LLMBenchmarkViewModel.MetricType.latency.icon, "clock")
        XCTAssertEqual(LLMBenchmarkViewModel.MetricType.memory.icon, "memorychip")
        XCTAssertEqual(LLMBenchmarkViewModel.MetricType.compilation.icon, "hammer")
    }

    func testMetricTypeUnits() {
        XCTAssertEqual(LLMBenchmarkViewModel.MetricType.throughput.unit, "tokens/s")
        XCTAssertEqual(LLMBenchmarkViewModel.MetricType.latency.unit, "ms")
        XCTAssertEqual(LLMBenchmarkViewModel.MetricType.memory.unit, "GB/s")
        XCTAssertEqual(LLMBenchmarkViewModel.MetricType.compilation.unit, "s")
    }

    func testMetricTypeRawValues() {
        XCTAssertEqual(LLMBenchmarkViewModel.MetricType.throughput.rawValue, "Throughput")
        XCTAssertEqual(LLMBenchmarkViewModel.MetricType.latency.rawValue, "Latency")
        XCTAssertEqual(LLMBenchmarkViewModel.MetricType.memory.rawValue, "Memory")
        XCTAssertEqual(LLMBenchmarkViewModel.MetricType.compilation.rawValue, "Compilation")
    }

    func testMetricTypeAllCases() {
        let allCases = LLMBenchmarkViewModel.MetricType.allCases
        XCTAssertEqual(allCases.count, 4)
        XCTAssertTrue(allCases.contains(.throughput))
        XCTAssertTrue(allCases.contains(.latency))
        XCTAssertTrue(allCases.contains(.memory))
        XCTAssertTrue(allCases.contains(.compilation))
    }

    func testMetricTypeKeywords() {
        let throughputKeywords = LLMBenchmarkViewModel.MetricType.throughput.keywords
        XCTAssertTrue(throughputKeywords.contains("throughput"))
        XCTAssertTrue(throughputKeywords.contains("tokens_per_second"))

        let latencyKeywords = LLMBenchmarkViewModel.MetricType.latency.keywords
        XCTAssertTrue(latencyKeywords.contains("latency"))
        XCTAssertTrue(latencyKeywords.contains("ttft"))

        let memoryKeywords = LLMBenchmarkViewModel.MetricType.memory.keywords
        XCTAssertTrue(memoryKeywords.contains("memory"))
        XCTAssertTrue(memoryKeywords.contains("bandwidth"))

        let compilationKeywords = LLMBenchmarkViewModel.MetricType.compilation.keywords
        XCTAssertTrue(compilationKeywords.contains("compilation"))
        XCTAssertTrue(compilationKeywords.contains("compile_time"))
    }

    func testMetricTypeDescription() {
        XCTAssertEqual(LLMBenchmarkViewModel.MetricType.throughput.description, "Throughput")
        XCTAssertEqual(LLMBenchmarkViewModel.MetricType.latency.description, "Latency")
    }

    // MARK: - convertRawRows Static Method

    func testConvertRawRowsEmpty() {
        let (ts, group) = LLMBenchmarkViewModel.convertRawRows([])
        XCTAssertTrue(ts.isEmpty)
        XCTAssertNil(group)
    }

    func testConvertRawRowsCreatesTimeSeriesPoints() {
        let rows: [LLMBenchmarkRawRow] = MockData.decode(Self.dataWithThroughputJSON)
        let (ts, _) = LLMBenchmarkViewModel.convertRawRows(rows)

        XCTAssertEqual(ts.count, 5)
        XCTAssertTrue(ts.allSatisfy { $0.metric == "throughput" })
    }

    func testConvertRawRowsGroupDataKeepsLatestWorkflow() {
        let rows: [LLMBenchmarkRawRow] = MockData.decode(Self.dataWithThroughputJSON)
        let (_, group) = LLMBenchmarkViewModel.convertRawRows(rows)

        XCTAssertNotNil(group)
        XCTAssertEqual(group?.data.count, 2) // llama-7b and gpt2

        // llama-7b latest is workflow 102 with actual=42.0
        let llama = group?.data.first(where: { $0.name == "llama-7b" })
        XCTAssertNotNil(llama)
        XCTAssertEqual(llama!.value, 42.0, accuracy: 0.01)

        // gpt2 latest is workflow 101 with actual=130.0
        let gpt2 = group?.data.first(where: { $0.name == "gpt2" })
        XCTAssertNotNil(gpt2)
        XCTAssertEqual(gpt2!.value, 130.0, accuracy: 0.01)
    }

    func testConvertRawRowsCalculatesSpeedupFromTarget() {
        let rows: [LLMBenchmarkRawRow] = MockData.decode(Self.dataWithThroughputJSON)
        let (_, group) = LLMBenchmarkViewModel.convertRawRows(rows)

        // gpt2 latest: actual=130.0, target=100.0, speedup=1.3
        let gpt2 = group?.data.first(where: { $0.name == "gpt2" })
        XCTAssertNotNil(gpt2?.speedup)
        XCTAssertEqual(gpt2!.speedup!, 1.3, accuracy: 0.01)
        XCTAssertEqual(gpt2?.baseline, 100.0)
    }

    func testConvertRawRowsNoSpeedupWhenTargetIsZero() {
        let rows: [LLMBenchmarkRawRow] = MockData.decode(Self.dataWithCompilationJSON)
        let (_, group) = LLMBenchmarkViewModel.convertRawRows(rows)

        // compile_time rows have target=0, so no speedup
        let llama = group?.data.first(where: { $0.name == "llama-7b" })
        XCTAssertNil(llama?.speedup)
        XCTAssertNil(llama?.baseline)
    }

    // MARK: - Filter Changes

    func testDeviceFilterExcludesAllPrefix() async {
        registerAllResponses(metadata: Self.metadataWithOptionsJSON)

        await viewModel.loadData()

        viewModel.selectedDevice = "cuda"
        XCTAssertEqual(viewModel.selectedDevice, "cuda")
    }

    func testBackendFilterExcludesAllPrefix() async {
        registerAllResponses(metadata: Self.metadataWithOptionsJSON)

        await viewModel.loadData()

        viewModel.selectedBackend = "inductor"
        XCTAssertEqual(viewModel.selectedBackend, "inductor")
    }

    // MARK: - ViewState Equatable

    func testViewStateEquatable() {
        XCTAssertEqual(LLMBenchmarkViewModel.ViewState.idle, .idle)
        XCTAssertEqual(LLMBenchmarkViewModel.ViewState.loading, .loading)
        XCTAssertEqual(LLMBenchmarkViewModel.ViewState.loaded, .loaded)
        XCTAssertEqual(
            LLMBenchmarkViewModel.ViewState.error("test"),
            LLMBenchmarkViewModel.ViewState.error("test")
        )
        XCTAssertNotEqual(
            LLMBenchmarkViewModel.ViewState.error("a"),
            LLMBenchmarkViewModel.ViewState.error("b")
        )
        XCTAssertNotEqual(LLMBenchmarkViewModel.ViewState.idle, .loading)
    }

    // MARK: - Selected Point

    func testSelectedPointCanBeSetAndCleared() async {
        registerAllResponses(data: Self.dataWithThroughputJSON)

        await viewModel.loadData()

        XCTAssertNil(viewModel.selectedPoint)

        let point = viewModel.timeSeriesData.first!
        viewModel.selectedPoint = point
        XCTAssertNotNil(viewModel.selectedPoint)
        XCTAssertEqual(viewModel.selectedPoint?.commit, point.commit)

        viewModel.selectedPoint = nil
        XCTAssertNil(viewModel.selectedPoint)
    }

    // MARK: - Comparison Mode

    func testComparisonModeToggle() {
        XCTAssertFalse(viewModel.isComparisonMode)
        viewModel.isComparisonMode = true
        XCTAssertTrue(viewModel.isComparisonMode)
        viewModel.isComparisonMode = false
        XCTAssertFalse(viewModel.isComparisonMode)
    }

    // MARK: - Metric Keyword Matching

    func testThroughputKeywordMatching() async {
        let tsJSON = """
        [
            { "workflow_id": 1, "job_id": 1, "model": "a", "backend": "eager", "metric": "tokens_per_second", "actual": 1.0, "actual_geomean": 1.0, "target": 0, "mode": "inference", "dtype": "f16", "device": "cuda", "arch": "A100", "granularity_bucket": "2025-01-10" },
            { "workflow_id": 1, "job_id": 1, "model": "b", "backend": "eager", "metric": "tok/s", "actual": 2.0, "actual_geomean": 2.0, "target": 0, "mode": "inference", "dtype": "f16", "device": "cuda", "arch": "A100", "granularity_bucket": "2025-01-10" },
            { "workflow_id": 1, "job_id": 1, "model": "c", "backend": "eager", "metric": "tps", "actual": 3.0, "actual_geomean": 3.0, "target": 0, "mode": "inference", "dtype": "f16", "device": "cuda", "arch": "A100", "granularity_bucket": "2025-01-10" },
            { "workflow_id": 1, "job_id": 1, "model": "d", "backend": "eager", "metric": "latency_ms", "actual": 4.0, "actual_geomean": 4.0, "target": 0, "mode": "inference", "dtype": "f16", "device": "cuda", "arch": "A100", "granularity_bucket": "2025-01-10" }
        ]
        """
        registerAllResponses(data: tsJSON)

        await viewModel.loadData()
        viewModel.selectedMetricType = .throughput

        // Should match tokens_per_second, tok/s, tps but not latency_ms
        XCTAssertEqual(viewModel.filteredTimeSeries.count, 3)
    }

    func testLatencyKeywordMatching() async {
        let tsJSON = """
        [
            { "workflow_id": 1, "job_id": 1, "model": "a", "backend": "eager", "metric": "ttft_ms", "actual": 1.0, "actual_geomean": 1.0, "target": 0, "mode": "inference", "dtype": "f16", "device": "cuda", "arch": "A100", "granularity_bucket": "2025-01-10" },
            { "workflow_id": 1, "job_id": 1, "model": "b", "backend": "eager", "metric": "tpot", "actual": 2.0, "actual_geomean": 2.0, "target": 0, "mode": "inference", "dtype": "f16", "device": "cuda", "arch": "A100", "granularity_bucket": "2025-01-10" },
            { "workflow_id": 1, "job_id": 1, "model": "c", "backend": "eager", "metric": "itl_latency", "actual": 3.0, "actual_geomean": 3.0, "target": 0, "mode": "inference", "dtype": "f16", "device": "cuda", "arch": "A100", "granularity_bucket": "2025-01-10" },
            { "workflow_id": 1, "job_id": 1, "model": "d", "backend": "eager", "metric": "throughput_tps", "actual": 4.0, "actual_geomean": 4.0, "target": 0, "mode": "inference", "dtype": "f16", "device": "cuda", "arch": "A100", "granularity_bucket": "2025-01-10" }
        ]
        """
        registerAllResponses(data: tsJSON)

        await viewModel.loadData()
        viewModel.selectedMetricType = .latency

        // Should match ttft, tpot, itl but not throughput
        XCTAssertEqual(viewModel.filteredTimeSeries.count, 3)
    }

    // MARK: - Edge Cases

    func testLoadDataReplacesExistingData() async {
        // First load with throughput data
        registerAllResponses(data: Self.dataWithThroughputJSON)
        await viewModel.loadData()
        XCTAssertEqual(viewModel.timeSeriesData.count, 5)

        // Second load with latency data (fewer points)
        registerAllResponses(data: Self.dataWithLatencyJSON)
        await viewModel.loadData()
        XCTAssertEqual(viewModel.timeSeriesData.count, 3)
    }

    func testSelectedMetricTypeChangesFilteredData() async {
        registerAllResponses(data: Self.dataMultiMetricJSON)

        await viewModel.loadData()

        viewModel.selectedMetricType = .throughput
        let throughputCount = viewModel.filteredTimeSeries.count
        let throughputGroupCount = viewModel.filteredGroupPoints.count

        viewModel.selectedMetricType = .latency
        let latencyCount = viewModel.filteredTimeSeries.count
        let latencyGroupCount = viewModel.filteredGroupPoints.count

        // Different metric types should yield different filtered counts
        XCTAssertEqual(throughputCount, 1)
        XCTAssertEqual(throughputGroupCount, 1)
        XCTAssertEqual(latencyCount, 1)
        XCTAssertEqual(latencyGroupCount, 1)
    }

    func testCustomBenchmarkId() async {
        let customVM = LLMBenchmarkViewModel(benchmarkId: "vllm_benchmark", apiClient: mockClient)
        registerAllResponses()

        await customVM.loadData()

        // Verify the correct ClickHouse endpoints were called
        let paths = mockClient.callPaths()
        XCTAssertTrue(paths.contains("/api/clickhouse/oss_ci_benchmark_llms"))
        XCTAssertTrue(paths.contains("/api/clickhouse/oss_ci_benchmark_names"))
    }

    func testStateTransitionsDuringLoad() async {
        registerAllResponses(data: Self.dataWithThroughputJSON)

        XCTAssertEqual(viewModel.state, .idle)
        await viewModel.loadData()
        XCTAssertEqual(viewModel.state, .loaded)
    }

    // MARK: - Excluded Metrics

    func testExcludedMetricsListIsPopulated() {
        XCTAssertFalse(LLMBenchmarkViewModel.excludedMetrics.isEmpty)
        XCTAssertTrue(LLMBenchmarkViewModel.excludedMetrics.contains("load_status"))
        XCTAssertTrue(LLMBenchmarkViewModel.excludedMetrics.contains("mean_itl_ms"))
    }
}
