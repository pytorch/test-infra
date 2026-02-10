import Foundation
import SwiftUI

@MainActor
final class UtilizationViewModel: ObservableObject {
    // MARK: - Types

    enum ViewState: Equatable {
        case idle
        case loading
        case loaded
        case error(String)

        static func == (lhs: ViewState, rhs: ViewState) -> Bool {
            switch (lhs, rhs) {
            case (.idle, .idle), (.loading, .loading), (.loaded, .loaded):
                return true
            case let (.error(a), .error(b)):
                return a == b
            default:
                return false
            }
        }
    }

    enum GroupBy: String, CaseIterable, CustomStringConvertible {
        case workflow = "workflow_name"
        case job = "job_name"
        case runnerType = "runner_type"

        var description: String {
            switch self {
            case .workflow: return "Workflow"
            case .job: return "Job"
            case .runnerType: return "Runner Type"
            }
        }
    }

    enum SortField: CaseIterable {
        case name
        case cpu
        case memory
        case totalJobs

        var label: String {
            switch self {
            case .name: return "Name"
            case .cpu: return "Avg CPU"
            case .memory: return "Avg Memory"
            case .totalJobs: return "Total Jobs"
            }
        }
    }

    enum TimeRange: String, CaseIterable, CustomStringConvertible {
        case today = "Today"
        case yesterday = "Yesterday"
        case last7Days = "Last 7 Days"
        case last30Days = "Last 30 Days"
        case custom = "Custom"

        var description: String { rawValue }

        var dateRange: (start: Date, end: Date)? {
            let calendar = Calendar.current
            let now = Date()
            let today = calendar.startOfDay(for: now)

            switch self {
            case .today:
                return (today, now)
            case .yesterday:
                guard let yesterday = calendar.date(byAdding: .day, value: -1, to: today) else { return nil }
                return (yesterday, today)
            case .last7Days:
                guard let start = calendar.date(byAdding: .day, value: -7, to: today) else { return nil }
                return (start, now)
            case .last30Days:
                guard let start = calendar.date(byAdding: .day, value: -30, to: today) else { return nil }
                return (start, now)
            case .custom:
                return nil
            }
        }
    }

    // MARK: - State

    @Published var state: ViewState = .idle
    @Published var reports: [UtilizationReport] = []
    @Published var selectedGroupBy: GroupBy = .workflow
    @Published var sortField: SortField = .totalJobs
    @Published var sortAscending: Bool = false
    @Published var selectedTimeRange: TimeRange = .last7Days
    @Published var customStartDate: Date = Calendar.current.date(byAdding: .day, value: -7, to: Date()) ?? Date()
    @Published var customEndDate: Date = Date()
    @Published var showingDatePicker: Bool = false

    // MARK: - Dependencies

    private let apiClient: APIClientProtocol
    private var loadTask: Task<Void, Never>?

    // MARK: - Computed

    var sortedReports: [UtilizationReport] {
        reports.sorted { a, b in
            let result: Bool
            switch sortField {
            case .name:
                result = a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
            case .cpu:
                result = (a.avgCpu ?? 0) < (b.avgCpu ?? 0)
            case .memory:
                result = (a.avgMemory ?? 0) < (b.avgMemory ?? 0)
            case .totalJobs:
                result = (a.totalJobs ?? 0) < (b.totalJobs ?? 0)
            }
            return sortAscending ? result : !result
        }
    }

    var isLoading: Bool {
        state == .loading
    }

    var averageCPU: Double {
        let values = reports.compactMap(\.avgCpu)
        guard !values.isEmpty else { return 0 }
        return values.reduce(0, +) / Double(values.count)
    }

    var averageMemory: Double {
        let values = reports.compactMap(\.avgMemory)
        guard !values.isEmpty else { return 0 }
        return values.reduce(0, +) / Double(values.count)
    }

    var totalJobsCount: Int {
        reports.compactMap(\.totalJobs).reduce(0, +)
    }

