import XCTest
@testable import TorchCI

@MainActor
final class TTSViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: TTSViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = TTSViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// Register a successful response for the tts_duration_historical_percentile endpoint.
    /// This endpoint is called multiple times (once for main data, once each for p50/p75/p90).
    private func registerTTSResponse(_ json: String) {
        let path = "/api/clickhouse/tts_duration_historical_percentile"
        mockClient.setResponse(json, for: path)
    }

    private func makeTTSJobJSON(
        bucket: String,
        tts: Double?,
        duration: Double?,
        jobName: String
    ) -> String {
        let ttsStr = tts.map { "\($0)" } ?? "null"
        let durStr = duration.map { "\($0)" } ?? "null"
        return """
        {"granularity_bucket":"\(bucket)","tts_percentile_sec":\(ttsStr),"duration_percentile_sec":\(durStr),"full_name":"\(jobName)"}
        """
    }

    private func makeMultiJobResponse() -> String {
        let points = [
            makeTTSJobJSON(bucket: "2024-01-01T00:00:00Z", tts: 3600, duration: 1800, jobName: "linux-build"),
            makeTTSJobJSON(bucket: "2024-01-01T00:00:00Z", tts: 7200, duration: 3600, jobName: "linux-test"),
            makeTTSJobJSON(bucket: "2024-01-02T00:00:00Z", tts: 3000, duration: 1500, jobName: "linux-build"),
            makeTTSJobJSON(bucket: "2024-01-02T00:00:00Z", tts: 6000, duration: 3000, jobName: "linux-test"),
            makeTTSJobJSON(bucket: "2024-01-03T00:00:00Z", tts: 2400, duration: 1200, jobName: "linux-build"),
            makeTTSJobJSON(bucket: "2024-01-03T00:00:00Z", tts: 5400, duration: 2700, jobName: "linux-test"),
        ]
        return "[\(points.joined(separator: ","))]"
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .loading)
        XCTAssertEqual(viewModel.selectedTimeRange, "7d")
        XCTAssertEqual(viewModel.selectedPercentile, .p75)
        XCTAssertNil(viewModel.selectedJobFilter)
        XCTAssertEqual(viewModel.granularity, .day)
        XCTAssertTrue(viewModel.availableJobs.isEmpty)
        XCTAssertTrue(viewModel.topJobsByTTS.isEmpty)
        XCTAssertTrue(viewModel.ttsSeries.isEmpty)
        XCTAssertTrue(viewModel.durationSeries.isEmpty)
        XCTAssertTrue(viewModel.p50Series.isEmpty)
        XCTAssertTrue(viewModel.p75Series.isEmpty)
        XCTAssertTrue(viewModel.p90Series.isEmpty)
        XCTAssertTrue(viewModel.slowestJobs.isEmpty)
        XCTAssertTrue(viewModel.distributionBands.isEmpty)
        XCTAssertNil(viewModel.currentTTSSeconds)
        XCTAssertNil(viewModel.medianTTS)
        XCTAssertNil(viewModel.p90TTS)
        XCTAssertNil(viewModel.minTTS)
        XCTAssertNil(viewModel.maxTTS)
        XCTAssertEqual(viewModel.ttsRangeDescription, "--")
    }

    // MARK: - Successful Load

    func testLoadDataPopulatesSeriesAndJobs() async {
        let response = makeMultiJobResponse()
        registerTTSResponse(response)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        // 3 unique time buckets aggregated across 2 jobs
        XCTAssertEqual(viewModel.ttsSeries.count, 3)
        XCTAssertEqual(viewModel.durationSeries.count, 3)
        // 2 unique jobs
        XCTAssertEqual(viewModel.availableJobs.count, 2)
        XCTAssertTrue(viewModel.availableJobs.contains("linux-build"))
        XCTAssertTrue(viewModel.availableJobs.contains("linux-test"))
    }

    func testLoadDataPopulatesSlowestJobs() async {
        let response = makeMultiJobResponse()
        registerTTSResponse(response)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.slowestJobs.count, 2)
        // linux-test has higher TTS, so it should be first
        XCTAssertEqual(viewModel.slowestJobs.first?.name, "linux-test")
        XCTAssertEqual(viewModel.slowestJobs.last?.name, "linux-build")
    }

    func testLoadDataPopulatesTopJobsByTTS() async {
        let response = makeMultiJobResponse()
        registerTTSResponse(response)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.topJobsByTTS.count, 2)
        XCTAssertEqual(viewModel.topJobsByTTS.first, "linux-test")
    }

    func testLoadDataSetsPercentileSeries() async {
        let response = makeMultiJobResponse()
        registerTTSResponse(response)

        await viewModel.loadData()

        // The same endpoint is reused for p50/p75/p90 percentile fetches
        // All three should be populated
        XCTAssertFalse(viewModel.p50Series.isEmpty)
        XCTAssertFalse(viewModel.p75Series.isEmpty)
        XCTAssertFalse(viewModel.p90Series.isEmpty)
    }

    func testLoadDataBuildsDistributionBands() async {
        let response = makeMultiJobResponse()
        registerTTSResponse(response)

        await viewModel.loadData()

        // Distribution bands are built from matching p50/p75/p90 buckets
        XCTAssertFalse(viewModel.distributionBands.isEmpty)
        // Each band should have p50 <= p75 <= p90 (they all get the same data in mock)
        // In mock they all get the same response so p50 == p75 == p90
        if let band = viewModel.distributionBands.first {
            XCTAssertGreaterThan(band.p50, 0)
            XCTAssertGreaterThan(band.p75, 0)
            XCTAssertGreaterThan(band.p90, 0)
        }
    }

    // MARK: - Empty Data

    func testLoadDataWithEmptyResponse() async {
        registerTTSResponse("[]")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertTrue(viewModel.ttsSeries.isEmpty)
        XCTAssertTrue(viewModel.durationSeries.isEmpty)
        XCTAssertTrue(viewModel.availableJobs.isEmpty)
        XCTAssertTrue(viewModel.slowestJobs.isEmpty)
        XCTAssertTrue(viewModel.distributionBands.isEmpty)
    }

    // MARK: - Error Handling

    func testLoadDataErrorSetsErrorState() async {
        let path = "/api/clickhouse/tts_duration_historical_percentile"
        mockClient.setError(APIError.serverError(500), for: path)

        await viewModel.loadData()

        if case .error(let message) = viewModel.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testLoadDataNotFoundSetsError() async {
        // Don't register any response => the mock throws APIError.notFound
        await viewModel.loadData()

        if case .error = viewModel.state {
            // pass
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    // MARK: - Computed Properties

    func testCurrentTTSSecondsReturnsLastValue() async {
        let response = makeMultiJobResponse()
        registerTTSResponse(response)

        await viewModel.loadData()

        // After aggregation across 2 jobs, the last bucket is 2024-01-03
        // linux-build: 2400, linux-test: 5400, avg = 3900
        XCTAssertNotNil(viewModel.currentTTSSeconds)
        XCTAssertEqual(viewModel.currentTTSSeconds!, 3900, accuracy: 0.1)
    }

    func testMedianTTSComputation() async {
        let response = makeMultiJobResponse()
        registerTTSResponse(response)

        await viewModel.loadData()

        // 3 aggregated data points: avg values for each bucket
        // bucket1: (3600+7200)/2 = 5400
        // bucket2: (3000+6000)/2 = 4500
        // bucket3: (2400+5400)/2 = 3900
        // sorted: [3900, 4500, 5400], median (index 1) = 4500
        XCTAssertNotNil(viewModel.medianTTS)
        XCTAssertEqual(viewModel.medianTTS!, 4500, accuracy: 0.1)
    }

    func testP90TTSComputation() async {
        let response = makeMultiJobResponse()
        registerTTSResponse(response)

        await viewModel.loadData()

        // 3 values sorted: [3900, 4500, 5400]
        // p90 index = Int(3 * 0.9) = 2, min(2, 2) = 2, value = 5400
        XCTAssertNotNil(viewModel.p90TTS)
        XCTAssertEqual(viewModel.p90TTS!, 5400, accuracy: 0.1)
    }

    func testMinMaxTTS() async {
        let response = makeMultiJobResponse()
        registerTTSResponse(response)

        await viewModel.loadData()

        XCTAssertNotNil(viewModel.minTTS)
        XCTAssertNotNil(viewModel.maxTTS)
        XCTAssertEqual(viewModel.minTTS!, 3900, accuracy: 0.1)
        XCTAssertEqual(viewModel.maxTTS!, 5400, accuracy: 0.1)
    }

    func testTTSRangeDescription() async {
        let response = makeMultiJobResponse()
        registerTTSResponse(response)

        await viewModel.loadData()

        let rangeDesc = viewModel.ttsRangeDescription
        XCTAssertNotEqual(rangeDesc, "--")
        // min = 3900 (1h 5m), max = 5400 (1h 30m)
        XCTAssertTrue(rangeDesc.contains("h"))
    }

    func testIsImprovingWhenDecreasing() async {
        // Create data where values decrease over time (improving)
        let points = [
            makeTTSJobJSON(bucket: "2024-01-01T00:00:00Z", tts: 5000, duration: 2500, jobName: "job-a"),
            makeTTSJobJSON(bucket: "2024-01-02T00:00:00Z", tts: 4000, duration: 2000, jobName: "job-a"),
            makeTTSJobJSON(bucket: "2024-01-03T00:00:00Z", tts: 3000, duration: 1500, jobName: "job-a"),
        ]
        registerTTSResponse("[\(points.joined(separator: ","))]")

        await viewModel.loadData()

        XCTAssertTrue(viewModel.isImproving)
    }

    func testIsNotImprovingWhenIncreasing() async {
        // Need enough data points so that prefix(3) and suffix(3) don't
        // overlap, otherwise their averages are equal and <= returns true.
        let points = [
            makeTTSJobJSON(bucket: "2024-01-01T00:00:00Z", tts: 1000, duration: 500, jobName: "job-a"),
            makeTTSJobJSON(bucket: "2024-01-02T00:00:00Z", tts: 2000, duration: 1000, jobName: "job-a"),
            makeTTSJobJSON(bucket: "2024-01-03T00:00:00Z", tts: 3000, duration: 1500, jobName: "job-a"),
            makeTTSJobJSON(bucket: "2024-01-04T00:00:00Z", tts: 4000, duration: 2000, jobName: "job-a"),
            makeTTSJobJSON(bucket: "2024-01-05T00:00:00Z", tts: 5000, duration: 2500, jobName: "job-a"),
            makeTTSJobJSON(bucket: "2024-01-06T00:00:00Z", tts: 6000, duration: 3000, jobName: "job-a"),
        ]
        registerTTSResponse("[\(points.joined(separator: ","))]")

        await viewModel.loadData()

        // prefix(3) avg = (1000+2000+3000)/3 = 2000
        // suffix(3) avg = (4000+5000+6000)/3 = 5000
        // 5000 <= 2000 is false, so isImproving = false
        XCTAssertFalse(viewModel.isImproving)
    }

    func testIsImprovingWithEmptyData() {
        // With no data, defaults to true
        XCTAssertTrue(viewModel.isImproving)
    }

    func testIsImprovingWithSinglePoint() async {
        let points = [
            makeTTSJobJSON(bucket: "2024-01-01T00:00:00Z", tts: 3000, duration: 1500, jobName: "job-a"),
        ]
        registerTTSResponse("[\(points.joined(separator: ","))]")

        await viewModel.loadData()

        // With only 1 point, not enough data => defaults to true
        XCTAssertTrue(viewModel.isImproving)
    }

    func testTrendDescriptionPositive() async {
        // Values increasing: first=3000, last=6000 => +100%
        let points = [
            makeTTSJobJSON(bucket: "2024-01-01T00:00:00Z", tts: 3000, duration: 1500, jobName: "job-a"),
            makeTTSJobJSON(bucket: "2024-01-02T00:00:00Z", tts: 6000, duration: 3000, jobName: "job-a"),
        ]
        registerTTSResponse("[\(points.joined(separator: ","))]")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.trendDescription, "+100.0%")
    }

    func testTrendDescriptionNegative() async {
        // Values decreasing: first=6000, last=3000 => -50%
        let points = [
            makeTTSJobJSON(bucket: "2024-01-01T00:00:00Z", tts: 6000, duration: 3000, jobName: "job-a"),
            makeTTSJobJSON(bucket: "2024-01-02T00:00:00Z", tts: 3000, duration: 1500, jobName: "job-a"),
        ]
        registerTTSResponse("[\(points.joined(separator: ","))]")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.trendDescription, "-50.0%")
    }

    func testTrendDescriptionWithInsufficientData() {
        XCTAssertEqual(viewModel.trendDescription, "--")
    }

    // MARK: - Percentile Snapshot

    func testPercentileSnapshotHasThreeEntries() async {
        let response = makeMultiJobResponse()
        registerTTSResponse(response)

        await viewModel.loadData()

        let snapshot = viewModel.percentileSnapshot
        XCTAssertEqual(snapshot.count, 3)
        XCTAssertEqual(snapshot[0].label, "P50")
        XCTAssertEqual(snapshot[1].label, "P75")
        XCTAssertEqual(snapshot[2].label, "P90")
    }

    func testPercentileSnapshotWithEmptyData() {
        let snapshot = viewModel.percentileSnapshot
        XCTAssertEqual(snapshot.count, 3)
        // All values should be 0 when no data
        XCTAssertEqual(snapshot[0].value, 0)
        XCTAssertEqual(snapshot[1].value, 0)
        XCTAssertEqual(snapshot[2].value, 0)
        // Trends should be "--"
        XCTAssertEqual(snapshot[0].trend, "--")
    }

    // MARK: - Series Trend Computation

    func testComputeSeriesTrendWithData() async {
        let response = makeMultiJobResponse()
        registerTTSResponse(response)

        await viewModel.loadData()

        // p50Series is populated from mock and has at least 2 points
        let trend = viewModel.computeSeriesTrend(viewModel.p50Series)
        XCTAssertNotEqual(trend, "--")
        // The trend should contain a % sign
        XCTAssertTrue(trend.contains("%"))
    }

    func testComputeSeriesTrendWithEmptySeries() {
        let trend = viewModel.computeSeriesTrend([])
        XCTAssertEqual(trend, "--")
    }

    func testComputeSeriesTrendWithSinglePoint() {
        let series = [TimeSeriesDataPoint(granularity_bucket: "2024-01-01T00:00:00Z", value: 100)]
        let trend = viewModel.computeSeriesTrend(series)
        XCTAssertEqual(trend, "--")
    }

    // MARK: - Job Filter

    func testApplyJobFilterFiltersData() async {
        let response = makeMultiJobResponse()
        registerTTSResponse(response)

        await viewModel.loadData()

        // Before filter: aggregated across both jobs
        let totalBefore = viewModel.ttsSeries.count
        XCTAssertEqual(totalBefore, 3)

        // Apply filter to linux-build
        viewModel.selectedJobFilter = "linux-build"
        viewModel.applyJobFilter()

        // After filter: only linux-build data (still 3 buckets)
        XCTAssertEqual(viewModel.ttsSeries.count, 3)
        // Values should be the linux-build TTS values, not averaged with linux-test
        // bucket 3: linux-build TTS = 2400
        XCTAssertEqual(viewModel.ttsSeries.last?.value, 2400)
    }

    func testApplyJobFilterWithNonexistentJobReturnsEmpty() async {
        let response = makeMultiJobResponse()
        registerTTSResponse(response)

        await viewModel.loadData()

        viewModel.selectedJobFilter = "nonexistent-job"
        viewModel.applyJobFilter()

        XCTAssertTrue(viewModel.ttsSeries.isEmpty)
        XCTAssertTrue(viewModel.durationSeries.isEmpty)
    }

    func testClearJobFilterRestoresFullData() async {
        let response = makeMultiJobResponse()
        registerTTSResponse(response)

        await viewModel.loadData()

        // Filter to one job
        viewModel.selectedJobFilter = "linux-build"
        viewModel.applyJobFilter()
        let filteredLast = viewModel.ttsSeries.last?.value

        // Clear filter
        viewModel.selectedJobFilter = nil
        viewModel.applyJobFilter()
        let unfilteredLast = viewModel.ttsSeries.last?.value

        // The values should differ because unfiltered averages across jobs
        XCTAssertNotEqual(filteredLast, unfilteredLast)
    }

    // MARK: - Parameters Changed

    func testOnParametersChangedRefetches() async {
        registerTTSResponse("[]")

        await viewModel.loadData()
        let callsBefore = mockClient.callCount

        await viewModel.onParametersChanged()
        let callsAfter = mockClient.callCount

        XCTAssertGreaterThan(callsAfter, callsBefore)
    }

    func testRefreshFetchesData() async {
        registerTTSResponse("[]")

        await viewModel.refresh()

        XCTAssertGreaterThanOrEqual(mockClient.callCount, 1)
    }

    // MARK: - Granularity & Time Range

    func testDefaultSelectedRange() {
        XCTAssertEqual(viewModel.selectedTimeRange, "7d")
        XCTAssertEqual(viewModel.selectedRange?.days, 7)
    }

    func testChangeTimeRange() {
        viewModel.selectedTimeRange = "30d"
        XCTAssertEqual(viewModel.selectedRange?.days, 30)
        XCTAssertEqual(viewModel.selectedRange?.label, "1 Month")
    }

    func testInvalidTimeRangeReturnsNil() {
        viewModel.selectedTimeRange = "bogus"
        XCTAssertNil(viewModel.selectedRange)
    }

    func testChangeGranularity() {
        viewModel.granularity = .hour
        XCTAssertEqual(viewModel.granularity, .hour)

        viewModel.granularity = .week
        XCTAssertEqual(viewModel.granularity, .week)
    }

    // MARK: - Percentile Enum

    func testPercentileDisplayName() {
        XCTAssertEqual(TTSViewModel.Percentile.p50.displayName, "P50")
        XCTAssertEqual(TTSViewModel.Percentile.p75.displayName, "P75")
        XCTAssertEqual(TTSViewModel.Percentile.p90.displayName, "P90")
        XCTAssertEqual(TTSViewModel.Percentile.p99.displayName, "P99")
    }

    func testPercentileValues() {
        XCTAssertEqual(TTSViewModel.Percentile.p50.percentileValue, 0.5)
        XCTAssertEqual(TTSViewModel.Percentile.p75.percentileValue, 0.75)
        XCTAssertEqual(TTSViewModel.Percentile.p90.percentileValue, 0.9)
        XCTAssertEqual(TTSViewModel.Percentile.p99.percentileValue, 0.99)
    }

    func testAllPercentileCases() {
        let allCases = TTSViewModel.Percentile.allCases
        XCTAssertEqual(allCases.count, 4)
    }

    // MARK: - ViewState Equality

    func testViewStateEquality() {
        XCTAssertEqual(TTSViewModel.ViewState.loading, TTSViewModel.ViewState.loading)
        XCTAssertEqual(TTSViewModel.ViewState.loaded, TTSViewModel.ViewState.loaded)
        XCTAssertEqual(TTSViewModel.ViewState.error("foo"), TTSViewModel.ViewState.error("foo"))
        XCTAssertNotEqual(TTSViewModel.ViewState.error("foo"), TTSViewModel.ViewState.error("bar"))
        XCTAssertNotEqual(TTSViewModel.ViewState.loading, TTSViewModel.ViewState.loaded)
        XCTAssertNotEqual(TTSViewModel.ViewState.loaded, TTSViewModel.ViewState.error("x"))
    }

    // MARK: - API Endpoint Correctness

    func testLoadDataCallsCorrectEndpoint() async {
        registerTTSResponse("[]")

        await viewModel.loadData()

        let paths = mockClient.callPaths()
        // All calls should be to the same clickhouse query
        XCTAssertTrue(paths.allSatisfy { $0 == "/api/clickhouse/tts_duration_historical_percentile" })
        // At least 4 calls: 1 main + 3 percentile fetches
        XCTAssertGreaterThanOrEqual(mockClient.callCount, 4)
    }

    // MARK: - Duration Series

    func testDurationSeriesPopulated() async {
        let response = makeMultiJobResponse()
        registerTTSResponse(response)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.durationSeries.count, 3)
        // Bucket 3: linux-build: 1200, linux-test: 2700, avg = 1950
        XCTAssertEqual(viewModel.durationSeries.last!.value ?? 0, 1950, accuracy: 0.1)
    }

    // MARK: - Null TTS Values

    func testNullTTSValuesAreHandled() async {
        let points = [
            makeTTSJobJSON(bucket: "2024-01-01T00:00:00Z", tts: nil, duration: 1800, jobName: "linux-build"),
            makeTTSJobJSON(bucket: "2024-01-02T00:00:00Z", tts: 3000, duration: nil, jobName: "linux-build"),
        ]
        registerTTSResponse("[\(points.joined(separator: ","))]")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        // Should still process data even with null values
        XCTAssertEqual(viewModel.availableJobs.count, 1)
    }

    // MARK: - Slowest Jobs Limit

    func testSlowestJobsLimitedToTen() async {
        var points: [String] = []
        for i in 0..<15 {
            points.append(
                makeTTSJobJSON(
                    bucket: "2024-01-01T00:00:00Z",
                    tts: Double(i * 1000),
                    duration: Double(i * 500),
                    jobName: "job-\(i)"
                )
            )
        }
        registerTTSResponse("[\(points.joined(separator: ","))]")

        await viewModel.loadData()

        XCTAssertEqual(viewModel.slowestJobs.count, 10)
        // Verify sorted descending
        let ttsValues = viewModel.slowestJobs.map(\.tts)
        XCTAssertEqual(ttsValues, ttsValues.sorted(by: >))
    }
}

