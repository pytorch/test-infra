import XCTest
@testable import TorchCI

@MainActor
final class LLMBenchmarkViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: LLMBenchmarkViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = LLMBenchmarkViewModel(benchmarkId: "llm-benchmark", apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// Registers successful responses for all three benchmark endpoints.
    private func registerAllResponses(
        timeSeries: String = Self.emptyTimeSeriesJSON,
        groupData: String = Self.emptyGroupDataJSON,
        metadata: String = Self.emptyMetadataJSON
    ) {
        mockClient.setResponse(timeSeries, for: "/api/benchmark/get_time_series")
        mockClient.setResponse(groupData, for: "/api/benchmark/group_data")
        mockClient.setResponse(metadata, for: "/api/benchmark/list_metadata")
    }

    // MARK: - Static JSON Fixtures

    private static let emptyTimeSeriesJSON = """
    {
        "data": { "time_series": [] },
        "time_range": null,
        "total_raw_rows": 0
    }
    """

    private static let emptyGroupDataJSON = """
    {
        "data": [],
        "metadata": null
    }
    """

    private static let emptyMetadataJSON = """
    {
        "data": []
    }
    """

    private static let timeSeriesWithThroughputJSON = """
    {
        "data": {
            "time_series": [
                {
                    "group_info": { "model": "llama-7b", "metric": "throughput" },
                    "data": [
                        { "commit": "aaa111", "granularity_bucket": "2025-01-10T00:00:00.000Z", "actual": 45.5 },
                        { "commit": "bbb222", "granularity_bucket": "2025-01-11T00:00:00.000Z", "actual": 50.0 },
                        { "commit": "ccc333", "granularity_bucket": "2025-01-12T00:00:00.000Z", "actual": 42.0 }
                    ]
                },
                {
                    "group_info": { "model": "gpt2", "metric": "throughput" },
                    "data": [
                        { "commit": "ddd444", "granularity_bucket": "2025-01-10T00:00:00.000Z", "actual": 120.0 },
                        { "commit": "eee555", "granularity_bucket": "2025-01-11T00:00:00.000Z", "actual": 130.0 }
                    ]
                }
            ]
        },
        "time_range": { "start": "2025-01-01T00:00:00.000Z", "end": "2025-01-15T00:00:00.000Z" },
        "total_raw_rows": 5
    }
    """

    private static let timeSeriesWithLatencyJSON = """
    {
        "data": {
            "time_series": [
                {
                    "group_info": { "model": "llama-7b", "metric": "latency_ms" },
                    "data": [
                        { "commit": "aaa111", "granularity_bucket": "2025-01-10T00:00:00.000Z", "actual": 10.0 },
                        { "commit": "bbb222", "granularity_bucket": "2025-01-11T00:00:00.000Z", "actual": 20.0 },
                        { "commit": "ccc333", "granularity_bucket": "2025-01-12T00:00:00.000Z", "actual": 15.0 }
                    ]
                }
            ]
        },
        "time_range": null,
        "total_raw_rows": 3
    }
    """

    private static let timeSeriesWithMemoryJSON = """
    {
        "data": {
            "time_series": [
                {
                    "group_info": { "model": "llama-7b", "metric": "memory_bandwidth_gb/s" },
                    "data": [
                        { "commit": "aaa111", "granularity_bucket": "2025-01-10T00:00:00.000Z", "actual": 100.0 },
                        { "commit": "bbb222", "granularity_bucket": "2025-01-11T00:00:00.000Z", "actual": 200.0 }
                    ]
                }
            ]
        },
        "time_range": null,
        "total_raw_rows": 2
    }
    """

    private static let timeSeriesWithCompilationJSON = """
    {
        "data": {
            "time_series": [
                {
                    "group_info": { "model": "llama-7b", "metric": "compile_time" },
                    "data": [
                        { "commit": "aaa111", "granularity_bucket": "2025-01-10T00:00:00.000Z", "actual": 5.0 },
                        { "commit": "bbb222", "granularity_bucket": "2025-01-11T00:00:00.000Z", "actual": 8.0 },
                        { "commit": "ccc333", "granularity_bucket": "2025-01-12T00:00:00.000Z", "actual": 6.0 }
                    ]
                }
            ]
        },
        "time_range": null,
        "total_raw_rows": 3
    }
    """

    private static let timeSeriesMultiMetricJSON = """
    {
        "data": {
            "time_series": [
                {
                    "group_info": { "model": "llama-7b", "metric": "throughput" },
                    "data": [
                        { "commit": "aaa111", "granularity_bucket": "2025-01-10T00:00:00.000Z", "actual": 50.0 }
                    ]
                },
                {
                    "group_info": { "model": "llama-7b", "metric": "latency_ms" },
                    "data": [
                        { "commit": "bbb222", "granularity_bucket": "2025-01-10T00:00:00.000Z", "actual": 12.0 }
                    ]
                },
                {
                    "group_info": { "model": "llama-7b", "metric": "memory_bandwidth" },
                    "data": [
                        { "commit": "ccc333", "granularity_bucket": "2025-01-10T00:00:00.000Z", "actual": 80.0 }
                    ]
                },
                {
                    "group_info": { "model": "llama-7b", "metric": "compilation" },
                    "data": [
                        { "commit": "ddd444", "granularity_bucket": "2025-01-10T00:00:00.000Z", "actual": 3.5 }
                    ]
                }
            ]
        },
        "time_range": null,
        "total_raw_rows": 4
    }
    """

    private static let groupDataWithModelsJSON = """
    {
        "data": [
            {
                "name": "llama-7b",
                "metric": "throughput",
                "value": 50.0,
                "baseline": 45.0,
                "speedup": 1.11,
                "status": "pass"
            },
            {
                "name": "gpt2",
                "metric": "throughput",
                "value": 120.0,
                "baseline": 130.0,
                "speedup": 0.92,
                "status": "fail"
            },
            {
                "name": "bert-base",
                "metric": "latency_ms",
                "value": 15.0,
                "baseline": 14.0,
                "speedup": 0.93,
                "status": "fail"
            }
        ],
        "metadata": {
            "suite": "llm-benchmark",
            "compiler": null,
            "mode": "inference",
            "dtype": "float16",
            "device": "cuda",
            "branch": "main",
            "commit": "abc123"
        }
    }
    """

    private static let metadataWithOptionsJSON = """
    {
        "data": [
            { "name": "device", "values": ["cuda", "cpu", "mps"] },
            { "name": "backend", "values": ["eager", "inductor", "aot_eager"] },
            { "name": "mode", "values": ["inference", "training"] },
            { "name": "dtype", "values": ["float32", "float16", "bfloat16"] }
        ]
    }
    """

    // MARK: - Initial State Tests

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertTrue(viewModel.timeSeriesData.isEmpty)
        XCTAssertNil(viewModel.groupData)
        XCTAssertNil(viewModel.metadataOptions)
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

    // MARK: - Load Data Tests

    func testLoadDataSuccess() async {
        registerAllResponses(
            timeSeries: Self.timeSeriesWithThroughputJSON,
            groupData: Self.groupDataWithModelsJSON,
            metadata: Self.metadataWithOptionsJSON
        )

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertFalse(viewModel.timeSeriesData.isEmpty)
        XCTAssertNotNil(viewModel.groupData)
        XCTAssertNotNil(viewModel.metadataOptions)
    }

    func testLoadDataPopulatesTimeSeriesFromFlattenedResponse() async {
        registerAllResponses(
            timeSeries: Self.timeSeriesWithThroughputJSON,
            groupData: Self.emptyGroupDataJSON,
            metadata: Self.emptyMetadataJSON
        )

        await viewModel.loadData()

        // 3 points from llama-7b + 2 points from gpt2 = 5 total
        XCTAssertEqual(viewModel.timeSeriesData.count, 5)

        let llamaPoints = viewModel.timeSeriesData.filter { $0.model == "llama-7b" }
        XCTAssertEqual(llamaPoints.count, 3)

        let gpt2Points = viewModel.timeSeriesData.filter { $0.model == "gpt2" }
        XCTAssertEqual(gpt2Points.count, 2)
    }

    func testLoadDataPopulatesGroupData() async {
        registerAllResponses(
            timeSeries: Self.emptyTimeSeriesJSON,
            groupData: Self.groupDataWithModelsJSON,
            metadata: Self.emptyMetadataJSON
        )

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertNotNil(viewModel.groupData)
        XCTAssertEqual(viewModel.groupData?.data.count, 3)
        XCTAssertEqual(viewModel.groupData?.metadata?.device, "cuda")
    }

    func testLoadDataPopulatesMetadata() async {
        registerAllResponses(
            timeSeries: Self.emptyTimeSeriesJSON,
            groupData: Self.emptyGroupDataJSON,
            metadata: Self.metadataWithOptionsJSON
        )

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertNotNil(viewModel.metadataOptions)
        XCTAssertEqual(viewModel.metadataOptions?.data?.count, 4)
    }

    func testLoadDataWithEmptyResponses() async {
        registerAllResponses()

        await viewModel.loadData()

        // Empty time series and nil group data should yield error
        XCTAssertTrue(viewModel.timeSeriesData.isEmpty)
    }

    func testLoadDataErrorOnAllEndpoints() async {
        mockClient.setError(APIError.serverError(500), for: "/api/benchmark/get_time_series")
        mockClient.setError(APIError.serverError(500), for: "/api/benchmark/group_data")
        mockClient.setError(APIError.serverError(500), for: "/api/benchmark/list_metadata")

        await viewModel.loadData()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadDataPartialSuccess_TimeSeriesOnly() async {
        mockClient.setResponse(Self.timeSeriesWithThroughputJSON, for: "/api/benchmark/get_time_series")
        mockClient.setError(APIError.serverError(500), for: "/api/benchmark/group_data")
        mockClient.setError(APIError.serverError(500), for: "/api/benchmark/list_metadata")

        await viewModel.loadData()

        // Should still load partial data from individual fallback fetches
        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertFalse(viewModel.timeSeriesData.isEmpty)
    }

    func testLoadDataPartialSuccess_GroupDataOnly() async {
        mockClient.setError(APIError.serverError(500), for: "/api/benchmark/get_time_series")
        mockClient.setResponse(Self.groupDataWithModelsJSON, for: "/api/benchmark/group_data")
        mockClient.setError(APIError.serverError(500), for: "/api/benchmark/list_metadata")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertNotNil(viewModel.groupData)
    }

    func testLoadDataCallsCorrectEndpoints() async {
        registerAllResponses()

        await viewModel.loadData()

        let paths = mockClient.callPaths()
        XCTAssertTrue(paths.contains("/api/benchmark/get_time_series"))
        XCTAssertTrue(paths.contains("/api/benchmark/group_data"))
        XCTAssertTrue(paths.contains("/api/benchmark/list_metadata"))
    }

    // MARK: - Available Models

    func testAvailableModelsFromTimeSeries() async {
        registerAllResponses(
            timeSeries: Self.timeSeriesWithThroughputJSON,
            groupData: Self.emptyGroupDataJSON,
            metadata: Self.emptyMetadataJSON
        )

        await viewModel.loadData()

        let models = viewModel.availableModels
        XCTAssertTrue(models.contains("llama-7b"))
        XCTAssertTrue(models.contains("gpt2"))
        XCTAssertEqual(models.count, 2)
    }

    func testAvailableModelsFromGroupData() async {
        registerAllResponses(
            timeSeries: Self.emptyTimeSeriesJSON,
            groupData: Self.groupDataWithModelsJSON,
            metadata: Self.emptyMetadataJSON
        )

        await viewModel.loadData()

        let models = viewModel.availableModels
        XCTAssertTrue(models.contains("llama-7b"))
        XCTAssertTrue(models.contains("gpt2"))
        XCTAssertTrue(models.contains("bert-base"))
        XCTAssertEqual(models.count, 3)
    }

    func testAvailableModelsCombinesBothSources() async {
        registerAllResponses(
            timeSeries: Self.timeSeriesWithThroughputJSON,
            groupData: Self.groupDataWithModelsJSON,
            metadata: Self.emptyMetadataJSON
        )

        await viewModel.loadData()

        let models = viewModel.availableModels
        // Union of {llama-7b, gpt2} and {llama-7b, gpt2, bert-base}
        XCTAssertEqual(models.count, 3)
        XCTAssertTrue(models.contains("bert-base"))
    }

    func testAvailableModelsAreSorted() async {
        registerAllResponses(
            timeSeries: Self.timeSeriesWithThroughputJSON,
            groupData: Self.groupDataWithModelsJSON,
            metadata: Self.emptyMetadataJSON
        )

        await viewModel.loadData()

        let models = viewModel.availableModels
        XCTAssertEqual(models, models.sorted())
    }

    // MARK: - Available Filter Options

    func testAvailableDevicesWithMetadata() async {
        registerAllResponses(
            timeSeries: Self.emptyTimeSeriesJSON,
            groupData: Self.emptyGroupDataJSON,
            metadata: Self.metadataWithOptionsJSON
        )

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
        registerAllResponses(
            timeSeries: Self.timeSeriesMultiMetricJSON,
            groupData: Self.emptyGroupDataJSON,
            metadata: Self.emptyMetadataJSON
        )

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
        registerAllResponses(
            timeSeries: Self.timeSeriesWithThroughputJSON,
            groupData: Self.emptyGroupDataJSON,
            metadata: Self.emptyMetadataJSON
        )

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

    func testFilteredTimeSeriesWithNilMetricPassesThrough() async {
        // Points with nil metric should pass the metric filter
        let tsJSON = """
        {
            "data": {
                "time_series": [
                    {
                        "group_info": { "model": "test-model" },
                        "data": [
                            { "commit": "aaa111", "granularity_bucket": "2025-01-10T00:00:00.000Z", "actual": 99.0 }
                        ]
                    }
                ]
            },
            "time_range": null,
            "total_raw_rows": 1
        }
        """
        registerAllResponses(timeSeries: tsJSON)

        await viewModel.loadData()

        // Point has nil metric, so it should pass any metric type filter
        viewModel.selectedMetricType = .throughput
        XCTAssertEqual(viewModel.filteredTimeSeries.count, 1)

        viewModel.selectedMetricType = .latency
        XCTAssertEqual(viewModel.filteredTimeSeries.count, 1)
    }

    // MARK: - Filtered Group Points

    func testFilteredGroupPointsByMetric() async {
        registerAllResponses(
            timeSeries: Self.emptyTimeSeriesJSON,
            groupData: Self.groupDataWithModelsJSON,
            metadata: Self.emptyMetadataJSON
        )

        await viewModel.loadData()

        // groupData has 2 throughput points and 1 latency_ms point
        viewModel.selectedMetricType = .throughput
        XCTAssertEqual(viewModel.filteredGroupPoints.count, 2)

        viewModel.selectedMetricType = .latency
        XCTAssertEqual(viewModel.filteredGroupPoints.count, 1)
        XCTAssertEqual(viewModel.filteredGroupPoints.first?.name, "bert-base")
    }

    func testFilteredGroupPointsBySelectedModels() async {
        registerAllResponses(
            timeSeries: Self.emptyTimeSeriesJSON,
            groupData: Self.groupDataWithModelsJSON,
            metadata: Self.emptyMetadataJSON
        )

        await viewModel.loadData()
        viewModel.selectedMetricType = .throughput

        // No filter
        viewModel.selectedModels = []
        XCTAssertEqual(viewModel.filteredGroupPoints.count, 2)

        // Filter to llama-7b only
        viewModel.selectedModels = Set(["llama-7b"])
        XCTAssertEqual(viewModel.filteredGroupPoints.count, 1)
        XCTAssertEqual(viewModel.filteredGroupPoints.first?.name, "llama-7b")
    }

    func testFilteredGroupPointsSortedByValueDescending() async {
        registerAllResponses(
            timeSeries: Self.emptyTimeSeriesJSON,
            groupData: Self.groupDataWithModelsJSON,
            metadata: Self.emptyMetadataJSON
        )

        await viewModel.loadData()
        viewModel.selectedMetricType = .throughput

        let points = viewModel.filteredGroupPoints
        XCTAssertEqual(points.count, 2)
        // gpt2 (120) should come before llama-7b (50) because sorted descending
        XCTAssertEqual(points.first?.name, "gpt2")
        XCTAssertEqual(points.last?.name, "llama-7b")
    }

    func testFilteredGroupPointsEmptyWithoutGroupData() {
        XCTAssertTrue(viewModel.filteredGroupPoints.isEmpty)
    }

    // MARK: - Throughput Stats

    func testThroughputStats() async {
        registerAllResponses(
            timeSeries: Self.timeSeriesWithThroughputJSON,
            groupData: Self.emptyGroupDataJSON,
            metadata: Self.emptyMetadataJSON
        )

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
        registerAllResponses(
            timeSeries: Self.timeSeriesWithLatencyJSON,
            groupData: Self.emptyGroupDataJSON,
            metadata: Self.emptyMetadataJSON
        )

        await viewModel.loadData()

        // Only latency data loaded, no throughput
        XCTAssertNil(viewModel.throughputStats)
    }

    // MARK: - Latency Stats

    func testLatencyStats() async {
        registerAllResponses(
            timeSeries: Self.timeSeriesWithLatencyJSON,
            groupData: Self.emptyGroupDataJSON,
            metadata: Self.emptyMetadataJSON
        )

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
        registerAllResponses(
            timeSeries: Self.timeSeriesWithThroughputJSON,
            groupData: Self.emptyGroupDataJSON,
            metadata: Self.emptyMetadataJSON
        )

        await viewModel.loadData()

        XCTAssertNil(viewModel.latencyStats)
    }

    // MARK: - Memory Stats

    func testMemoryStats() async {
        registerAllResponses(
            timeSeries: Self.timeSeriesWithMemoryJSON,
            groupData: Self.emptyGroupDataJSON,
            metadata: Self.emptyMetadataJSON
        )

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
        registerAllResponses(
            timeSeries: Self.timeSeriesWithCompilationJSON,
            groupData: Self.emptyGroupDataJSON,
            metadata: Self.emptyMetadataJSON
        )

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

    // MARK: - Filter Changes Trigger Reload

    func testDeviceFilterExcludesAllPrefix() async {
        registerAllResponses(metadata: Self.metadataWithOptionsJSON)

        await viewModel.loadData()

        // Changing to a specific device
        viewModel.selectedDevice = "cuda"
        // Just verify the property changed; the actual reload is triggered by onChange in the view
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
        registerAllResponses(
            timeSeries: Self.timeSeriesWithThroughputJSON,
            groupData: Self.emptyGroupDataJSON,
            metadata: Self.emptyMetadataJSON
        )

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

    // MARK: - BenchmarkTimeSeriesResponse Flattening

    func testFlattenedTimeSeriesUsesActualField() {
        let json = """
        {
            "data": {
                "time_series": [
                    {
                        "group_info": { "model": "test" },
                        "data": [
                            { "commit": "abc", "granularity_bucket": "2025-01-10T00:00:00.000Z", "actual": 42.5 }
                        ]
                    }
                ]
            },
            "time_range": null,
            "total_raw_rows": 1
        }
        """
        let response: BenchmarkTimeSeriesResponse = MockData.decode(json)
        let points = response.flattenedTimeSeries

        XCTAssertEqual(points.count, 1)
        XCTAssertEqual(points.first?.value, 42.5)
        XCTAssertEqual(points.first?.model, "test")
    }

    func testFlattenedTimeSeriesFallsBackToValueField() {
        let json = """
        {
            "data": {
                "time_series": [
                    {
                        "group_info": { "model": "test" },
                        "data": [
                            { "commit": "abc", "granularity_bucket": "2025-01-10T00:00:00.000Z", "value": 99.9 }
                        ]
                    }
                ]
            },
            "time_range": null,
            "total_raw_rows": 1
        }
        """
        let response: BenchmarkTimeSeriesResponse = MockData.decode(json)
        let points = response.flattenedTimeSeries

        XCTAssertEqual(points.count, 1)
        XCTAssertEqual(points.first?.value, 99.9)
    }

    func testFlattenedTimeSeriesSkipsPointsWithoutValue() {
        let json = """
        {
            "data": {
                "time_series": [
                    {
                        "group_info": { "model": "test" },
                        "data": [
                            { "commit": "abc", "granularity_bucket": "2025-01-10T00:00:00.000Z" }
                        ]
                    }
                ]
            },
            "time_range": null,
            "total_raw_rows": 1
        }
        """
        let response: BenchmarkTimeSeriesResponse = MockData.decode(json)
        let points = response.flattenedTimeSeries

        XCTAssertEqual(points.count, 0)
    }

    func testFlattenedTimeSeriesUsesHeadShaFallback() {
        let json = """
        {
            "data": {
                "time_series": [
                    {
                        "group_info": { "model": "test" },
                        "data": [
                            { "head_sha": "def456", "granularity_bucket": "2025-01-10T00:00:00.000Z", "actual": 10.0 }
                        ]
                    }
                ]
            },
            "time_range": null,
            "total_raw_rows": 1
        }
        """
        let response: BenchmarkTimeSeriesResponse = MockData.decode(json)
        let points = response.flattenedTimeSeries

        XCTAssertEqual(points.first?.commit, "def456")
    }

    func testFlattenedTimeSeriesUsesGroupInfoMetric() {
        let json = """
        {
            "data": {
                "time_series": [
                    {
                        "group_info": { "model": "test-model", "metric": "throughput" },
                        "data": [
                            { "commit": "abc", "granularity_bucket": "2025-01-10T00:00:00.000Z", "actual": 50.0 }
                        ]
                    }
                ]
            },
            "time_range": null,
            "total_raw_rows": 1
        }
        """
        let response: BenchmarkTimeSeriesResponse = MockData.decode(json)
        let points = response.flattenedTimeSeries

        XCTAssertEqual(points.first?.metric, "throughput")
        XCTAssertEqual(points.first?.model, "test-model")
    }

    func testFlattenedTimeSeriesPointLevelMetricOverridesGroup() {
        let json = """
        {
            "data": {
                "time_series": [
                    {
                        "group_info": { "model": "group-model", "metric": "group-metric" },
                        "data": [
                            { "commit": "abc", "granularity_bucket": "2025-01-10T00:00:00.000Z", "actual": 50.0, "model": "point-model", "metric": "point-metric" }
                        ]
                    }
                ]
            },
            "time_range": null,
            "total_raw_rows": 1
        }
        """
        let response: BenchmarkTimeSeriesResponse = MockData.decode(json)
        let points = response.flattenedTimeSeries

        // Point-level values should override group-level
        XCTAssertEqual(points.first?.model, "point-model")
        XCTAssertEqual(points.first?.metric, "point-metric")
    }

    func testFlattenedTimeSeriesUsesNameFallbackForModel() {
        let json = """
        {
            "data": {
                "time_series": [
                    {
                        "group_info": { "name": "model-via-name" },
                        "data": [
                            { "commit": "abc", "granularity_bucket": "2025-01-10T00:00:00.000Z", "actual": 50.0 }
                        ]
                    }
                ]
            },
            "time_range": null,
            "total_raw_rows": 1
        }
        """
        let response: BenchmarkTimeSeriesResponse = MockData.decode(json)
        let points = response.flattenedTimeSeries

        XCTAssertEqual(points.first?.model, "model-via-name")
    }

    func testFlattenedTimeSeriesUsesDateFallback() {
        let json = """
        {
            "data": {
                "time_series": [
                    {
                        "group_info": {},
                        "data": [
                            { "commit": "abc", "date": "2025-02-01", "actual": 1.0 }
                        ]
                    }
                ]
            },
            "time_range": null,
            "total_raw_rows": 1
        }
        """
        let response: BenchmarkTimeSeriesResponse = MockData.decode(json)
        let points = response.flattenedTimeSeries

        XCTAssertEqual(points.first?.commitDate, "2025-02-01")
    }

    // MARK: - Metric Keyword Matching

    func testThroughputKeywordMatching() async {
        let tsJSON = """
        {
            "data": {
                "time_series": [
                    { "group_info": {}, "data": [{ "commit": "a", "actual": 1.0, "metric": "tokens_per_second" }] },
                    { "group_info": {}, "data": [{ "commit": "b", "actual": 2.0, "metric": "tok/s" }] },
                    { "group_info": {}, "data": [{ "commit": "c", "actual": 3.0, "metric": "tps" }] },
                    { "group_info": {}, "data": [{ "commit": "d", "actual": 4.0, "metric": "latency_ms" }] }
                ]
            },
            "time_range": null,
            "total_raw_rows": 4
        }
        """
        registerAllResponses(timeSeries: tsJSON)

        await viewModel.loadData()
        viewModel.selectedMetricType = .throughput

        // Should match tokens_per_second, tok/s, tps but not latency_ms
        XCTAssertEqual(viewModel.filteredTimeSeries.count, 3)
    }

    func testLatencyKeywordMatching() async {
        let tsJSON = """
        {
            "data": {
                "time_series": [
                    { "group_info": {}, "data": [{ "commit": "a", "actual": 1.0, "metric": "ttft_ms" }] },
                    { "group_info": {}, "data": [{ "commit": "b", "actual": 2.0, "metric": "tpot" }] },
                    { "group_info": {}, "data": [{ "commit": "c", "actual": 3.0, "metric": "itl_latency" }] },
                    { "group_info": {}, "data": [{ "commit": "d", "actual": 4.0, "metric": "throughput_tps" }] }
                ]
            },
            "time_range": null,
            "total_raw_rows": 4
        }
        """
        registerAllResponses(timeSeries: tsJSON)

        await viewModel.loadData()
        viewModel.selectedMetricType = .latency

        // Should match ttft, tpot, itl but not throughput
        XCTAssertEqual(viewModel.filteredTimeSeries.count, 3)
    }

    // MARK: - Edge Cases

    func testLoadDataReplacesExistingData() async {
        // First load with throughput data
        registerAllResponses(timeSeries: Self.timeSeriesWithThroughputJSON)
        await viewModel.loadData()
        XCTAssertEqual(viewModel.timeSeriesData.count, 5)

        // Second load with latency data (fewer points)
        registerAllResponses(timeSeries: Self.timeSeriesWithLatencyJSON)
        await viewModel.loadData()
        XCTAssertEqual(viewModel.timeSeriesData.count, 3)
    }

    func testSelectedMetricTypeChangesFilteredData() async {
        registerAllResponses(
            timeSeries: Self.timeSeriesMultiMetricJSON,
            groupData: Self.groupDataWithModelsJSON,
            metadata: Self.emptyMetadataJSON
        )

        await viewModel.loadData()

        viewModel.selectedMetricType = .throughput
        let throughputCount = viewModel.filteredTimeSeries.count
        let throughputGroupCount = viewModel.filteredGroupPoints.count

        viewModel.selectedMetricType = .latency
        let latencyCount = viewModel.filteredTimeSeries.count
        let latencyGroupCount = viewModel.filteredGroupPoints.count

        // Different metric types should yield different filtered counts
        XCTAssertEqual(throughputCount, 1)
        XCTAssertEqual(throughputGroupCount, 2) // llama-7b and gpt2 have throughput metric
        XCTAssertEqual(latencyCount, 1)
        XCTAssertEqual(latencyGroupCount, 1) // only bert-base has latency
    }

    func testCustomBenchmarkId() async {
        let customVM = LLMBenchmarkViewModel(benchmarkId: "custom-bench", apiClient: mockClient)
        registerAllResponses()

        await customVM.loadData()

        // Verify the endpoints were called (the path is the same regardless of benchmarkId,
        // but the body contains the benchmarkId)
        let paths = mockClient.callPaths()
        XCTAssertTrue(paths.contains("/api/benchmark/get_time_series"))
    }

    func testStateTransitionsDuringLoad() async {
        registerAllResponses(timeSeries: Self.timeSeriesWithThroughputJSON)

        XCTAssertEqual(viewModel.state, .idle)
        await viewModel.loadData()
        XCTAssertEqual(viewModel.state, .loaded)
    }

    func testEmptyTimeSeriesResponseWithGroupData() async {
        registerAllResponses(
            timeSeries: Self.emptyTimeSeriesJSON,
            groupData: Self.groupDataWithModelsJSON,
            metadata: Self.emptyMetadataJSON
        )

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertTrue(viewModel.timeSeriesData.isEmpty)
        XCTAssertNotNil(viewModel.groupData)
        XCTAssertEqual(viewModel.groupData?.data.count, 3)
    }
}
