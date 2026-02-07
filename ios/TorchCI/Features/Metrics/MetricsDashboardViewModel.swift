import Foundation
import SwiftUI

@MainActor
final class MetricsDashboardViewModel: ObservableObject {
    // MARK: - Types

    struct HealthStatus {
        let title: String
        let subtitle: String
        let icon: String
        let color: Color
    }

    // MARK: - State

    enum ViewState: Equatable {
        case loading
        case loaded
        case error(String)

        static func == (lhs: ViewState, rhs: ViewState) -> Bool {
            switch (lhs, rhs) {
            case (.loading, .loading): return true
            case (.loaded, .loaded): return true
            case (.error(let a), .error(let b)): return a == b
            default: return false
            }
        }
    }

    @Published var state: ViewState = .loading
    @Published var granularity: TimeGranularity = .day
    @Published var selectedTimeRange: String = "14d"
    @Published var selectedPercentile: Double = 0.5

    // Commit Health
    @Published var brokenTrunkPercent: Double?
    @Published var brokenTrunkTrend: Double?
    @Published var flakyRedPercent: Double?
    @Published var flakyRedTrend: Double?
    @Published var viableStrictLagSeconds: Double?
    @Published var disabledTestsCount: Int?

    // Merge Metrics
    @Published var forceMergeFailurePercent: Double?
    @Published var forceMergeFailureTrend: Double?
    @Published var forceMergeImpatiencePercent: Double?
    @Published var forceMergeImpatienceTrend: Double?
    @Published var mergeRetryRate: Double?
    @Published var prLandingTimeHours: Double?

    // Signal Metrics
    @Published var ttrsP90Minutes: Double?
    @Published var ttrsP75Minutes: Double?
    @Published var workflowTTSSeconds: Double?
    @Published var avgQueueTimeSeconds: Double?

    // Build Health
    @Published var lastMainPushSeconds: Double?
    @Published var lastNightlyPushSeconds: Double?
    @Published var lastDockerBuildSeconds: Double?
    @Published var lastDocsPushSeconds: Double?

    // Activity Metrics
    @Published var revertsCount: Int?
    @Published var commitsCount: Int?
    @Published var lfRolloverPercent: Double?

    // Time series data
    @Published var redRateSeries: [TimeSeriesDataPoint] = []
    @Published var queueTimeSeries: [TimeSeriesDataPoint] = []
    @Published var disabledTestsSeries: [TimeSeriesDataPoint] = []

    // Metadata
    @Published var lastUpdated: Date?

    private let apiClient: APIClientProtocol

    // MARK: - Init

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    // MARK: - Computed

    var selectedRange: TimeRange? {
        TimeRange.presets.first { $0.id == selectedTimeRange }
    }

    var selectedPercentileLabel: String {
        if selectedPercentile == -1.0 {
            return "avg"
        }
        return "p\(Int(selectedPercentile * 100))"
    }

    var overallHealthStatus: HealthStatus {
        // Aggregate signals: broken trunk %, viable/strict lag, last main push
        var criticalCount = 0
        var warningCount = 0

        if let broken = brokenTrunkPercent {
            if broken >= 15 { criticalCount += 1 }
            else if broken >= 5 { warningCount += 1 }
        }

        if let lag = viableStrictLagSeconds {
            if lag > 43200 { criticalCount += 1 }
            else if lag > 21600 { warningCount += 1 }
        }

        if let mainPush = lastMainPushSeconds {
            if mainPush > 14400 { criticalCount += 1 }  // >4h
            else if mainPush > 7200 { warningCount += 1 }  // >2h
        }

        if criticalCount > 0 {
            return HealthStatus(
                title: "Issues Detected",
                subtitle: "\(criticalCount) critical signal\(criticalCount == 1 ? "" : "s") need attention",
                icon: "exclamationmark.triangle.fill",
                color: AppColors.failure
            )
        } else if warningCount > 0 {
            return HealthStatus(
                title: "Some Warnings",
                subtitle: "\(warningCount) metric\(warningCount == 1 ? "" : "s") above threshold",
                icon: "exclamationmark.circle.fill",
                color: AppColors.pending
            )
        } else {
            return HealthStatus(
                title: "All Systems Normal",
                subtitle: "Key metrics within expected ranges",
                icon: "checkmark.circle.fill",
                color: AppColors.success
            )
        }
    }