    var lowUtilizationCount: Int {
        reports.filter { ($0.avgCpu ?? 0) < 40 || ($0.avgMemory ?? 0) < 40 }.count
    }

    var mediumUtilizationCount: Int {
        reports.filter {
            let cpu = $0.avgCpu ?? 0
            let mem = $0.avgMemory ?? 0
            return (cpu >= 40 && cpu < 70) || (mem >= 40 && mem < 70)
        }.count
    }

    var highUtilizationCount: Int {
        reports.filter { ($0.avgCpu ?? 0) >= 70 && ($0.avgMemory ?? 0) >= 70 }.count
    }

    var utilizationDistribution: [(category: String, count: Int, color: Color)] {
        [
            ("Low (<40%)", lowUtilizationCount, AppColors.success),
            ("Medium (40-70%)", mediumUtilizationCount, AppColors.unstable),
            ("High (>70%)", highUtilizationCount, AppColors.failure)
        ]
    }

    // MARK: - Init

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    // MARK: - Actions

    func loadData() async {
        if state != .loaded {
            state = .loading
        }
        do {
            let dateRange = resolvedDateRange
            let endpoint = Self.utilizationEndpoint(
                groupBy: selectedGroupBy.rawValue,
                startDate: dateRange.start,
                endDate: dateRange.end
            )
            let result: UtilizationReportResponse = try await apiClient.fetch(endpoint)
            reports = result.metadataList ?? []
            state = .loaded
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    /// Returns the resolved (start, end) date pair for the currently selected time range.
    var resolvedDateRange: (start: Date, end: Date) {
        if selectedTimeRange == .custom {
            return (customStartDate, customEndDate)
        }
        return selectedTimeRange.dateRange ?? (Date(), Date())
    }

    /// Build the utilization endpoint with proper date range support.
    static func utilizationEndpoint(groupBy: String, startDate: Date, endDate: Date) -> APIEndpoint {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: "UTC")
        let start = formatter.string(from: startDate)
        let end = formatter.string(from: endDate)
        return APIEndpoint(
            path: "/api/list_util_reports/\(groupBy)",
            queryItems: [
                URLQueryItem(name: "repo", value: "pytorch/pytorch"),
                URLQueryItem(name: "group_by", value: groupBy),
                URLQueryItem(name: "granularity", value: "day"),
                URLQueryItem(name: "start_time", value: start),
                URLQueryItem(name: "end_time", value: end),
                URLQueryItem(name: "parent_group", value: ""),
            ]
        )
    }

    func refresh() async {
        await loadData()
    }

    func selectGroupBy(_ groupBy: GroupBy) {
        guard groupBy != selectedGroupBy else { return }
        loadTask?.cancel()
        selectedGroupBy = groupBy
        reports = []
        loadTask = Task { await loadData() }
    }

    func toggleSort(_ field: SortField) {
        if sortField == field {
            sortAscending.toggle()
        } else {
            sortField = field
            sortAscending = false
        }
    }

    func sortIcon(for field: SortField) -> String? {
        guard sortField == field else { return nil }
        return sortAscending ? "chevron.up" : "chevron.down"
    }

    func selectTimeRange(_ range: TimeRange) {
        loadTask?.cancel()
        selectedTimeRange = range
        if range == .custom {
            showingDatePicker = true
        } else {
            loadTask = Task { await refresh() }
        }
    }

    func applyCustomDateRange() {
        loadTask?.cancel()
        showingDatePicker = false
        loadTask = Task { await refresh() }
    }

    func utilizationLevel(cpu: Double?, memory: Double?) -> (text: String, color: Color) {
        let avgUtil = ((cpu ?? 0) + (memory ?? 0)) / 2
        if avgUtil >= 70 {
            return ("High", AppColors.failure)
        } else if avgUtil >= 40 {
            return ("Medium", AppColors.unstable)
        } else {
            return ("Low", AppColors.success)
        }
    }
}