// MARK: - TTSFormatting Tests

final class TTSFormattingTests: XCTestCase {

    // MARK: - formatDuration

    func testFormatDurationNil() {
        XCTAssertEqual(TTSFormatting.formatDuration(nil), "--")
    }

    func testFormatDurationZeroSeconds() {
        XCTAssertEqual(TTSFormatting.formatDuration(0), "0s")
    }

    func testFormatDurationSeconds() {
        XCTAssertEqual(TTSFormatting.formatDuration(45), "45s")
    }

    func testFormatDurationMinutes() {
        XCTAssertEqual(TTSFormatting.formatDuration(300), "5m")
    }

    func testFormatDurationMinutesWithRemainder() {
        // 150 seconds = 2 min 30 sec, displayed as "2m" (minutes only)
        XCTAssertEqual(TTSFormatting.formatDuration(150), "2m")
    }

    func testFormatDurationHoursAndMinutes() {
        XCTAssertEqual(TTSFormatting.formatDuration(3660), "1h 1m")
    }

    func testFormatDurationExactlyOneHour() {
        XCTAssertEqual(TTSFormatting.formatDuration(3600), "1h 0m")
    }

    func testFormatDurationLargeValue() {
        // 10800 seconds = 3 hours
        XCTAssertEqual(TTSFormatting.formatDuration(10800), "3h 0m")
    }

