import XCTest
@testable import TorchCI

@MainActor
final class BuildTimeViewModelTests: XCTestCase {
    private var mockClient: MockAPIClient!
    private var sut: BuildTimeViewModel!

    private let overallPath = "/api/clickhouse/build_time_metrics%2Foverall"
    private let stepsPath = "/api/clickhouse/build_time_metrics%2Fsteps"

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        sut = BuildTimeViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        sut = nil
        mockClient = nil
        super.tearDown()
    }

    // MARK: - 1. Initial State (default time range, empty data)

    func testInitialStateIsLoading() {
        XCTAssertEqual(sut.state, .loading)
    }

    func testInitialDefaultTimeRange() {
        XCTAssertEqual(sut.selectedTimeRange, "14d")
    }

    func testInitialDefaultGranularity() {
        XCTAssertEqual(sut.granularity, .day)
    }

    func testInitialEmptyDurationSeries() {
        XCTAssertTrue(sut.durationSeries.isEmpty)
    }

    func testInitialEmptyPercentileSeries() {
        XCTAssertTrue(sut.p50Series.isEmpty)
        XCTAssertTrue(sut.p75Series.isEmpty)
        XCTAssertTrue(sut.p90Series.isEmpty)
    }

    func testInitialEmptySlowestWorkflows() {
        XCTAssertTrue(sut.slowestWorkflows.isEmpty)
    }

    func testInitialEmptyBuildSteps() {
        XCTAssertTrue(sut.buildSteps.isEmpty)
    }

    func testInitialEmptyRegressions() {
        XCTAssertTrue(sut.regressions.isEmpty)
    }

    func testInitialNilSummaries() {
        XCTAssertNil(sut.avgDurationMinutes)
        XCTAssertNil(sut.p90DurationMinutes)
        XCTAssertEqual(sut.totalBuildCount, 0)
    }

    func testInitialEmptyJobNames() {
        XCTAssertTrue(sut.allJobNames.isEmpty)
        XCTAssertTrue(sut.selectedJobs.isEmpty)
        XCTAssertEqual(sut.selectedJobCount, 0)
    }

    func testInitialSelectedRangeIs14Days() {
        XCTAssertEqual(sut.selectedRange?.days, 14)
        XCTAssertEqual(sut.selectedRange?.label, "2 Weeks")
    }

    func testInitialTrendDescriptionIsDash() {
        XCTAssertEqual(sut.trendDescription, "--")
    }

    func testInitialIsImprovingDefaultsToTrue() {
        // With fewer than 2 data points, isImproving returns true
        XCTAssertTrue(sut.isImproving)
    }

    // MARK: - 2. Time Range Selection

    func testTimeRangeSelectionTo7Days() {
        sut.selectedTimeRange = "7d"
        XCTAssertEqual(sut.selectedTimeRange, "7d")
        XCTAssertEqual(sut.selectedRange?.days, 7)
        XCTAssertEqual(sut.selectedRange?.label, "1 Week")
    }

    func testTimeRangeSelectionTo30Days() {
        sut.selectedTimeRange = "30d"
        XCTAssertEqual(sut.selectedRange?.days, 30)
        XCTAssertEqual(sut.selectedRange?.label, "1 Month")
    }

    func testTimeRangeSelectionTo90Days() {
        sut.selectedTimeRange = "90d"
        XCTAssertEqual(sut.selectedRange?.days, 90)
        XCTAssertEqual(sut.selectedRange?.label, "3 Months")
    }

    func testTimeRangeSelectionTo1Day() {
        sut.selectedTimeRange = "1d"
        XCTAssertEqual(sut.selectedRange?.days, 1)
    }

    func testTimeRangeSelectionTo180Days() {
        sut.selectedTimeRange = "180d"
        XCTAssertEqual(sut.selectedRange?.days, 180)
    }

    func testInvalidTimeRangeReturnsNil() {
        sut.selectedTimeRange = "nonexistent"
        XCTAssertNil(sut.selectedRange)
    }

    func testTimeRangeChangeTriggersRefetch() async {
        registerBothEmptyResponses()
        sut.selectedTimeRange = "30d"
        sut.onParametersChanged()
        await sut.refresh()

        XCTAssertGreaterThan(mockClient.callCount, 0)
    }

    func testTimeRangeChangeBackTo14d() {
        sut.selectedTimeRange = "7d"
        XCTAssertEqual(sut.selectedRange?.days, 7)

        sut.selectedTimeRange = "14d"
        XCTAssertEqual(sut.selectedRange?.days, 14)
    }

    // MARK: - 3. Job Selection / Deselection Toggle

    func testToggleJobSelectionRemovesJob() {
        sut.selectedJobs = Set(["job-a", "job-b"])

        sut.toggleJobSelection("job-a")

        XCTAssertFalse(sut.isJobSelected("job-a"))
        XCTAssertTrue(sut.isJobSelected("job-b"))
    }

    func testToggleJobSelectionAddsJob() {
        sut.selectedJobs = Set(["job-b"])

        sut.toggleJobSelection("job-a")

        XCTAssertTrue(sut.isJobSelected("job-a"))
        XCTAssertTrue(sut.isJobSelected("job-b"))
    }

    func testToggleJobSelectionRoundTrip() {
        sut.selectedJobs = Set(["job-a", "job-b"])

        sut.toggleJobSelection("job-a")
        XCTAssertFalse(sut.isJobSelected("job-a"))

        sut.toggleJobSelection("job-a")
        XCTAssertTrue(sut.isJobSelected("job-a"))
    }

    func testIsJobSelectedReturnsFalseForUnknownJob() {
        sut.selectedJobs = Set(["job-a"])
        XCTAssertFalse(sut.isJobSelected("unknown-job"))
    }

    func testSelectedJobCountMatchesSelection() {
        sut.selectedJobs = Set(["a", "b", "c"])
        XCTAssertEqual(sut.selectedJobCount, 3)

        sut.toggleJobSelection("b")
        XCTAssertEqual(sut.selectedJobCount, 2)
    }

    func testJobSelectionDefaultsToAllAfterLoad() async {
        setOverallResponse(makeOverallJSON(jobs: [("job-a", [("2025-01-01", 100)])]))
        setStepsResponse(makeStepsJSON(steps: [
            ("job-a", "Build", 5.0),
            ("job-b", "Build", 3.0),
        ]))

        await sut.loadData()

        XCTAssertEqual(sut.selectedJobs, Set(sut.allJobNames))
    }

    func testSelectedBuildStepsFilteredBySelection() async {
        setOverallResponse(makeOverallJSON(jobs: [("j", [("2025-01-01", 100)])]))
        setStepsResponse(makeStepsJSON(steps: [
            ("job-a", "Build", 5.0),
            ("job-b", "Build", 3.0),
            ("job-c", "Build", 7.0),
        ]))

        await sut.loadData()
        sut.selectedJobs = Set(["job-a"])

        XCTAssertEqual(sut.selectedBuildSteps.count, 1)
        XCTAssertEqual(sut.selectedBuildSteps.first?.jobName, "job-a")
    }

    func testSelectedBuildStepsEmptyWhenNoneSelected() async {
        setOverallResponse(makeOverallJSON(jobs: [("j", [("2025-01-01", 100)])]))
        setStepsResponse(makeStepsJSON(steps: [
            ("job-a", "Build", 5.0),
            ("job-b", "Build", 3.0),
        ]))

        await sut.loadData()
        sut.deselectAllJobs()

        XCTAssertTrue(sut.selectedBuildSteps.isEmpty)
    }

    // MARK: - 4. Select All / Deselect All

    func testSelectAllJobs() {
        sut.allJobNames = ["a", "b", "c"]
        sut.selectAllJobs()

        XCTAssertEqual(sut.selectedJobCount, 3)
        XCTAssertTrue(sut.isJobSelected("a"))
        XCTAssertTrue(sut.isJobSelected("b"))
        XCTAssertTrue(sut.isJobSelected("c"))
    }

    func testDeselectAllJobs() {
        sut.allJobNames = ["a", "b", "c"]
        sut.selectedJobs = Set(["a", "b", "c"])

        sut.deselectAllJobs()

        XCTAssertEqual(sut.selectedJobCount, 0)
        XCTAssertFalse(sut.isJobSelected("a"))
        XCTAssertFalse(sut.isJobSelected("b"))
        XCTAssertFalse(sut.isJobSelected("c"))
    }

    func testSelectAllThenDeselectAll() {
        sut.allJobNames = ["x", "y", "z"]
        sut.selectAllJobs()
        XCTAssertEqual(sut.selectedJobCount, 3)

        sut.deselectAllJobs()
        XCTAssertEqual(sut.selectedJobCount, 0)
    }

    func testDeselectAllThenSelectAll() {
        sut.allJobNames = ["x", "y"]
        sut.deselectAllJobs()
        XCTAssertEqual(sut.selectedJobCount, 0)

        sut.selectAllJobs()
        XCTAssertEqual(sut.selectedJobCount, 2)
    }

    func testSelectAllWithEmptyJobNames() {
        sut.allJobNames = []
        sut.selectAllJobs()
        XCTAssertEqual(sut.selectedJobCount, 0)
    }

    // MARK: - 5. Loading State Transitions

    func testLoadDataTransitionsToLoaded() async {
        registerBothEmptyResponses()

        XCTAssertEqual(sut.state, .loading)

        await sut.loadData()

        XCTAssertEqual(sut.state, .loaded)
    }

    func testLoadDataTransitionsToErrorOnFailure() async {
        mockClient.setError(APIError.notFound, for: overallPath)
        setStepsResponse("[]")

        await sut.loadData()

        if case .error = sut.state {
            // Expected
        } else {
            XCTFail("Expected error state, got \(sut.state)")
        }
    }

    func testRefreshCallsFetchAllData() async {
        registerBothEmptyResponses()

        await sut.refresh()

        XCTAssertGreaterThan(mockClient.callCount, 0)
    }

    func testRefreshTransitionsToLoaded() async {
        registerBothEmptyResponses()

        await sut.refresh()

        XCTAssertEqual(sut.state, .loaded)
    }

    func testOnParametersChangedTriggersRefetch() async {
        registerBothEmptyResponses()

        sut.onParametersChanged()
        await sut.refresh()

        XCTAssertGreaterThan(mockClient.callCount, 0)
        XCTAssertEqual(sut.state, .loaded)
    }

    func testLoadDataSetsLoadingStateThenTransitions() async {
        registerBothEmptyResponses()

        // loadData() sets state = .loading, then fetches
        await sut.loadData()

        // After completion, it should be .loaded
        XCTAssertEqual(sut.state, .loaded)
    }

    func testViewStateLoadingEquality() {
        let a = BuildTimeViewModel.ViewState.loading
        let b = BuildTimeViewModel.ViewState.loading
        XCTAssertEqual(a, b)
    }

    func testViewStateLoadedEquality() {
        let a = BuildTimeViewModel.ViewState.loaded
        let b = BuildTimeViewModel.ViewState.loaded
        XCTAssertEqual(a, b)
    }

    func testViewStateErrorEquality() {
        let a = BuildTimeViewModel.ViewState.error("test error")
        let b = BuildTimeViewModel.ViewState.error("test error")
        XCTAssertEqual(a, b)
    }

    func testViewStateDifferentErrorsNotEqual() {
        let a = BuildTimeViewModel.ViewState.error("error-a")
        let b = BuildTimeViewModel.ViewState.error("error-b")
        XCTAssertNotEqual(a, b)
    }

    func testViewStateDifferentKindsNotEqual() {
        XCTAssertNotEqual(BuildTimeViewModel.ViewState.loading, BuildTimeViewModel.ViewState.loaded)
        XCTAssertNotEqual(BuildTimeViewModel.ViewState.loaded, BuildTimeViewModel.ViewState.error("x"))
        XCTAssertNotEqual(BuildTimeViewModel.ViewState.loading, BuildTimeViewModel.ViewState.error("x"))
    }

    // MARK: - 6. Error Handling

    func testLoadDataErrorOnOverallEndpoint() async {
        mockClient.setError(APIError.notFound, for: overallPath)
        setStepsResponse("[]")

        await sut.loadData()

        if case .error(let message) = sut.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state")
        }
    }

    func testLoadDataErrorWithServerError() async {
        mockClient.setError(APIError.serverError(500), for: overallPath)
        setStepsResponse("[]")

        await sut.loadData()

        if case .error = sut.state {
            // Expected
        } else {
            XCTFail("Expected error state")
        }
    }

    func testLoadDataErrorWithNetworkError() async {
        mockClient.setError(
            APIError.networkError(URLError(.notConnectedToInternet)),
            for: overallPath
        )
        setStepsResponse("[]")

        await sut.loadData()

        if case .error = sut.state {
            // Expected
        } else {
            XCTFail("Expected error state")
        }
    }

    func testBuildStepsGracefullyDegradesOnStepsError() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("job-a", [("2025-01-01", 600)]),
        ]))
        mockClient.setError(APIError.notFound, for: stepsPath)

        await sut.loadData()

        // fetchBuildSteps catches errors and returns [] so overall load still succeeds
        XCTAssertEqual(sut.state, .loaded)
        XCTAssertTrue(sut.buildSteps.isEmpty)
    }

    func testNoRegressionsWhenBuildStepsEmpty() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("job-a", [("2025-01-01", 600)]),
        ]))
        setStepsResponse("[]")

        await sut.loadData()

        XCTAssertTrue(sut.regressions.isEmpty)
    }

    func testErrorMessageIsNonEmpty() async {
        mockClient.setError(APIError.notFound, for: overallPath)
        setStepsResponse("[]")

        await sut.loadData()

        if case .error(let msg) = sut.state {
            XCTAssertGreaterThan(msg.count, 0)
        } else {
            XCTFail("Expected error state")
        }
    }

    // MARK: - 7. Data Loading with Mock Response

    func testLoadDataPopulatesAllFields() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("job-a", [("2025-01-01", 600), ("2025-01-02", 720)]),
            ("job-b", [("2025-01-01", 300), ("2025-01-02", 360)]),
        ]))
        setStepsResponse(makeStepsJSON(steps: [
            ("job-a", "Checkout PyTorch", 2.0),
            ("job-a", "Pull docker image", 3.0),
            ("job-a", "Build", 10.0),
            ("job-b", "Checkout PyTorch", 1.5),
            ("job-b", "Pull docker image", 2.5),
            ("job-b", "Build", 5.0),
        ]))

        await sut.loadData()

        XCTAssertEqual(sut.state, .loaded)
        XCTAssertFalse(sut.durationSeries.isEmpty)
        XCTAssertFalse(sut.p50Series.isEmpty)
        XCTAssertFalse(sut.p75Series.isEmpty)
        XCTAssertFalse(sut.p90Series.isEmpty)
        XCTAssertFalse(sut.slowestWorkflows.isEmpty)
        XCTAssertEqual(sut.buildSteps.count, 2)
        XCTAssertEqual(sut.allJobNames.count, 2)
        XCTAssertEqual(sut.selectedJobs.count, 2)
        XCTAssertNotNil(sut.avgDurationMinutes)
        XCTAssertNotNil(sut.p90DurationMinutes)
        XCTAssertGreaterThan(sut.totalBuildCount, 0)
    }

    func testDurationSeriesAveragesAcrossJobs() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("job-a", [("2025-01-01", 600)]),
            ("job-b", [("2025-01-01", 400)]),
        ]))
        setStepsResponse("[]")

        await sut.loadData()

        XCTAssertEqual(sut.durationSeries.count, 1)
        XCTAssertEqual(sut.durationSeries.first?.value, 500.0) // (600+400)/2
    }

    func testDurationSeriesSortedByBucket() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("job-a", [("2025-01-03", 300), ("2025-01-01", 100), ("2025-01-02", 200)]),
        ]))
        setStepsResponse("[]")

        await sut.loadData()

        let buckets = sut.durationSeries.map(\.granularity_bucket)
        XCTAssertEqual(buckets, ["2025-01-01", "2025-01-02", "2025-01-03"])
    }

    func testPercentileSeriesComputed() async {
        var jobs: [(String, [(String, Int)])] = []
        for i in 1...10 {
            jobs.append(("job-\(i)", [("2025-01-01", i * 100)]))
        }
        setOverallResponse(makeOverallJSON(jobs: jobs))
        setStepsResponse("[]")

        await sut.loadData()

        XCTAssertEqual(sut.p50Series.count, 1)
        XCTAssertEqual(sut.p75Series.count, 1)
        XCTAssertEqual(sut.p90Series.count, 1)

        // P50 of [100,200,...,1000] = 550
        let p50 = sut.p50Series.first!.value!
        XCTAssertEqual(p50, 550.0, accuracy: 1.0)

        // P90 of [100,200,...,1000] = 910
        let p90 = sut.p90Series.first!.value!
        XCTAssertEqual(p90, 910.0, accuracy: 1.0)
    }

    func testPercentileSingleValue() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("job-a", [("2025-01-01", 500)]),
        ]))
        setStepsResponse("[]")

        await sut.loadData()

        XCTAssertEqual(sut.p50Series.first?.value, 500.0)
        XCTAssertEqual(sut.p90Series.first?.value, 500.0)
    }

    func testSlowestWorkflowsDerivedAndSorted() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("slow-job", [("2025-01-01", 3600), ("2025-01-02", 3600)]),
            ("fast-job", [("2025-01-01", 60), ("2025-01-02", 60)]),
        ]))
        setStepsResponse("[]")

        await sut.loadData()

        XCTAssertEqual(sut.slowestWorkflows.count, 2)
        XCTAssertEqual(sut.slowestWorkflows.first?.name, "slow-job")
        XCTAssertEqual(sut.slowestWorkflows.first?.avgMinutes ?? 0, 60.0, accuracy: 0.1)
        XCTAssertEqual(sut.slowestWorkflows.last?.name, "fast-job")
    }

    func testSlowestWorkflowsCappedAt10() async {
        var jobs: [(String, [(String, Int)])] = []
        for i in 1...15 {
            jobs.append(("job-\(i)", [("2025-01-01", i * 100)]))
        }
        setOverallResponse(makeOverallJSON(jobs: jobs))
        setStepsResponse("[]")

        await sut.loadData()

        XCTAssertEqual(sut.slowestWorkflows.count, 10)
    }

    func testSlowestWorkflowsRunCount() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("job-a", [("2025-01-01", 100), ("2025-01-02", 200), ("2025-01-03", 300)]),
        ]))
        setStepsResponse("[]")

        await sut.loadData()

        XCTAssertEqual(sut.slowestWorkflows.first?.runCount, 3)
    }

    func testBuildStepsBreakdown() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("job-a", [("2025-01-01", 600)]),
        ]))
        setStepsResponse(makeStepsJSON(steps: [
            ("job-a", "Checkout PyTorch", 2.0),
            ("job-a", "Pull docker image", 3.0),
            ("job-a", "Build", 15.0),
        ]))

        await sut.loadData()

        XCTAssertEqual(sut.buildSteps.count, 1)
        let step = sut.buildSteps.first!
        XCTAssertEqual(step.jobName, "job-a")
        XCTAssertEqual(step.checkoutMinutes, 2.0)
        XCTAssertEqual(step.pullDockerMinutes, 3.0)
        XCTAssertEqual(step.buildMinutes, 15.0)
        XCTAssertEqual(step.totalMinutes, 20.0)
    }

    func testComputeSummariesAvgDuration() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("job-a", [("2025-01-01", 1800), ("2025-01-02", 2400)]),
        ]))
        setStepsResponse("[]")

        await sut.loadData()

        // Last duration value is 2400 sec = 40 min
        XCTAssertEqual(sut.avgDurationMinutes ?? 0, 40.0, accuracy: 0.1)
    }

    func testComputeSummariesP90Duration() async {
        // Single job so P90 = the value itself
        setOverallResponse(makeOverallJSON(jobs: [
            ("job-a", [("2025-01-01", 3000), ("2025-01-02", 3600)]),
        ]))
        setStepsResponse("[]")

        await sut.loadData()

        // p90Series last value is 3600 sec = 60 min
        XCTAssertEqual(sut.p90DurationMinutes ?? 0, 60.0, accuracy: 0.1)
    }

    func testTotalBuildCount() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("job-a", [("2025-01-01", 100), ("2025-01-02", 100)]),
            ("job-b", [("2025-01-01", 200)]),
        ]))
        setStepsResponse("[]")

        await sut.loadData()

        // job-a: 2 runs, job-b: 1 run = 3 total from slowest workflows
        XCTAssertEqual(sut.totalBuildCount, 3)
    }

    func testDetectRegressionsAboveThreshold() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("job-a", [("2025-01-01", 100)]),
        ]))
        setStepsResponse(makeStepsJSON(steps: [
            ("normal-job", "Checkout PyTorch", 1.0),
            ("normal-job", "Pull docker image", 1.0),
            ("normal-job", "Build", 3.0),
            ("slow-job", "Checkout PyTorch", 5.0),
            ("slow-job", "Pull docker image", 10.0),
            ("slow-job", "Build", 30.0),
        ]))

        await sut.loadData()

        // slow-job total = 45m, normal-job total = 5m, avg = 25m
        // slow-job: 45/25 = 1.8, which is > 1.15 (15% threshold)
        XCTAssertFalse(sut.regressions.isEmpty)
        XCTAssertEqual(sut.regressions.first?.jobName, "slow-job")
    }

    func testNoRegressionsWhenAllSimilar() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("job-a", [("2025-01-01", 100)]),
        ]))
        setStepsResponse(makeStepsJSON(steps: [
            ("job-a", "Checkout PyTorch", 1.0),
            ("job-a", "Pull docker image", 1.0),
            ("job-a", "Build", 3.0),
            ("job-b", "Checkout PyTorch", 1.0),
            ("job-b", "Pull docker image", 1.0),
            ("job-b", "Build", 3.0),
        ]))

        await sut.loadData()

        XCTAssertTrue(sut.regressions.isEmpty)
    }

    func testRegressionsCappedAt5() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("j", [("2025-01-01", 100)]),
        ]))
        // Create 8 jobs where 7 regress significantly above the average
        var steps: [(String, String, Double)] = []
        // One small job to pull the average down
        steps.append(("tiny-job", "Build", 1.0))
        // Seven large jobs that will be above 15% of avg
        for i in 1...7 {
            steps.append(("big-job-\(i)", "Build", Double(50 + i * 10)))
        }
        setStepsResponse(makeStepsJSON(steps: steps))

        await sut.loadData()

        XCTAssertLessThanOrEqual(sut.regressions.count, 5)
    }

    func testLoadDataCallsCorrectEndpoints() async {
        registerBothEmptyResponses()

        await sut.loadData()

        let paths = Set(mockClient.callPaths())
        XCTAssertTrue(paths.contains(overallPath))
        XCTAssertTrue(paths.contains(stepsPath))
    }

    func testLoadDataWithEmptyResponsesSucceeds() async {
        registerBothEmptyResponses()

        await sut.loadData()

        XCTAssertEqual(sut.state, .loaded)
        XCTAssertTrue(sut.durationSeries.isEmpty)
        XCTAssertTrue(sut.buildSteps.isEmpty)
        XCTAssertTrue(sut.slowestWorkflows.isEmpty)
        XCTAssertNil(sut.avgDurationMinutes)
    }

    func testJobSelectionPreservedAcrossReloads() async {
        setOverallResponse(makeOverallJSON(jobs: [("j", [("2025-01-01", 100)])]))
        setStepsResponse(makeStepsJSON(steps: [
            ("job-a", "Build", 5.0),
            ("job-b", "Build", 3.0),
        ]))

        await sut.loadData()

        // Deselect job-b
        sut.toggleJobSelection("job-b")
        XCTAssertFalse(sut.isJobSelected("job-b"))
        XCTAssertTrue(sut.isJobSelected("job-a"))

        // Reload - selected jobs should be intersected (job-a stays selected, job-b stays deselected)
        mockClient.reset()
        setOverallResponse(makeOverallJSON(jobs: [("j", [("2025-01-01", 100)])]))
        setStepsResponse(makeStepsJSON(steps: [
            ("job-a", "Build", 5.0),
            ("job-b", "Build", 3.0),
        ]))

        await sut.loadData()

        // Only job-a should remain selected since selectedJobs was {"job-a"}
        XCTAssertTrue(sut.isJobSelected("job-a"))
        XCTAssertFalse(sut.isJobSelected("job-b"))
    }

    // MARK: - Trend Computation

    func testIsImprovingWhenRecentLower() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("j", [("2025-01-01", 1000), ("2025-01-02", 900), ("2025-01-03", 800),
                   ("2025-01-04", 700), ("2025-01-05", 600)]),
        ]))
        setStepsResponse("[]")

        await sut.loadData()

        XCTAssertTrue(sut.isImproving)
    }

    func testIsNotImprovingWhenRecentHigher() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("j", [("2025-01-01", 600), ("2025-01-02", 700), ("2025-01-03", 800),
                   ("2025-01-04", 900), ("2025-01-05", 1000)]),
        ]))
        setStepsResponse("[]")

        await sut.loadData()

        XCTAssertFalse(sut.isImproving)
    }

    func testTrendDescriptionPositive() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("j", [("2025-01-01", 100), ("2025-01-02", 150)]),
        ]))
        setStepsResponse("[]")

        await sut.loadData()

        XCTAssertEqual(sut.trendDescription, "+50.0%")
    }

    func testTrendDescriptionNegative() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("j", [("2025-01-01", 200), ("2025-01-02", 100)]),
        ]))
        setStepsResponse("[]")

        await sut.loadData()

        XCTAssertEqual(sut.trendDescription, "-50.0%")
    }

    func testTrendDescriptionInsufficientData() {
        XCTAssertEqual(sut.trendDescription, "--")
    }

    func testTrendDescriptionSingleDataPoint() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("j", [("2025-01-01", 100)]),
        ]))
        setStepsResponse("[]")

        await sut.loadData()

        // Only 1 data point, not enough for trend, still "--"
        // Actually with 1 point, durationSeries.count == 1, which is < 2
        XCTAssertEqual(sut.trendDescription, "--")
    }

    // MARK: - Format Helpers

    func testFormatDurationNil() {
        XCTAssertEqual(BuildTimeViewModel.formatDuration(nil), "--")
    }

    func testFormatDurationMinutes() {
        XCTAssertEqual(BuildTimeViewModel.formatDuration(45.0), "45m")
    }

    func testFormatDurationHoursAndMinutes() {
        XCTAssertEqual(BuildTimeViewModel.formatDuration(90.0), "1h 30m")
    }

    func testFormatDurationZero() {
        XCTAssertEqual(BuildTimeViewModel.formatDuration(0.0), "0m")
    }

    func testFormatDurationExactHour() {
        XCTAssertEqual(BuildTimeViewModel.formatDuration(60.0), "1h 0m")
    }

    func testFormatDurationLargeValue() {
        XCTAssertEqual(BuildTimeViewModel.formatDuration(180.0), "3h 0m")
    }

    func testDurationColorNil() {
        XCTAssertEqual(BuildTimeViewModel.durationColor(nil), .secondary)
    }

    func testDurationColorSuccess() {
        XCTAssertEqual(BuildTimeViewModel.durationColor(60.0), AppColors.success)
    }

    func testDurationColorUnstable() {
        XCTAssertEqual(BuildTimeViewModel.durationColor(120.0), AppColors.unstable)
    }

    func testDurationColorFailure() {
        XCTAssertEqual(BuildTimeViewModel.durationColor(200.0), AppColors.failure)
    }

    func testDurationColorBoundaryAt90() {
        // Exactly 90 is <= 90, so success
        XCTAssertEqual(BuildTimeViewModel.durationColor(90.0), AppColors.success)
    }

    func testDurationColorBoundaryAt180() {
        // Exactly 180 is <= 180, so unstable
        XCTAssertEqual(BuildTimeViewModel.durationColor(180.0), AppColors.unstable)
    }

    // MARK: - BuildRegression Computed Properties

    func testBuildRegressionChangePercent() {
        let regression = BuildTimeViewModel.BuildRegression(
            jobName: "test",
            currentMinutes: 120,
            baselineMinutes: 100
        )
        XCTAssertEqual(regression.changePercent, 20.0, accuracy: 0.1)
        XCTAssertEqual(regression.changeDescription, "+20.0%")
    }

    func testBuildRegressionZeroBaseline() {
        let regression = BuildTimeViewModel.BuildRegression(
            jobName: "test",
            currentMinutes: 120,
            baselineMinutes: 0
        )
        XCTAssertEqual(regression.changePercent, 0.0)
    }

    func testBuildRegressionChangeDescription() {
        let regression = BuildTimeViewModel.BuildRegression(
            jobName: "test",
            currentMinutes: 150,
            baselineMinutes: 100
        )
        XCTAssertEqual(regression.changeDescription, "+50.0%")
    }

    // MARK: - BuildStepBreakdown

    func testBuildStepTotalMinutes() {
        let step = BuildTimeViewModel.BuildStepBreakdown(
            jobName: "test",
            checkoutMinutes: 2.0,
            pullDockerMinutes: 3.0,
            buildMinutes: 10.0
        )
        XCTAssertEqual(step.totalMinutes, 15.0)
    }

    func testBuildStepTotalMinutesAllZero() {
        let step = BuildTimeViewModel.BuildStepBreakdown(
            jobName: "test",
            checkoutMinutes: 0.0,
            pullDockerMinutes: 0.0,
            buildMinutes: 0.0
        )
        XCTAssertEqual(step.totalMinutes, 0.0)
    }

    // MARK: - Helpers

    private func registerBothEmptyResponses() {
        setOverallResponse("[]")
        setStepsResponse("[]")
    }

    private func setOverallResponse(_ json: String) {
        mockClient.setResponse(json, for: overallPath)
    }

    private func setStepsResponse(_ json: String) {
        mockClient.setResponse(json, for: stepsPath)
    }

    private func makeOverallJSON(jobs: [(String, [(String, Int)])]) -> String {
        var entries: [String] = []
        for (jobName, buckets) in jobs {
            for (bucket, duration) in buckets {
                entries.append("""
                {"bucket": "\(bucket)", "duration_sec": \(duration), "job_name": "\(jobName)"}
                """)
            }
        }
        return "[\(entries.joined(separator: ","))]"
    }

    private func makeStepsJSON(steps: [(String, String, Double)]) -> String {
        let entries = steps.map { (jobName, stepName, durationMin) in
            """
            {"job_name": "\(jobName)", "step_name": "\(stepName)", "duration_min": \(durationMin)}
            """
        }
        return "[\(entries.joined(separator: ","))]"
    }
}