    private var timeRangeTuple: (startTime: String, stopTime: String) {
        let days = selectedRange?.days ?? 14
        return APIEndpoint.timeRange(days: days)
    }

    // MARK: - Data Loading

    func loadDashboard() async {
        state = .loading
        await fetchAllMetrics()
    }

    func refresh() async {
        await fetchAllMetrics()
    }

    func onParametersChanged() async {
        await fetchAllMetrics()
    }

    private func fetchAllMetrics() async {
        let range = timeRangeTuple
        let gran = granularity.rawValue
        let client = apiClient

        // Fetch all time-series data in parallel using async let, each with its own try?
        async let redRateResult: [TimeSeriesDataPoint]? = try? client.fetch(
            .clickhouseQuery(
                name: "master_commit_red",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "timezone": "UTC",
                    "granularity": gran,
                    "usePercentage": true,
                ] as [String: Any]
            )
        )
        async let queueTimeResult: [TimeSeriesDataPoint]? = try? client.fetch(
            .clickhouseQuery(
                name: "queue_times_historical",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "granularity": gran,
                ] as [String: Any]
            )
        )
        async let disabledTestsResult: [TimeSeriesDataPoint]? = try? client.fetch(
            .clickhouseQuery(
                name: "disabled_test_historical",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "repo": "pytorch/pytorch",
                ] as [String: Any]
            )
        )

        redRateSeries = await redRateResult ?? []
        queueTimeSeries = await queueTimeResult ?? []
        disabledTestsSeries = await disabledTestsResult ?? []

        // Fetch remaining metrics individually, each tolerating failure
        _ = try? await fetchCommitHealth(startTime: range.startTime, stopTime: range.stopTime)
        _ = try? await fetchMergeMetrics(startTime: range.startTime, stopTime: range.stopTime, granularity: gran)
        _ = try? await fetchSignalMetrics(startTime: range.startTime, stopTime: range.stopTime)
        _ = try? await fetchBuildHealth()
        _ = try? await fetchActivityMetrics(startTime: range.startTime, stopTime: range.stopTime)

        disabledTestsCount = disabledTestsSeries.last?.value.map { Int($0) }
        lastUpdated = Date()
        state = .loaded
    }

    // MARK: - Individual Fetchers

    private func fetchRedRate(startTime: String, stopTime: String, granularity: String) async throws -> [TimeSeriesDataPoint] {
        try await apiClient.fetch(
            .clickhouseQuery(
                name: "master_commit_red",
                parameters: [
                    "startTime": startTime,
                    "stopTime": stopTime,
                    "timezone": "UTC",
                    "granularity": granularity,
                    "usePercentage": true,
                ] as [String: Any]
            )
        )
    }

    private func fetchCommitHealth(startTime: String, stopTime: String) async throws -> Bool {
        // Fetch broken trunk and flaky red percentages
        // The API returns data with broken_trunk_red and flaky_red fields
        struct CommitRedData: Decodable {
            let broken_trunk_red: Double?
            let flaky_red: Double?
        }

        do {
            let data: [CommitRedData] = try await apiClient.fetch(
                .clickhouseQuery(
                    name: "master_commit_red_avg",
                    parameters: [
                        "startTime": startTime,
                        "stopTime": stopTime,
                        "workflowNames": ["lint", "pull", "trunk", "linux-aarch64"],
                    ] as [String: Any]
                )
            )

            if let first = data.first {
                brokenTrunkPercent = first.broken_trunk_red.map { $0 * 100 }
                flakyRedPercent = first.flaky_red.map { $0 * 100 }
            }
        } catch {
            // Fallback: try to get from red rate series
            if let lastRed = redRateSeries.last?.value {
                brokenTrunkPercent = lastRed
                flakyRedPercent = nil
            }
        }

        // Fetch viable/strict lag
        let lagData: [TimeSeriesDataPoint] = try await apiClient.fetch(
            .clickhouseQuery(
                name: "strict_lag_sec",
                parameters: [
                    "repo": "pytorch",
                    "owner": "pytorch",
                    "head": "refs/heads/main",
                ] as [String: Any]
            )
        )
        viableStrictLagSeconds = lagData.first?.value

        // Compute trends from red rate series
        brokenTrunkTrend = computeTrend(from: redRateSeries)

        return true
    }

    private func fetchMergeMetrics(startTime: String, stopTime: String, granularity: String) async throws -> Bool {
        // Force merge - failure (time series for trend)
        let failureSeries: [TimeSeriesDataPoint] = try await apiClient.fetch(
            .clickhouseQuery(
                name: "weekly_force_merge_stats",
                parameters: [
                    "startTime": startTime,
                    "stopTime": stopTime,
                    "merge_type": "Failure",
                    "one_bucket": false,
                    "granularity": granularity,
                ] as [String: Any]
            )
        )
        forceMergeFailurePercent = failureSeries.last?.value
        forceMergeFailureTrend = computeTrend(from: failureSeries)

        // Force merge - impatience (time series for trend)
        let impatienceSeries: [TimeSeriesDataPoint] = try await apiClient.fetch(
            .clickhouseQuery(
                name: "weekly_force_merge_stats",
                parameters: [
                    "startTime": startTime,
                    "stopTime": stopTime,
                    "merge_type": "Impatience",
                    "one_bucket": false,
                    "granularity": granularity,
                ] as [String: Any]
            )
        )
        forceMergeImpatiencePercent = impatienceSeries.last?.value
        forceMergeImpatienceTrend = computeTrend(from: impatienceSeries)

        // Merge retry rate
        let retryData: [TimeSeriesDataPoint] = try await apiClient.fetch(
            .clickhouseQuery(
                name: "merge_retry_rate",
                parameters: [
                    "startTime": startTime,
                    "stopTime": stopTime,
                ] as [String: Any]
            )
        )
        mergeRetryRate = retryData.first?.value

        // PR landing time
        let landingData: [TimeSeriesDataPoint] = try await apiClient.fetch(
            .clickhouseQuery(
                name: "pr_landing_time_avg",
                parameters: [
                    "startTime": startTime,
                    "stopTime": stopTime,
                ] as [String: Any]
            )
        )
        prLandingTimeHours = landingData.first?.value

        return true
    }

    private func fetchSignalMetrics(startTime: String, stopTime: String) async throws -> Bool {
        // TTRS p90
        let p90Data: [TimeSeriesDataPoint] = try await apiClient.fetch(
            .clickhouseQuery(
                name: "ttrs_percentiles",
                parameters: [
                    "startTime": startTime,
                    "stopTime": stopTime,
                    "one_bucket": true,
                    "percentile_to_get": 0.9,
                    "workflow": "pull",
                ] as [String: Any]
            )
        )
        ttrsP90Minutes = p90Data.first?.value

        // TTRS p75
        let p75Data: [TimeSeriesDataPoint] = try await apiClient.fetch(
            .clickhouseQuery(
                name: "ttrs_percentiles",
                parameters: [
                    "startTime": startTime,
                    "stopTime": stopTime,
                    "one_bucket": true,
                    "percentile_to_get": 0.75,
                    "workflow": "pull",
                ] as [String: Any]
            )
        )
        ttrsP75Minutes = p75Data.first?.value

        // Workflow TTS (pull/trunk)
        let queryName = selectedPercentile == -1.0 ? "workflow_duration_avg" : "workflow_duration_percentile"
        let ttsData: [TimeSeriesDataPoint] = try await apiClient.fetch(
            .clickhouseQuery(
                name: queryName,
                parameters: [
                    "startTime": startTime,
                    "stopTime": stopTime,
                    "workflowNames": ["pull", "trunk"],
                    "percentile": selectedPercentile,
                ] as [String: Any]
            )
        )
        workflowTTSSeconds = ttsData.first?.value

        // Average queue time
        let queueData: [TimeSeriesDataPoint] = try await apiClient.fetch(
            .clickhouseQuery(
                name: "queued_jobs_by_label",
                parameters: [:] as [String: Any]
            )
        )
        // Average across all machine types
        if !queueData.isEmpty {
            avgQueueTimeSeconds = queueData.compactMap { $0.value }.reduce(0, +) / Double(queueData.count)
        }

        return true
    }

    private func fetchBuildHealth() async throws -> Bool {
        // Last main push
        let mainData: [TimeSeriesDataPoint] = try await apiClient.fetch(
            .clickhouseQuery(
                name: "last_branch_push",
                parameters: [
                    "branch": "refs/heads/main",
                ] as [String: Any]
            )
        )
        lastMainPushSeconds = mainData.first?.value

        // Last nightly push
        let nightlyData: [TimeSeriesDataPoint] = try await apiClient.fetch(
            .clickhouseQuery(
                name: "last_branch_push",
                parameters: [
                    "branch": "refs/heads/nightly",
                ] as [String: Any]
            )
        )
        lastNightlyPushSeconds = nightlyData.first?.value

        // Last docker build
        let dockerData: [TimeSeriesDataPoint] = try await apiClient.fetch(
            .clickhouseQuery(
                name: "last_successful_workflow",
                parameters: [
                    "workflowName": "docker-builds",
                ] as [String: Any]
            )
        )
        lastDockerBuildSeconds = dockerData.first?.value

        // Last docs push
        let docsData: [TimeSeriesDataPoint] = try await apiClient.fetch(
            .clickhouseQuery(
                name: "last_successful_jobs",
                parameters: [
                    "jobNames": ["docs push / build-docs-python-true", "docs push / build-docs-cpp-true"],
                ] as [String: Any]
            )
        )
        lastDocsPushSeconds = docsData.first?.value

        return true
    }

    private func fetchActivityMetrics(startTime: String, stopTime: String) async throws -> Bool {
        // Reverts
        let revertsData: [TimeSeriesDataPoint] = try await apiClient.fetch(
            .clickhouseQuery(
                name: "reverts",
                parameters: [
                    "startTime": startTime,
                    "stopTime": stopTime,
                ] as [String: Any]
            )
        )
        revertsCount = revertsData.first?.value.map { Int($0) }

        // Commits
        let commitsData: [TimeSeriesDataPoint] = try await apiClient.fetch(
            .clickhouseQuery(
                name: "num_commits_master",
                parameters: [
                    "startTime": startTime,
                    "stopTime": stopTime,
                ] as [String: Any]
            )
        )
        commitsCount = commitsData.first?.value.map { Int($0) }

        return true
    }

    private func fetchQueueTime(startTime: String, stopTime: String, granularity: String) async throws -> [TimeSeriesDataPoint] {
        try await apiClient.fetch(
            .clickhouseQuery(
                name: "queue_times_historical",
                parameters: [
                    "startTime": startTime,
                    "stopTime": stopTime,
                    "granularity": granularity,
                ] as [String: Any]
            )
        )
    }

    private func fetchDisabledTests(startTime: String, stopTime: String, granularity: String) async throws -> [TimeSeriesDataPoint] {
        try await apiClient.fetch(
            .clickhouseQuery(
                name: "disabled_test_historical",
                parameters: [
                    "startTime": startTime,
                    "stopTime": stopTime,
                    "repo": "pytorch/pytorch",
                ] as [String: Any]
            )
        )
    }

    // MARK: - Helpers

    private func computeTrend(from timeSeries: [TimeSeriesDataPoint]) -> Double? {
        guard timeSeries.count >= 2 else { return nil }

        // Compare first half vs second half
        let midpoint = timeSeries.count / 2
        let firstHalf = timeSeries[..<midpoint]
        let secondHalf = timeSeries[midpoint...]

        let firstAvg = firstHalf.compactMap { $0.value }.reduce(0, +) / Double(firstHalf.count)
        let secondAvg = secondHalf.compactMap { $0.value }.reduce(0, +) / Double(secondHalf.count)

        guard firstAvg != 0 else { return nil }
        return ((secondAvg - firstAvg) / firstAvg) * 100
    }
}