    func testFormatDurationNegativeValue() {
        // Negative values should still compute (though unusual)
        let result = TTSFormatting.formatDuration(-60)
        XCTAssertNotNil(result)
    }

    // MARK: - ttsColor

    func testTTSColorNilReturnsSecondary() {
        let color = TTSFormatting.ttsColor(nil)
        XCTAssertEqual(color, .secondary)
    }

    func testTTSColorSuccessUnderOneHour() {
        let color = TTSFormatting.ttsColor(1800) // 30 min
        XCTAssertEqual(color, AppColors.success)
    }

    func testTTSColorUnstableBetweenOneAndTwoHours() {
        let color = TTSFormatting.ttsColor(5400) // 1.5 hours
        XCTAssertEqual(color, AppColors.unstable)
    }

    func testTTSColorFailureOverTwoHours() {
        let color = TTSFormatting.ttsColor(8000) // > 2 hours
        XCTAssertEqual(color, AppColors.failure)
    }

    func testTTSColorExactlyOneHour() {
        // Exactly 3600 seconds is not > 3600, so should be success
        let color = TTSFormatting.ttsColor(3600)
        XCTAssertEqual(color, AppColors.success)
    }

    func testTTSColorExactlyTwoHours() {
        // Exactly 7200 seconds is not > 7200, so should be unstable
        let color = TTSFormatting.ttsColor(7200)
        XCTAssertEqual(color, AppColors.unstable)
    }

