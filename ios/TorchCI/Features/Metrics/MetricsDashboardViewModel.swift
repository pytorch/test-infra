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

    // MARK: - Scalar response structs matching actual ClickHouse query output

    /// strict_lag_sec query returns: { "strict_lag_sec": 12345 }
    private struct StrictLagResponse: Decodable {
        let strict_lag_sec: Double

        enum CodingKeys: String, CodingKey {
            case strict_lag_sec
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            // Handle both numeric and string-encoded values
            if let v = try? container.decode(Double.self, forKey: .strict_lag_sec) {
                strict_lag_sec = v
            } else if let s = try? container.decode(String.self, forKey: .strict_lag_sec),
                      let v = Double(s) {
                strict_lag_sec = v
            } else {
                strict_lag_sec = 0
            }
        }
    }

    /// last_branch_push query returns: { "push_seconds_ago": 12345 }
    private struct PushSecondsAgoResponse: Decodable {
        let push_seconds_ago: Double

        enum CodingKeys: String, CodingKey {
            case push_seconds_ago
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            if let v = try? container.decode(Double.self, forKey: .push_seconds_ago) {
                push_seconds_ago = v
            } else if let s = try? container.decode(String.self, forKey: .push_seconds_ago),
                      let v = Double(s) {
                push_seconds_ago = v
            } else {
                push_seconds_ago = 0
            }
        }
    }

    /// last_successful_workflow / last_successful_jobs returns: { "last_success_seconds_ago": 12345 }
    private struct LastSuccessResponse: Decodable {
        let last_success_seconds_ago: Double

        enum CodingKeys: String, CodingKey {
            case last_success_seconds_ago
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            if let v = try? container.decode(Double.self, forKey: .last_success_seconds_ago) {
                last_success_seconds_ago = v
            } else if let s = try? container.decode(String.self, forKey: .last_success_seconds_ago),
                      let v = Double(s) {
                last_success_seconds_ago = v
            } else {
                last_success_seconds_ago = 0
            }
        }
    }

    /// merge_retry_rate returns: { "avg_retry_rate": 1.23 }
    private struct RetryRateResponse: Decodable {
        let avg_retry_rate: Double

        enum CodingKeys: String, CodingKey {
            case avg_retry_rate
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            if let v = try? container.decode(Double.self, forKey: .avg_retry_rate) {
                avg_retry_rate = v
            } else if let s = try? container.decode(String.self, forKey: .avg_retry_rate),
                      let v = Double(s) {
                avg_retry_rate = v
            } else {
                avg_retry_rate = 0
            }
        }
    }

    /// pr_landing_time_avg returns: { "avg_hours": 1.23 }
    private struct LandingTimeResponse: Decodable {
        let avg_hours: Double

        enum CodingKeys: String, CodingKey {
            case avg_hours
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            if let v = try? container.decode(Double.self, forKey: .avg_hours) {
                avg_hours = v
            } else if let s = try? container.decode(String.self, forKey: .avg_hours),
                      let v = Double(s) {
                avg_hours = v
            } else {
                avg_hours = 0
            }
        }
    }

    /// workflow_duration_avg/percentile returns: { "duration_sec": 12345, "name": "pull" }
    private struct WorkflowDurationResponse: Decodable {
        let duration_sec: Double
        let name: String?

        enum CodingKeys: String, CodingKey {
            case duration_sec
            case name
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            if let v = try? container.decode(Double.self, forKey: .duration_sec) {
                duration_sec = v
            } else if let s = try? container.decode(String.self, forKey: .duration_sec),
                      let v = Double(s) {
                duration_sec = v
            } else {
                duration_sec = 0
            }
            name = try? container.decodeIfPresent(String.self, forKey: .name)
        }
    }

    /// queued_jobs_by_label returns: { "count": 5, "avg_queue_s": 300, "machine_type": "linux.2xlarge", "time": "..." }
    private struct QueuedJobsResponse: Decodable {
        let count: Int
        let avg_queue_s: Double
        let machine_type: String

        enum CodingKeys: String, CodingKey {
            case count, avg_queue_s, machine_type
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            if let v = try? container.decode(Int.self, forKey: .count) {
                count = v
            } else if let s = try? container.decode(String.self, forKey: .count),
                      let v = Int(s) {
                count = v
            } else {
                count = 0
            }
            if let v = try? container.decode(Double.self, forKey: .avg_queue_s) {
                avg_queue_s = v
            } else if let s = try? container.decode(String.self, forKey: .avg_queue_s),
                      let v = Double(s) {
                avg_queue_s = v
            } else {
                avg_queue_s = 0
            }
            machine_type = (try? container.decode(String.self, forKey: .machine_type)) ?? ""
        }
    }

    /// master_commit_red_avg returns: { "broken_trunk_red": 0.05, "flaky_red": 0.10 }
    private struct CommitRedData: Decodable {
        let broken_trunk_red: Double?
        let flaky_red: Double?
    }

    /// disabled_test_historical returns: { "day": "2024-01-01", "count": 100, "new": 5, "deleted": 3 }
    private struct DisabledTestHistoricalRow: Decodable {
        let day: String
        let count: Int?
        let new_tests: Int?
        let deleted: Int?

        enum CodingKeys: String, CodingKey {
            case day, count, deleted
            case new_tests = "new"
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            day = (try? container.decode(String.self, forKey: .day)) ?? ""
            if let v = try? container.decode(Int.self, forKey: .count) {
                count = v
            } else if let s = try? container.decode(String.self, forKey: .count), let v = Int(s) {
                count = v
            } else {
                count = nil
            }
            if let v = try? container.decode(Int.self, forKey: .new_tests) {
                new_tests = v
            } else if let s = try? container.decode(String.self, forKey: .new_tests), let v = Int(s) {
                new_tests = v
            } else {
                new_tests = nil
            }
            if let v = try? container.decode(Int.self, forKey: .deleted) {
                deleted = v
            } else if let s = try? container.decode(String.self, forKey: .deleted), let v = Int(s) {
                deleted = v
            } else {
                deleted = nil
            }
        }
    }

    /// queue_times_historical returns: { "granularity_bucket": "2024-01-01", "avg_queue_s": 300, "machine_type": "linux.2xlarge" }
    private struct QueueTimeHistoricalRow: Decodable {
        let granularity_bucket: String
        let avg_queue_s: Double
        let machine_type: String

        enum CodingKeys: String, CodingKey {
            case granularity_bucket, avg_queue_s, machine_type
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            granularity_bucket = (try? container.decode(String.self, forKey: .granularity_bucket)) ?? ""
            if let v = try? container.decode(Double.self, forKey: .avg_queue_s) {
                avg_queue_s = v
            } else if let s = try? container.decode(String.self, forKey: .avg_queue_s),
                      let v = Double(s) {
                avg_queue_s = v
            } else {
                avg_queue_s = 0
            }
            machine_type = (try? container.decode(String.self, forKey: .machine_type)) ?? ""
        }
    }

    /// lf_rollover_percentage returns: { "bucket": "2024-01-01", "fleet": "...", "percentage": 45.6 }
    private struct LFRolloverRow: Decodable {
        let bucket: String
        let percentage: Double

        enum CodingKeys: String, CodingKey {
            case bucket, percentage
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            bucket = (try? container.decode(String.self, forKey: .bucket)) ?? ""
            if let v = try? container.decode(Double.self, forKey: .percentage) {
                percentage = v
            } else if let s = try? container.decode(String.self, forKey: .percentage),
                      let v = Double(s) {
                percentage = v
            } else {
                percentage = 0
            }
        }
    }

    // MARK: - State

    enum ViewState: Equatable {
        case idle
        case loading
        case loaded
        case error(String)

        static func == (lhs: ViewState, rhs: ViewState) -> Bool {
            switch (lhs, rhs) {
            case (.idle, .idle): return true
            case (.loading, .loading): return true
            case (.loaded, .loaded): return true
            case (.error(let a), .error(let b)): return a == b
            default: return false
            }
        }
    }

    @Published var state: ViewState = .idle
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
    private var fetchTask: Task<Void, Never>?

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
        guard state == .idle else { return }
        state = .loading
        await fetchAllMetrics()
    }

    func refresh() async {
        fetchTask?.cancel()
        let task = Task { await fetchAllMetrics() }
        fetchTask = task
        await task.value
    }

    func onParametersChanged() async {
        fetchTask?.cancel()
        let task = Task { await fetchAllMetrics() }
        fetchTask = task
        await task.value
    }

    private func fetchAllMetrics() async {
        guard !Task.isCancelled else { return }
        let range = timeRangeTuple
        let gran = granularity.rawValue
        let client = apiClient

        // Fetch ALL metrics in parallel using async let for maximum speed.
        // Each call is wrapped in try? so individual failures don't block others.

        // --- Time series ---
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

        // queue_times_historical: returns multiple rows per bucket (one per machine_type).
        // We aggregate to max across machine types per bucket.
        async let queueTimeRawResult: [QueueTimeHistoricalRow]? = try? client.fetch(
            .clickhouseQuery(
                name: "queue_times_historical",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "granularity": gran,
                ] as [String: Any]
            )
        )

        // disabled_test_historical: params.json expects label, platform, triaged, startTime, stopTime.
        // Missing params default to empty strings on the server (disables those filters).
        async let disabledTestsRawResult: [DisabledTestHistoricalRow]? = try? client.fetch(
            .clickhouseQuery(
                name: "disabled_test_historical",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "label": "",
                    "platform": "",
                    "triaged": "",
                ] as [String: Any]
            )
        )

        // --- Commit Health ---
        async let commitRedResult: [CommitRedData]? = try? client.fetch(
            .clickhouseQuery(
                name: "master_commit_red_avg",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "workflowNames": ["lint", "pull", "trunk", "linux-aarch64"],
                ] as [String: Any]
            )
        )

        async let strictLagResult: [StrictLagResponse]? = try? client.fetch(
            .clickhouseQuery(
                name: "strict_lag_sec",
                parameters: [
                    "repo": "pytorch",
                    "owner": "pytorch",
                    "head": "refs/heads/main",
                ] as [String: Any]
            )
        )

        // --- Merge Metrics ---
        // Force merge failure (use one_bucket: true for a single scalar, matching web frontend)
        async let forceMergeFailureResult: [TimeSeriesDataPoint]? = try? client.fetch(
            .clickhouseQuery(
                name: "weekly_force_merge_stats",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "merge_type": "Failure",
                    "one_bucket": true,
                    "granularity": "week",
                ] as [String: Any]
            )
        )

        // Force merge impatience
        async let forceMergeImpatienceResult: [TimeSeriesDataPoint]? = try? client.fetch(
            .clickhouseQuery(
                name: "weekly_force_merge_stats",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "merge_type": "Impatience",
                    "one_bucket": true,
                    "granularity": "week",
                ] as [String: Any]
            )
        )

        // Force merge time series (for trend computation, all types)
        async let forceMergeTrendResult: [TimeSeriesDataPoint]? = try? client.fetch(
            .clickhouseQuery(
                name: "weekly_force_merge_stats",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "merge_type": "Failure",
                    "one_bucket": false,
                    "granularity": gran,
                ] as [String: Any]
            )
        )

        async let forceMergeImpTrendResult: [TimeSeriesDataPoint]? = try? client.fetch(
            .clickhouseQuery(
                name: "weekly_force_merge_stats",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "merge_type": "Impatience",
                    "one_bucket": false,
                    "granularity": gran,
                ] as [String: Any]
            )
        )

        // Merge retry rate
        async let retryRateResult: [RetryRateResponse]? = try? client.fetch(
            .clickhouseQuery(
                name: "merge_retry_rate",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                ] as [String: Any]
            )
        )

        // PR landing time
        async let landingTimeResult: [LandingTimeResponse]? = try? client.fetch(
            .clickhouseQuery(
                name: "pr_landing_time_avg",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                ] as [String: Any]
            )
        )

        // --- Signal Metrics ---
        // TTRS p90 (one_bucket: true for single scalar)
        async let ttrsP90Result: [TimeSeriesDataPoint]? = try? client.fetch(
            .clickhouseQuery(
                name: "ttrs_percentiles",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "one_bucket": true,
                    "percentile_to_get": 0.9,
                    "workflow": "pull",
                ] as [String: Any]
            )
        )

        // TTRS p75
        async let ttrsP75Result: [TimeSeriesDataPoint]? = try? client.fetch(
            .clickhouseQuery(
                name: "ttrs_percentiles",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "one_bucket": true,
                    "percentile_to_get": 0.75,
                    "workflow": "pull",
                ] as [String: Any]
            )
        )

        // Workflow TTS - use correct query based on percentile selection.
        // workflow_duration_avg returns multiple rows (one per workflow name);
        // workflow_duration_percentile returns a single max(duration_sec).
        let ttsQueryName = selectedPercentile == -1.0 ? "workflow_duration_avg" : "workflow_duration_percentile"
        var ttsParams: [String: Any] = [
            "startTime": range.startTime,
            "stopTime": range.stopTime,
            "workflowNames": ["pull", "trunk"],
        ]
        if selectedPercentile != -1.0 {
            ttsParams["percentile"] = selectedPercentile
        }
        async let ttsResult: [WorkflowDurationResponse]? = try? client.fetch(
            .clickhouseQuery(name: ttsQueryName, parameters: ttsParams)
        )

        // Queued jobs (current snapshot, no time params)
        async let queuedJobsResult: [QueuedJobsResponse]? = try? client.fetch(
            .clickhouseQuery(
                name: "queued_jobs_by_label",
                parameters: [:] as [String: Any]
            )
        )

        // --- Build Health ---
        async let mainPushResult: [PushSecondsAgoResponse]? = try? client.fetch(
            .clickhouseQuery(
                name: "last_branch_push",
                parameters: [
                    "branch": "refs/heads/main",
                ] as [String: Any]
            )
        )

        async let nightlyPushResult: [PushSecondsAgoResponse]? = try? client.fetch(
            .clickhouseQuery(
                name: "last_branch_push",
                parameters: [
                    "branch": "refs/heads/nightly",
                ] as [String: Any]
            )
        )

        async let dockerBuildResult: [LastSuccessResponse]? = try? client.fetch(
            .clickhouseQuery(
                name: "last_successful_workflow",
                parameters: [
                    "workflowName": "docker-builds",
                ] as [String: Any]
            )
        )

        async let docsPushResult: [LastSuccessResponse]? = try? client.fetch(
            .clickhouseQuery(
                name: "last_successful_jobs",
                parameters: [
                    "jobNames": ["docs push / build-docs-python-true", "docs push / build-docs-cpp-true"],
                ] as [String: Any]
            )
        )

        // --- Activity Metrics ---
        async let revertsResult: [TimeSeriesDataPoint]? = try? client.fetch(
            .clickhouseQuery(
                name: "reverts",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                ] as [String: Any]
            )
        )

        async let commitsResult: [TimeSeriesDataPoint]? = try? client.fetch(
            .clickhouseQuery(
                name: "num_commits_master",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                ] as [String: Any]
            )
        )

        // LF Rollover percentage
        async let lfRolloverResult: [LFRolloverRow]? = try? client.fetch(
            .clickhouseQuery(
                name: "lf_rollover_percentage",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "granularity": gran,
                ] as [String: Any]
            )
        )

        // === Await all results and assign to published properties ===
        guard !Task.isCancelled else { return }

        // Time series
        redRateSeries = await redRateResult ?? []

        // Queue time: aggregate max queue_s across machine types per bucket
        if let rawQueue = await queueTimeRawResult {
            var bucketMax: [String: Double] = [:]
            for row in rawQueue {
                let current = bucketMax[row.granularity_bucket] ?? 0
                bucketMax[row.granularity_bucket] = max(current, row.avg_queue_s)
            }
            queueTimeSeries = bucketMax
                .map { TimeSeriesDataPoint(granularity_bucket: $0.key, value: $0.value) }
                .sorted { $0.granularity_bucket < $1.granularity_bucket }
        } else {
            queueTimeSeries = []
        }

        // Disabled tests: convert to time series (using "new" count for chart)
        if let rawDisabled = await disabledTestsRawResult {
            disabledTestsSeries = rawDisabled.map {
                TimeSeriesDataPoint(
                    granularity_bucket: $0.day,
                    value: $0.new_tests.map { Double($0) }
                )
            }
            // Use last row's "count" for the total disabled tests count
            disabledTestsCount = rawDisabled.last?.count
        } else {
            disabledTestsSeries = []
            disabledTestsCount = nil
        }

        // Commit Health
        if let commitRed = await commitRedResult, let first = commitRed.first {
            brokenTrunkPercent = first.broken_trunk_red.map { $0 * 100 }
            flakyRedPercent = first.flaky_red.map { $0 * 100 }
        } else {
            // Fallback: use last value from red rate series
            if let lastRed = redRateSeries.last?.value {
                brokenTrunkPercent = lastRed
            }
            flakyRedPercent = nil
        }

        viableStrictLagSeconds = await strictLagResult?.first?.strict_lag_sec

        // Compute trends from red rate series
        brokenTrunkTrend = computeTrend(from: redRateSeries)

        // Merge Metrics
        forceMergeFailurePercent = await forceMergeFailureResult?.first?.value
        forceMergeImpatiencePercent = await forceMergeImpatienceResult?.first?.value

        let failureTrendSeries = await forceMergeTrendResult ?? []
        forceMergeFailureTrend = computeTrend(from: failureTrendSeries)

        let impatienceTrendSeries = await forceMergeImpTrendResult ?? []
        forceMergeImpatienceTrend = computeTrend(from: impatienceTrendSeries)

        mergeRetryRate = await retryRateResult?.first?.avg_retry_rate
        prLandingTimeHours = await landingTimeResult?.first?.avg_hours

        // Signal Metrics - ttrs_percentiles returns "custom" field for the requested percentile
        ttrsP90Minutes = await ttrsP90Result?.first?.value
        ttrsP75Minutes = await ttrsP75Result?.first?.value

        // Workflow TTS: for avg query, take max across workflow names; for percentile, single row
        if let ttsRows = await ttsResult, !ttsRows.isEmpty {
            if selectedPercentile == -1.0 {
                // avg query returns one row per workflow, take the max
                workflowTTSSeconds = ttsRows.map(\.duration_sec).max()
            } else {
                workflowTTSSeconds = ttsRows.first?.duration_sec
            }
        } else {
            workflowTTSSeconds = nil
        }

        // Queue time current: average avg_queue_s across all machine types
        if let queuedJobs = await queuedJobsResult, !queuedJobs.isEmpty {
            let totalQueueS = queuedJobs.reduce(0.0) { $0 + $1.avg_queue_s }
            avgQueueTimeSeconds = totalQueueS / Double(queuedJobs.count)
        } else {
            avgQueueTimeSeconds = nil
        }

        // Build Health
        lastMainPushSeconds = await mainPushResult?.first?.push_seconds_ago
        lastNightlyPushSeconds = await nightlyPushResult?.first?.push_seconds_ago
        lastDockerBuildSeconds = await dockerBuildResult?.first?.last_success_seconds_ago
        lastDocsPushSeconds = await docsPushResult?.first?.last_success_seconds_ago

        // Activity Metrics
        revertsCount = await revertsResult?.last?.value.map { Int($0) }
        commitsCount = await commitsResult?.last?.value.map { Int($0) }

        // LF Rollover: use most recent bucket's percentage
        lfRolloverPercent = await lfRolloverResult?.last?.percentage

        lastUpdated = Date()
        state = .loaded
    }

    // MARK: - Helpers

    private func computeTrend(from timeSeries: [TimeSeriesDataPoint]) -> Double? {
        guard timeSeries.count >= 2 else { return nil }

        // Compare first half vs second half
        let midpoint = timeSeries.count / 2
        let firstHalf = timeSeries[..<midpoint]
        let secondHalf = timeSeries[midpoint...]

        let firstValues = firstHalf.compactMap { $0.value }
        let secondValues = secondHalf.compactMap { $0.value }

        guard !firstValues.isEmpty, !secondValues.isEmpty else { return nil }

        let firstAvg = firstValues.reduce(0, +) / Double(firstValues.count)
        let secondAvg = secondValues.reduce(0, +) / Double(secondValues.count)

        guard firstAvg != 0 else { return nil }
        return ((secondAvg - firstAvg) / firstAvg) * 100
    }
}
