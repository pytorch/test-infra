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

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(sut.state, .loading)
        XCTAssertTrue(sut.durationSeries.isEmpty)
        XCTAssertTrue(sut.p50Series.isEmpty)
        XCTAssertTrue(sut.p75Series.isEmpty)
        XCTAssertTrue(sut.p90Series.isEmpty)
        XCTAssertTrue(sut.slowestWorkflows.isEmpty)
        XCTAssertTrue(sut.buildSteps.isEmpty)
        XCTAssertTrue(sut.regressions.isEmpty)
        XCTAssertNil(sut.avgDurationMinutes)
        XCTAssertNil(sut.p90DurationMinutes)
        XCTAssertEqual(sut.totalBuildCount, 0)
    }

    // MARK: - Load Data

    func testLoadDataSuccess() async {
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
        XCTAssertEqual(sut.buildSteps.count, 2)
        XCTAssertEqual(sut.allJobNames.count, 2)
    }

    func testLoadDataError() async {
        mockClient.setError(APIError.notFound, for: overallPath)
        setStepsResponse("[]")

        await sut.loadData()

        if case .error(let message) = sut.state {
            XCTAssertFalse(message.isEmpty)
        } else {
            XCTFail("Expected error state")
        }
    }

    // MARK: - Duration Series Computation

    func testDurationSeriesAveragesAcrossJobs() async {
        // Two jobs at same bucket should average
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

    // MARK: - Percentile Series

    func testPercentileSeriesComputed() async {
        // 10 jobs at same bucket to get meaningful percentiles
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

    // MARK: - Slowest Workflows

    func testSlowestWorkflowsDerived() async {
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

    // MARK: - Build Steps

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

    func testBuildStepsGracefullyDegrades() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("job-a", [("2025-01-01", 600)]),
        ]))
        mockClient.setError(APIError.notFound, for: stepsPath)

        await sut.loadData()

        // Should succeed with empty build steps
        XCTAssertEqual(sut.state, .loaded)
        XCTAssertTrue(sut.buildSteps.isEmpty)
    }

    // MARK: - Summaries

    func testComputeSummaries() async {
        setOverallResponse(makeOverallJSON(jobs: [
            ("job-a", [("2025-01-01", 1800), ("2025-01-02", 2400)]),
        ]))
        setStepsResponse("[]")

        await sut.loadData()

        // Last duration value is 2400 sec = 40 min
        XCTAssertEqual(sut.avgDurationMinutes ?? 0, 40.0, accuracy: 0.1)
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

    // MARK: - Regression Detection

    func testDetectRegressionsAboveThreshold() async {
        // One job with much higher build time than average
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

    // MARK: - Job Selection

    func testJobSelectionDefaultsToAll() async {
        setOverallResponse(makeOverallJSON(jobs: [("job-a", [("2025-01-01", 100)])]))
        setStepsResponse(makeStepsJSON(steps: [
            ("job-a", "Build", 5.0),
            ("job-b", "Build", 3.0),
        ]))

        await sut.loadData()

        XCTAssertEqual(sut.selectedJobs, Set(sut.allJobNames))
    }

    func testToggleJobSelection() {
        sut.selectedJobs = Set(["job-a", "job-b"])

        sut.toggleJobSelection("job-a")
        XCTAssertFalse(sut.isJobSelected("job-a"))
        XCTAssertTrue(sut.isJobSelected("job-b"))

        sut.toggleJobSelection("job-a")
        XCTAssertTrue(sut.isJobSelected("job-a"))
    }

    func testSelectAllDeselectAll() {
        sut.allJobNames = ["a", "b", "c"]
        sut.selectAllJobs()
        XCTAssertEqual(sut.selectedJobCount, 3)

        sut.deselectAllJobs()
        XCTAssertEqual(sut.selectedJobCount, 0)
    }

    func testSelectedBuildStepsFiltered() async {
        setOverallResponse(makeOverallJSON(jobs: [("j", [("2025-01-01", 100)])]))
        setStepsResponse(makeStepsJSON(steps: [
            ("job-a", "Build", 5.0),
            ("job-b", "Build", 3.0),
        ]))

        await sut.loadData()
        sut.selectedJobs = Set(["job-a"])

        XCTAssertEqual(sut.selectedBuildSteps.count, 1)
        XCTAssertEqual(sut.selectedBuildSteps.first?.jobName, "job-a")
    }

    // MARK: - Trend

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

    func testTrendDescriptionInsufficientData() {
        XCTAssertEqual(sut.trendDescription, "--")
    }

    // MARK: - Format Helpers

    func testFormatDurationMinutes() {
        XCTAssertEqual(BuildTimeViewModel.formatDuration(nil), "--")
        XCTAssertEqual(BuildTimeViewModel.formatDuration(45.0), "45m")
        XCTAssertEqual(BuildTimeViewModel.formatDuration(90.0), "1h 30m")
        XCTAssertEqual(BuildTimeViewModel.formatDuration(0.0), "0m")
    }

    func testDurationColor() {
        XCTAssertEqual(BuildTimeViewModel.durationColor(nil), .secondary)
        XCTAssertEqual(BuildTimeViewModel.durationColor(60.0), AppColors.success)
        XCTAssertEqual(BuildTimeViewModel.durationColor(120.0), AppColors.unstable)
        XCTAssertEqual(BuildTimeViewModel.durationColor(200.0), AppColors.failure)
    }

    // MARK: - BuildRegression computed properties

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

    // MARK: - Time Range

    func testSelectedRange() {
        sut.selectedTimeRange = "14d"
        XCTAssertEqual(sut.selectedRange?.days, 14)

        sut.selectedTimeRange = "7d"
        XCTAssertEqual(sut.selectedRange?.days, 7)

        sut.selectedTimeRange = "nonexistent"
        XCTAssertNil(sut.selectedRange)
    }

    // MARK: - Helpers

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