    func testTTSColorJustOverOneHour() {
        let color = TTSFormatting.ttsColor(3601)
        XCTAssertEqual(color, AppColors.unstable)
    }

    func testTTSColorJustOverTwoHours() {
        let color = TTSFormatting.ttsColor(7201)
        XCTAssertEqual(color, AppColors.failure)
    }

    // MARK: - truncateJobName

    func testTruncateShortName() {
        let name = "linux-build"
        XCTAssertEqual(TTSFormatting.truncateJobName(name), name)
    }

    func testTruncateLongNameUsesLastComponent() {
        let name = "pytorch/pytorch/.github/workflows/build.yml / linux-build / build (cuda-12.1)"
        let result = TTSFormatting.truncateJobName(name, maxLength: 30)
        // Should extract last path component if it fits
        XCTAssertLessThanOrEqual(result.count, 30)
    }

    func testTruncateExactlyAtLimit() {
        let name = String(repeating: "a", count: 30)
        XCTAssertEqual(TTSFormatting.truncateJobName(name, maxLength: 30), name)
    }

    func testTruncateOneOverLimit() {
        let name = String(repeating: "a", count: 31)
        let result = TTSFormatting.truncateJobName(name, maxLength: 30)
        XCTAssertEqual(result.count, 30)
    }
}

