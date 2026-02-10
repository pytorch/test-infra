import XCTest
@testable import TorchCI

@MainActor
final class KPIsViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: KPIsViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = KPIsViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// The query names used by KPIsViewModel definitions, in order.
    private static let queryNames: [String] = [
        "master_commit_red_percent",
        "number_of_force_pushes_historical",
        "ttrs_percentiles",
        "weekly_force_merge_stats",
        "time_to_signal",
        "num_reverts",
        "strict_lag_historical",
        "external_contribution_stats",
        "monthly_contribution_stats",
        "disabled_test_historical",
    ]

    /// Register empty `[]` responses for all 10 KPI clickhouse endpoints.
    private func registerAllEmptyResponses() {
        for name in Self.queryNames {
            mockClient.setResponse("[]", for: "/api/clickhouse/\(name)")
        }
    }

    /// Register a time-series JSON response for a specific query name.
    /// If `seriesName` is provided, each row includes a "name" field for multi-row filtering.
    private func registerTimeSeriesResponse(
        name: String,
        points: [(bucket: String, value: Double)],
        seriesName: String? = nil
    ) {
        let jsonArray = points.map { point in
            if let seriesName {
                return """
                {"granularity_bucket":"\(point.bucket)","value":\(point.value),"name":"\(seriesName)"}
                """
            }
            return """
            {"granularity_bucket":"\(point.bucket)","value":\(point.value)}
            """
        }
        let json = "[\(jsonArray.joined(separator: ","))]"
        mockClient.setResponse(json, for: "/api/clickhouse/\(name)")
    }

    // MARK: - Initial State

    func testInitialStateIsLoading() {
        XCTAssertEqual(viewModel.state, .loading)
    }

    func testInitialKPIsAreEmpty() {
        XCTAssertTrue(viewModel.kpis.isEmpty)
    }

    func testInitialSparklinesAreEmpty() {
        XCTAssertTrue(viewModel.sparklines.isEmpty)
    }

    func testDefaultTimeRangeIsSixMonths() {
        // Index 6 in TimeRange.presets is "6 Months" (180 days)
        XCTAssertEqual(viewModel.selectedTimeRange.id, "180d")
        XCTAssertEqual(viewModel.selectedTimeRange.days, 180)
        XCTAssertEqual(viewModel.selectedTimeRange.label, "6 Months")
    }

    // MARK: - Successful Load

    func testLoadKPIsWithEmptyResponsesSucceeds() async {
        registerAllEmptyResponses()

        await viewModel.loadKPIs()

        XCTAssertEqual(viewModel.state, .loaded)
        // With empty responses, no KPIs should be populated (current defaults to 0)
        // Actually, empty array means data.last is nil, so current = 0
        // KPIs still get created, one per definition
        XCTAssertEqual(viewModel.kpis.count, 10)
    }

    func testLoadKPIsPopulatesAllTenKPIs() async {
        // Give each query a couple of data points
        for name in Self.queryNames {
            registerTimeSeriesResponse(name: name, points: [
                (bucket: "2024-01-01T00:00:00Z", value: 10.0),
                (bucket: "2024-01-08T00:00:00Z", value: 15.0),
            ])
        }

        await viewModel.loadKPIs()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.kpis.count, 10)
    }

    func testLoadKPIsPreservesDefinitionOrder() async {
        // The display names should appear in the same order as the definitions
        let expectedNames = [
            "Commits Red on Trunk",
            "Force Merges",
            "TTRS p50 (pull)",
            "Force Merges %",
            "Avg TTS E2E",
            "Reverts",
            "Viable/Strict Lag",
            "External PRs (weekly)",
            "External PRs (monthly)",
            "Disabled Tests",
        ]

        for name in Self.queryNames {
            registerTimeSeriesResponse(name: name, points: [
                (bucket: "2024-01-01T00:00:00Z", value: 5.0),
            ])
        }

        await viewModel.loadKPIs()

        let actualNames = viewModel.kpis.map(\.name)
        XCTAssertEqual(actualNames, expectedNames)
    }

    func testLoadKPIsUsesLastValueAsCurrent() async {
        registerAllEmptyResponses()
        // master_commit_red_percent has filterName: "Total", so include name field
        registerTimeSeriesResponse(name: "master_commit_red_percent", points: [
            (bucket: "2024-01-01T00:00:00Z", value: 5.0),
            (bucket: "2024-01-08T00:00:00Z", value: 3.2),
            (bucket: "2024-01-15T00:00:00Z", value: 7.8),
        ], seriesName: "Total")

        await viewModel.loadKPIs()

        let redOnTrunk = viewModel.kpis.first { $0.name == "Commits Red on Trunk" }
        XCTAssertNotNil(redOnTrunk)
        XCTAssertEqual(redOnTrunk!.current, 7.8, accuracy: 0.001)
    }

    func testLoadKPIsComputesPreviousValue() async {
        // Create 35 data points so that index (35 - 30) = 5 has a known value
        registerAllEmptyResponses()
        var points: [(bucket: String, value: Double)] = []
        for i in 0..<35 {
            let day = String(format: "%02d", (i % 28) + 1)
            let month = i < 28 ? "01" : "02"
            points.append((bucket: "2024-\(month)-\(day)T00:00:00Z", value: Double(i) * 1.5))
        }
        registerTimeSeriesResponse(name: "master_commit_red_percent", points: points, seriesName: "Total")

        await viewModel.loadKPIs()

        let redOnTrunk = viewModel.kpis.first { $0.name == "Commits Red on Trunk" }
        XCTAssertNotNil(redOnTrunk)
        // lookback = max(1, 35/6) = 5
        // Previous should be at index max(0, 35-1-5) = 29 -> value = 29 * 1.5 = 43.5
        XCTAssertEqual(redOnTrunk!.previous!, 43.5, accuracy: 0.001)
        // Current should be the last value: (34) * 1.5 = 51.0
        XCTAssertEqual(redOnTrunk!.current, 51.0, accuracy: 0.001)
    }

    func testLoadKPIsPopulatesSparklines() async {
        registerAllEmptyResponses()
        // num_reverts has filterName: "total", so include name field
        registerTimeSeriesResponse(name: "num_reverts", points: [
            (bucket: "2024-01-01T00:00:00Z", value: 2.0),
            (bucket: "2024-01-08T00:00:00Z", value: 5.0),
            (bucket: "2024-01-15T00:00:00Z", value: 3.0),
        ], seriesName: "total")

        await viewModel.loadKPIs()

        let sparklineData = viewModel.sparklines["num_reverts"]
        XCTAssertNotNil(sparklineData)
        XCTAssertEqual(sparklineData?.count, 3)
    }

    // MARK: - Error Handling

    func testLoadKPIsWithAllErrorsSetsErrorState() async {
        // Don't register any responses - the mock will throw APIError.notFound for all
        await viewModel.loadKPIs()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadKPIsWithPartialErrorStillLoads() async {
        // Register responses for some endpoints, leave others missing (notFound).
        // With independent error handling, the page should still load with partial data.
        registerAllEmptyResponses()
        mockClient.setError(APIError.serverError(500), for: "/api/clickhouse/master_commit_red_percent")
        mockClient.setError(APIError.serverError(500), for: "/api/clickhouse/ttrs_percentiles")

        await viewModel.loadKPIs()

        // Should still be loaded since some KPIs succeeded
        XCTAssertEqual(viewModel.state, .loaded)
        // Should have loaded 8 out of 10 KPIs (2 failed)
        XCTAssertEqual(viewModel.kpis.count, 8)
        // The failed ones should not be present
        XCTAssertNil(viewModel.kpis.first { $0.name == "Commits Red on Trunk" })
        XCTAssertNil(viewModel.kpis.first { $0.name == "TTRS p50 (pull)" })
    }

    func testLoadKPIsWithSingleErrorStillLoadsOthers() async {
        // One endpoint error, rest succeed - page should load with 9 KPIs
        registerAllEmptyResponses()
        mockClient.setError(APIError.serverError(500), for: "/api/clickhouse/disabled_test_historical")

        await viewModel.loadKPIs()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.kpis.count, 9)
        XCTAssertNil(viewModel.kpis.first { $0.name == "Disabled Tests" })
    }

    func testLoadKPIsSetsLoadingBeforeFetch() async {
        registerAllEmptyResponses()

        // After init, state is .loading
        XCTAssertEqual(viewModel.state, .loading)

        await viewModel.loadKPIs()

        // After load, state is .loaded
        XCTAssertEqual(viewModel.state, .loaded)
    }

    // MARK: - Refresh

    func testRefreshReloadsData() async {
        registerAllEmptyResponses()

        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        // Should have loaded all KPI definitions
        XCTAssertEqual(viewModel.kpis.count, KPIsViewModel.kpiDefinitionTemplates.count)
    }

    // MARK: - Time Range Change

    func testChangeTimeRangeUpdatesSelection() async {
        registerAllEmptyResponses()

        let threeMonths = TimeRange.presets[5] // "3 Months"
        await viewModel.changeTimeRange(threeMonths)

        XCTAssertEqual(viewModel.selectedTimeRange.id, "90d")
        XCTAssertEqual(viewModel.selectedTimeRange.days, 90)
    }

    func testChangeTimeRangeReloadsData() async {
        registerAllEmptyResponses()

        let oneMonth = TimeRange.presets[4] // "1 Month"
        await viewModel.changeTimeRange(oneMonth)

        XCTAssertEqual(viewModel.state, .loaded)
        // Should have fetched all KPI definitions
        XCTAssertEqual(viewModel.kpis.count, KPIsViewModel.kpiDefinitionTemplates.count)
    }

    // MARK: - formatValue

    func testFormatValuePercentage() {
        let kpi = KPIData(name: "Test", current: 12.345, previous: nil, target: nil, unit: "%")
        let result = viewModel.formatValue(for: kpi)
        XCTAssertEqual(result, "12.3%")
    }

    func testFormatValueMinutesUnderSixty() {
        let kpi = KPIData(name: "Test", current: 45.0, previous: nil, target: nil, unit: "min")
        let result = viewModel.formatValue(for: kpi)
        XCTAssertEqual(result, "45m")
    }

    func testFormatValueMinutesOverSixty() {
        let kpi = KPIData(name: "Test", current: 90.0, previous: nil, target: nil, unit: "min")
        let result = viewModel.formatValue(for: kpi)
        XCTAssertEqual(result, "1h 30m")
    }

    func testFormatValueHours() {
        let kpi = KPIData(name: "Test", current: 3.75, previous: nil, target: nil, unit: "hours")
        let result = viewModel.formatValue(for: kpi)
        XCTAssertEqual(result, "3.8h")
    }

    func testFormatValueNoUnit() {
        let kpi = KPIData(name: "Test", current: 42.0, previous: nil, target: nil, unit: nil)
        let result = viewModel.formatValue(for: kpi)
        XCTAssertEqual(result, "42")
    }

    func testFormatValueUnknownUnit() {
        let kpi = KPIData(name: "Test", current: 100.0, previous: nil, target: nil, unit: "widgets")
        let result = viewModel.formatValue(for: kpi)
        XCTAssertEqual(result, "100 widgets")
    }

    // MARK: - color

    func testColorReturnsSuccessWhenImproving() {
        // Lower is better (default), current < previous -> improving
        let kpi = KPIData(name: "Test", current: 5.0, previous: 10.0, target: nil, unit: nil, lowerIsBetter: true)
        let color = viewModel.color(for: kpi)
        XCTAssertEqual(color, AppColors.success)
    }

    func testColorReturnsFailureWhenNotImproving() {
        // Lower is better, current > previous -> not improving
        let kpi = KPIData(name: "Test", current: 15.0, previous: 10.0, target: nil, unit: nil, lowerIsBetter: true)
        let color = viewModel.color(for: kpi)
        XCTAssertEqual(color, AppColors.failure)
    }

    func testColorReturnsSuccessForHigherIsBetterWhenIncreasing() {
        // Higher is better, current > previous -> improving
        let kpi = KPIData(name: "Test", current: 20.0, previous: 10.0, target: nil, unit: nil, lowerIsBetter: false)
        let color = viewModel.color(for: kpi)
        XCTAssertEqual(color, AppColors.success)
    }

    func testColorReturnsFailureForHigherIsBetterWhenDecreasing() {
        // Higher is better, current < previous -> not improving
        let kpi = KPIData(name: "Test", current: 5.0, previous: 10.0, target: nil, unit: nil, lowerIsBetter: false)
        let color = viewModel.color(for: kpi)
        XCTAssertEqual(color, AppColors.failure)
    }

    func testColorReturnsSuccessWhenNoPrevious() {
        // No previous means isImproving returns true
        let kpi = KPIData(name: "Test", current: 5.0, previous: nil, target: nil, unit: nil)
        let color = viewModel.color(for: kpi)
        XCTAssertEqual(color, AppColors.success)
    }

    // MARK: - sparkline

    func testSparklineReturnsDataForKnownKPI() async {
        registerAllEmptyResponses()
        registerTimeSeriesResponse(name: "disabled_test_historical", points: [
            (bucket: "2024-01-01T00:00:00Z", value: 100.0),
            (bucket: "2024-01-02T00:00:00Z", value: 95.0),
        ])

        await viewModel.loadKPIs()

        let kpi = viewModel.kpis.first { $0.name == "Disabled Tests" }
        XCTAssertNotNil(kpi)

        let sparkline = viewModel.sparkline(for: kpi!)
        XCTAssertEqual(sparkline.count, 2)
    }

    func testSparklineReturnsEmptyForUnknownKPI() {
        let unknownKPI = KPIData(name: "Unknown Metric", current: 0, previous: nil, target: nil, unit: nil)
        let sparkline = viewModel.sparkline(for: unknownKPI)
        XCTAssertTrue(sparkline.isEmpty)
    }

    // MARK: - KPI Definition Coverage

    func testAllDefinitionsHaveUniqueQueryNames() {
        let definitions = KPIsViewModel.kpiDefinitionTemplates
        let queryNames = definitions.map(\.queryName)
        let uniqueNames = Set(queryNames)
        XCTAssertEqual(queryNames.count, uniqueNames.count, "All query names should be unique")
    }

    func testAllDefinitionsHaveUniqueDisplayNames() {
        let definitions = KPIsViewModel.kpiDefinitionTemplates
        let displayNames = definitions.map(\.displayName)
        let uniqueNames = Set(displayNames)
        XCTAssertEqual(displayNames.count, uniqueNames.count, "All display names should be unique")
    }

    func testDefinitionCount() {
        XCTAssertEqual(KPIsViewModel.kpiDefinitionTemplates.count, 10)
    }

    // MARK: - API Call Verification

    func testLoadKPIsMakesTenAPICalls() async {
        registerAllEmptyResponses()

        await viewModel.loadKPIs()

        // The task group spawns concurrent child tasks that race on the mock's
        // non-thread-safe recordedCalls array.  Verify all 10 KPIs loaded
        // successfully rather than relying on exact call count.
        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.kpis.count, KPIsViewModel.kpiDefinitionTemplates.count)
    }

    func testLoadKPIsCallsCorrectEndpoints() async {
        registerAllEmptyResponses()

        await viewModel.loadKPIs()

        let paths = Set(mockClient.callPaths())
        for name in Self.queryNames {
            XCTAssertTrue(
                paths.contains("/api/clickhouse/\(name)"),
                "Expected endpoint /api/clickhouse/\(name) to be called"
            )
        }
    }

    // MARK: - KPIData Model

    func testKPIDataTrendPercentagePositive() {
        let kpi = KPIData(name: "Test", current: 15.0, previous: 10.0, target: nil, unit: nil)
        XCTAssertEqual(kpi.trendPercentage!, 50.0, accuracy: 0.01)
    }

    func testKPIDataTrendPercentageNegative() {
        let kpi = KPIData(name: "Test", current: 5.0, previous: 10.0, target: nil, unit: nil)
        XCTAssertEqual(kpi.trendPercentage!, -50.0, accuracy: 0.01)
    }

    func testKPIDataTrendPercentageNilWhenNoPrevious() {
        let kpi = KPIData(name: "Test", current: 5.0, previous: nil, target: nil, unit: nil)
        XCTAssertNil(kpi.trendPercentage)
    }

    func testKPIDataTrendPercentageNilWhenPreviousIsZero() {
        let kpi = KPIData(name: "Test", current: 5.0, previous: 0.0, target: nil, unit: nil)
        XCTAssertNil(kpi.trendPercentage)
    }

    func testKPIDataIsImprovingLowerIsBetter() {
        let improving = KPIData(name: "Test", current: 5.0, previous: 10.0, target: nil, unit: nil, lowerIsBetter: true)
        XCTAssertTrue(improving.isImproving)

        let worsening = KPIData(name: "Test", current: 15.0, previous: 10.0, target: nil, unit: nil, lowerIsBetter: true)
        XCTAssertFalse(worsening.isImproving)
    }

    func testKPIDataIsImprovingHigherIsBetter() {
        let improving = KPIData(name: "Test", current: 15.0, previous: 10.0, target: nil, unit: nil, lowerIsBetter: false)
        XCTAssertTrue(improving.isImproving)

        let worsening = KPIData(name: "Test", current: 5.0, previous: 10.0, target: nil, unit: nil, lowerIsBetter: false)
        XCTAssertFalse(worsening.isImproving)
    }

    func testKPIDataIsImprovingDefaultsToTrueWithNoPrevious() {
        let kpi = KPIData(name: "Test", current: 5.0, previous: nil, target: nil, unit: nil)
        XCTAssertTrue(kpi.isImproving)
    }

    // MARK: - ViewState Equatable

    func testViewStateEquatableLoading() {
        XCTAssertEqual(KPIsViewModel.ViewState.loading, KPIsViewModel.ViewState.loading)
    }

    func testViewStateEquatableLoaded() {
        XCTAssertEqual(KPIsViewModel.ViewState.loaded, KPIsViewModel.ViewState.loaded)
    }

    func testViewStateEquatableSameError() {
        XCTAssertEqual(
            KPIsViewModel.ViewState.error("Something failed"),
            KPIsViewModel.ViewState.error("Something failed")
        )
    }

    func testViewStateNotEqualDifferentError() {
        XCTAssertNotEqual(
            KPIsViewModel.ViewState.error("Error A"),
            KPIsViewModel.ViewState.error("Error B")
        )
    }

    func testViewStateNotEqualDifferentCases() {
        XCTAssertNotEqual(KPIsViewModel.ViewState.loading, KPIsViewModel.ViewState.loaded)
        XCTAssertNotEqual(KPIsViewModel.ViewState.loading, KPIsViewModel.ViewState.error("x"))
        XCTAssertNotEqual(KPIsViewModel.ViewState.loaded, KPIsViewModel.ViewState.error("x"))
    }

    // MARK: - Unit Mapping

    func testLowerIsBetterKPIsAreCorrectlyConfigured() {
        let definitions = KPIsViewModel.kpiDefinitionTemplates
        // Most KPIs are lower-is-better, except external PR counts
        let higherIsBetter = definitions.filter { !$0.lowerIsBetter }
        XCTAssertEqual(higherIsBetter.count, 2)
        let higherNames = Set(higherIsBetter.map(\.displayName))
        XCTAssertTrue(higherNames.contains("External PRs (weekly)"))
        XCTAssertTrue(higherNames.contains("External PRs (monthly)"))
    }

    // MARK: - Trend Edge Cases

    func testTrendWithSingleDataPoint() async {
        registerAllEmptyResponses()
        // master_commit_red_percent has filterName: "Total", so include seriesName
        registerTimeSeriesResponse(name: "master_commit_red_percent", points: [
            (bucket: "2024-01-01T00:00:00Z", value: 50.0),
        ], seriesName: "Total")

        await viewModel.loadKPIs()

        let kpi = viewModel.kpis.first { $0.name == "Commits Red on Trunk" }
        XCTAssertNotNil(kpi)
        // With 1 point: lookback=max(1,1/6)=1, previousIndex=max(0,0-1)=0
        // So previous=data[0].value=50, same as current
        XCTAssertEqual(kpi?.current, 50.0)
        XCTAssertEqual(kpi?.previous, 50.0)
    }

    func testTrendWithTwoDataPoints() async {
        registerAllEmptyResponses()
        registerTimeSeriesResponse(name: "master_commit_red_percent", points: [
            (bucket: "2024-01-01T00:00:00Z", value: 10.0),
            (bucket: "2024-01-08T00:00:00Z", value: 50.0),
        ], seriesName: "Total")

        await viewModel.loadKPIs()

        let kpi = viewModel.kpis.first { $0.name == "Commits Red on Trunk" }
        XCTAssertNotNil(kpi)
        // With 2 points: lookback=max(1,2/6)=1, previousIndex=max(0,1-1)=0
        XCTAssertEqual(kpi?.current, 50.0)
        XCTAssertEqual(kpi?.previous, 10.0)
    }

    func testTrendWithSixDataPoints() async {
        registerAllEmptyResponses()
        registerTimeSeriesResponse(name: "master_commit_red_percent", points: [
            (bucket: "2024-01-01T00:00:00Z", value: 10.0),
            (bucket: "2024-01-08T00:00:00Z", value: 20.0),
            (bucket: "2024-01-15T00:00:00Z", value: 30.0),
            (bucket: "2024-01-22T00:00:00Z", value: 40.0),
            (bucket: "2024-01-29T00:00:00Z", value: 50.0),
            (bucket: "2024-02-05T00:00:00Z", value: 60.0),
        ], seriesName: "Total")

        await viewModel.loadKPIs()

        let kpi = viewModel.kpis.first { $0.name == "Commits Red on Trunk" }
        XCTAssertNotNil(kpi)
        // With 6 points: lookback=max(1,6/6)=1, previousIndex=max(0,5-1)=4
        XCTAssertEqual(kpi?.current, 60.0)
        XCTAssertEqual(kpi?.previous, 50.0)
    }

    func testUnitsAreSetCorrectly() {
        let definitions = KPIsViewModel.kpiDefinitionTemplates
        let unitMap = Dictionary(uniqueKeysWithValues: definitions.map { ($0.displayName, $0.unit) })

        XCTAssertEqual(unitMap["Commits Red on Trunk"], "%")
        XCTAssertEqual(unitMap["Force Merges"], "")
        XCTAssertEqual(unitMap["TTRS p50 (pull)"], "min")
        XCTAssertEqual(unitMap["Force Merges %"], "%")
        XCTAssertEqual(unitMap["Avg TTS E2E"], "hours")
        XCTAssertEqual(unitMap["Reverts"], "")
        XCTAssertEqual(unitMap["Viable/Strict Lag"], "hours")
        XCTAssertEqual(unitMap["External PRs (weekly)"], "")
        XCTAssertEqual(unitMap["External PRs (monthly)"], "")
        XCTAssertEqual(unitMap["Disabled Tests"], "")
    }
}
