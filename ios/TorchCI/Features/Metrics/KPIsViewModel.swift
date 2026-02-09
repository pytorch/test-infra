import Foundation
import SwiftUI

@MainActor
final class KPIsViewModel: ObservableObject {
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
    @Published var kpis: [KPIData] = []
    @Published var sparklines: [String: [TimeSeriesDataPoint]] = [:]
    @Published var selectedTimeRange: TimeRange = TimeRange.presets[6] // 6 months default

    private let apiClient: APIClientProtocol

    // MARK: - KPI Definitions

    struct KPIDefinition: Sendable {
        let queryName: String
        let displayName: String
        let unit: String
        let lowerIsBetter: Bool
        /// The actual clickhouse query name (may differ from queryName for ttrs variants).
        let actualQueryName: String
        /// For multi-row queries, filter to this series name (matched against TimeSeriesDataPoint.seriesName).
        let filterName: String?
        let paramBuilder: @Sendable (String, String) -> [String: Any]
    }

    static let kpiDefinitionTemplates: [KPIDefinition] = [
        // 1. % of commits red on trunk (Weekly)
        KPIDefinition(
            queryName: "master_commit_red_percent",
            displayName: "Commits Red on Trunk",
            unit: "%",
            lowerIsBetter: true,
            actualQueryName: "master_commit_red_percent",
            filterName: "Total",
            paramBuilder: { startTime, stopTime in
                [
                    "startTime": startTime,
                    "stopTime": stopTime,
                    "granularity": "week",
                    "workflowNames": ["lint", "pull", "trunk"],
                ] as [String: Any]
            }
        ),
        // 2. # of force merges (Weekly)
        KPIDefinition(
            queryName: "number_of_force_pushes_historical",
            displayName: "Force Merges",
            unit: "",
            lowerIsBetter: true,
            actualQueryName: "number_of_force_pushes_historical",
            filterName: nil,
            paramBuilder: { startTime, stopTime in
                [
                    "startTime": startTime,
                    "stopTime": stopTime,
                    "granularity": "week",
                ] as [String: Any]
            }
        ),
        // 3. Time to Red Signal - p50 (Weekly, pull workflow)
        KPIDefinition(
            queryName: "ttrs_percentiles_p50",
            displayName: "TTRS p50 (pull)",
            unit: "min",
            lowerIsBetter: true,
            actualQueryName: "ttrs_percentiles",
            filterName: nil,
            paramBuilder: { startTime, stopTime in
                [
                    "startTime": startTime,
                    "stopTime": stopTime,
                    "one_bucket": false,
                    "percentile_to_get": 0.5,
                    "workflow": "pull",
                ] as [String: Any]
            }
        ),
        // 4. % of force merges (Weekly, 2 week rolling avg)
        KPIDefinition(
            queryName: "weekly_force_merge_stats",
            displayName: "Force Merges %",
            unit: "%",
            lowerIsBetter: true,
            actualQueryName: "weekly_force_merge_stats",
            filterName: "All Force Merges",
            paramBuilder: { startTime, stopTime in
                [
                    "startTime": startTime,
                    "stopTime": stopTime,
                    "one_bucket": false,
                    "merge_type": "",
                    "granularity": "week",
                ] as [String: Any]
            }
        ),
        // 5. Avg time-to-signal - E2E (Weekly)
        KPIDefinition(
            queryName: "time_to_signal",
            displayName: "Avg TTS E2E",
            unit: "hours",
            lowerIsBetter: true,
            actualQueryName: "time_to_signal",
            filterName: nil,
            paramBuilder: { startTime, stopTime in
                [
                    "startTime": startTime,
                    "stopTime": stopTime,
                ] as [String: Any]
            }
        ),
        // 6. # of reverts (2 week moving avg)
        KPIDefinition(
            queryName: "num_reverts",
            displayName: "Reverts",
            unit: "",
            lowerIsBetter: true,
            actualQueryName: "num_reverts",
            filterName: "total",
            paramBuilder: { startTime, stopTime in
                [
                    "startTime": startTime,
                    "stopTime": stopTime,
                ] as [String: Any]
            }
        ),
        // 7. viable/strict lag (Daily)
        KPIDefinition(
            queryName: "strict_lag_historical",
            displayName: "Viable/Strict Lag",
            unit: "hours",
            lowerIsBetter: true,
            actualQueryName: "strict_lag_historical",
            filterName: nil,
            paramBuilder: { startTime, stopTime in
                [
                    "startTime": startTime,
                    "stopTime": stopTime,
                    "granularity": "day",
                    "repoFullName": "pytorch/pytorch",
                ] as [String: Any]
            }
        ),
        // 8. Weekly external PR count (4 week moving average)
        KPIDefinition(
            queryName: "external_contribution_stats",
            displayName: "External PRs (weekly)",
            unit: "",
            lowerIsBetter: false,
            actualQueryName: "external_contribution_stats",
            filterName: nil,
            paramBuilder: { startTime, stopTime in
                [
                    "startTime": startTime,
                    "stopTime": stopTime,
                    "granularity": "week",
                ] as [String: Any]
            }
        ),
        // 9. Monthly external PR count
        KPIDefinition(
            queryName: "monthly_contribution_stats",
            displayName: "External PRs (monthly)",
            unit: "",
            lowerIsBetter: false,
            actualQueryName: "monthly_contribution_stats",
            filterName: nil,
            paramBuilder: { startTime, stopTime in
                [
                    "startTime": startTime,
                    "stopTime": stopTime,
                    "granularity": "month",
                ] as [String: Any]
            }
        ),
        // 10. Total number of open disabled tests (Daily)
        KPIDefinition(
            queryName: "disabled_test_historical",
            displayName: "Disabled Tests",
            unit: "",
            lowerIsBetter: true,
            actualQueryName: "disabled_test_historical",
            filterName: nil,
            paramBuilder: { startTime, stopTime in
                [
                    "startTime": startTime,
                    "stopTime": stopTime,
                    "repo": "pytorch/pytorch",
                ] as [String: Any]
            }
        ),
    ]