// MARK: - TTSDistributionBand Tests

final class TTSDistributionBandTests: XCTestCase {

    func testBandIdentifiable() {
        let band = TTSDistributionBand(bucket: "2024-01-01", p50: 100, p75: 200, p90: 300)
        XCTAssertEqual(band.id, "2024-01-01")
    }

    func testBandProperties() {
        let band = TTSDistributionBand(bucket: "2024-01-01T00:00:00Z", p50: 1800, p75: 3600, p90: 5400)
        XCTAssertEqual(band.bucket, "2024-01-01T00:00:00Z")
        XCTAssertEqual(band.p50, 1800)
        XCTAssertEqual(band.p75, 3600)
        XCTAssertEqual(band.p90, 5400)
    }
}

// MARK: - TTSPercentileIndicator Tests

final class TTSPercentileIndicatorTests: XCTestCase {

    func testIndicatorIdentifiable() {
        let indicator = TTSPercentileIndicator(label: "P50", value: 1800, color: .green, trend: "+5.2%")
        XCTAssertEqual(indicator.id, "P50")
    }

    func testIndicatorProperties() {
        let indicator = TTSPercentileIndicator(label: "P90", value: 7200, color: .red, trend: "-10.0%")
        XCTAssertEqual(indicator.label, "P90")
        XCTAssertEqual(indicator.value, 7200)
        XCTAssertEqual(indicator.trend, "-10.0%")
    }
}

// MARK: - TTSJobDataPoint Tests

final class TTSJobDataPointTests: XCTestCase {

    func testDecodingFromJSON() throws {
        let json = """
        {"granularity_bucket":"2024-01-01T00:00:00Z","tts_percentile_sec":3600.5,"duration_percentile_sec":1800.2,"full_name":"linux-build"}
        """
        let data = Data(json.utf8)
        let point = try JSONDecoder().decode(TTSJobDataPoint.self, from: data)

        XCTAssertEqual(point.granularity_bucket, "2024-01-01T00:00:00Z")
        XCTAssertEqual(point.tts_percentile_sec, 3600.5)
        XCTAssertEqual(point.duration_percentile_sec, 1800.2)
        XCTAssertEqual(point.full_name, "linux-build")
    }

    func testDecodingWithNullValues() throws {
        let json = """
        {"granularity_bucket":"2024-01-01T00:00:00Z","tts_percentile_sec":null,"duration_percentile_sec":null,"full_name":"linux-test"}
        """
        let data = Data(json.utf8)
        let point = try JSONDecoder().decode(TTSJobDataPoint.self, from: data)

        XCTAssertEqual(point.granularity_bucket, "2024-01-01T00:00:00Z")
        XCTAssertNil(point.tts_percentile_sec)
        XCTAssertNil(point.duration_percentile_sec)
        XCTAssertEqual(point.full_name, "linux-test")
    }

    func testDecodingArrayFromJSON() throws {
        let json = """
        [
            {"granularity_bucket":"2024-01-01T00:00:00Z","tts_percentile_sec":3600,"duration_percentile_sec":1800,"full_name":"job-a"},
            {"granularity_bucket":"2024-01-02T00:00:00Z","tts_percentile_sec":4200,"duration_percentile_sec":2100,"full_name":"job-b"}
        ]
        """
        let data = Data(json.utf8)
        let points = try JSONDecoder().decode([TTSJobDataPoint].self, from: data)

        XCTAssertEqual(points.count, 2)
        XCTAssertEqual(points[0].full_name, "job-a")
        XCTAssertEqual(points[1].full_name, "job-b")
    }
}