    // MARK: - Init

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    // MARK: - Data Loading

    func loadKPIs() async {
        state = .loading

        let range = APIEndpoint.timeRange(days: selectedTimeRange.days)
        let definitions = Self.kpiDefinitionTemplates

        // Build endpoints outside the task group to avoid capturing [String: Any] in @Sendable closures
        struct FetchTask: Sendable {
            let queryName: String
            let endpoint: APIEndpoint
        }

        let tasks: [FetchTask] = definitions.map { definition in
            let params = definition.paramBuilder(range.startTime, range.stopTime)
            let endpoint = APIEndpoint.clickhouseQuery(
                name: definition.actualQueryName,
                parameters: params
            )
            return FetchTask(queryName: definition.queryName, endpoint: endpoint)
        }

        // Fetch each KPI independently so one failure does not break the entire page.
        let client = apiClient
        let results = await withTaskGroup(of: (String, [TimeSeriesDataPoint]?, Error?).self, returning: [(String, [TimeSeriesDataPoint]?, Error?)].self) { group in
            for task in tasks {
                let endpoint = task.endpoint
                let queryName = task.queryName
                group.addTask {
                    do {
                        let data: [TimeSeriesDataPoint] = try await client.fetch(endpoint)
                        return (queryName, data, nil)
                    } catch {
                        return (queryName, nil, error)
                    }
                }
            }
            var collected: [(String, [TimeSeriesDataPoint]?, Error?)] = []
            for await result in group {
                collected.append(result)
            }
            return collected
        }

        var allSparklines: [String: [TimeSeriesDataPoint]] = [:]
        var allKPIs: [KPIData] = []
        var failedQueries: [String] = []

        for (queryName, rawData, error) in results {
            guard let definition = definitions.first(where: { $0.queryName == queryName }) else {
                continue
            }

            if let error {
                failedQueries.append("\(definition.displayName): \(error.localizedDescription)")
                continue
            }

            guard let rawData else { continue }

            // For multi-row queries, filter to the requested series
            let data: [TimeSeriesDataPoint]
            if let filterName = definition.filterName {
                data = rawData.filter { $0.seriesName == filterName }
            } else {
                data = rawData
            }

            allSparklines[queryName] = data

            let current = data.last?.value ?? 0
            // For trend, compare against roughly 1 month ago.
            // Use 1/6th of the data range (for a default 6-month window = ~1 month)
            // which adapts to any granularity (day, week, month).
            let lookback = max(1, data.count / 6)
            let previousIndex = max(0, data.count - 1 - lookback)
            let previous = data.indices.contains(previousIndex) ? data[previousIndex].value : nil

            let kpi = KPIData(
                name: definition.displayName,
                current: current,
                previous: previous,
                target: nil,
                unit: definition.unit.isEmpty ? nil : definition.unit,
                lowerIsBetter: definition.lowerIsBetter
            )
            allKPIs.append(kpi)
        }

        sparklines = allSparklines
        kpis = definitions.compactMap { definition in
            allKPIs.first { $0.name == definition.displayName }
        }

        if allKPIs.isEmpty && !failedQueries.isEmpty {
            // All queries failed – show a combined error
            state = .error(failedQueries.joined(separator: "\n"))
        } else {
            // At least some KPIs loaded successfully
            state = .loaded
        }
    }

    func refresh() async {
        await loadKPIs()
    }

    func changeTimeRange(_ range: TimeRange) async {
        selectedTimeRange = range
        await loadKPIs()
    }

    // MARK: - Helpers

    func sparkline(for kpi: KPIData) -> [TimeSeriesDataPoint] {
        let definition = Self.kpiDefinitionTemplates.first { $0.displayName == kpi.name }
        guard let queryName = definition?.queryName else { return [] }
        return sparklines[queryName] ?? []
    }

    func formatValue(for kpi: KPIData) -> String {
        if let unit = kpi.unit {
            switch unit {
            case "%":
                return String(format: "%.1f%%", kpi.current)
            case "min":
                let minutes = Int(kpi.current)
                if minutes >= 60 {
                    return "\(minutes / 60)h \(minutes % 60)m"
                }
                return "\(minutes)m"
            case "hours":
                return String(format: "%.1fh", kpi.current)
            default:
                return String(format: "%.0f %@", kpi.current, unit)
            }
        }
        return String(format: "%.0f", kpi.current)
    }

    func color(for kpi: KPIData) -> SwiftUI.Color {
        if kpi.isImproving {
            return AppColors.success
        }
        return AppColors.failure
    }
}
