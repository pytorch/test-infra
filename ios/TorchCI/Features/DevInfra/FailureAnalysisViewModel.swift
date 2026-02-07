import Foundation
import SwiftUI

@MainActor
final class FailureAnalysisViewModel: ObservableObject {
    // MARK: - State

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

    @Published var state: ViewState = .idle
    @Published var searchQuery: String = ""
    @Published var startDate: Date = Calendar.current.date(byAdding: .day, value: -14, to: Date()) ?? Date()
    @Published var endDate: Date = Date()
    @Published var results: [JobData] = []
    @Published var selectedJob: JobData?
    @Published var showDatePicker: Bool = false
    @Published var similarFailuresResult: SimilarFailureResult?
    @Published var isSimilarLoading: Bool = false
    @Published var selectedJobFilters: Set<String> = []

    // MARK: - Dependencies

    private let apiClient: APIClientProtocol

    // MARK: - Computed

    var totalCount: Int {
        similarFailuresResult?.totalCount ?? results.count
    }

    var jobDistribution: [(name: String, count: Int)] {
        // Prefer job counts from similarFailuresResult if available
        if let jobCount = similarFailuresResult?.jobCount {
            return jobCount
                .sorted { $0.value > $1.value }
                .map { (name: $0.key, count: $0.value) }
        }

        // Fall back to computing from results
        var counts: [String: Int] = [:]
        for job in results {
            let name = job.jobName ?? job.name ?? "Unknown"
            counts[name, default: 0] += 1
        }
        return counts.sorted { $0.value > $1.value }.map { (name: $0.key, count: $0.value) }
    }

    var filteredResults: [JobData] {
        let samples = similarFailuresResult?.samples ?? results

        if selectedJobFilters.isEmpty {
            return samples
        }

        return samples.filter { job in
            let jobName = job.jobName ?? job.name ?? "Unknown"
            return selectedJobFilters.contains(jobName)
        }
    }

    /// Histogram data showing failure counts grouped by day over the last 14 days.
    /// Returns array of tuples: (date, mainBranchCount, otherBranchCount)
    /// Uses integer day offsets for reliable sorting across month boundaries.
    var histogramData: [(date: String, main: Int, other: Int)] {
        let samples = similarFailuresResult?.samples ?? results

        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let displayFormatter = DateFormatter()
        displayFormatter.dateFormat = "MM/d"

        // Create 14-day buckets keyed by day offset (0 = oldest, 13 = today)
        var buckets: [(label: String, main: Int, other: Int)] = (0..<14).map { offset in
            let dayIndex = 13 - offset
            let date = calendar.date(byAdding: .day, value: -dayIndex, to: today) ?? today
            return (label: displayFormatter.string(from: date), main: 0, other: 0)
        }

        // Count failures per day
        let highlighted: Set<String> = ["master", "main"]
        let isoFormatter = ISO8601DateFormatter()
        for job in samples {
            guard let timeStr = job.time,
                  let time = isoFormatter.date(from: timeStr) else { continue }

            let jobDay = calendar.startOfDay(for: time)
            let dayDiff = calendar.dateComponents([.day], from: jobDay, to: today).day ?? -1
            let bucketIndex = 13 - dayDiff
            guard bucketIndex >= 0 && bucketIndex < 14 else { continue }

            let branch = job.branch ?? ""
            if highlighted.contains(branch) {
                buckets[bucketIndex].main += 1
            } else {
                buckets[bucketIndex].other += 1
            }
        }

        return buckets.map { (date: $0.label, main: $0.main, other: $0.other) }
    }

    var hasResults: Bool {
        !results.isEmpty || similarFailuresResult != nil
    }

    var isLoading: Bool {
        state == .loading
    }

    /// Average failures per day based on histogram data (non-zero days).
    var averageFailuresPerDay: String? {
        let data = histogramData
        guard !data.isEmpty else { return nil }
        let totalFailures = data.reduce(0) { $0 + $1.main + $1.other }
        guard totalFailures > 0 else { return nil }
        let daysWithFailures = data.filter { $0.main + $0.other > 0 }.count
        guard daysWithFailures > 0 else { return nil }
        let avg = Double(totalFailures) / Double(daysWithFailures)
        if avg == avg.rounded() {
            return String(format: "%.0f", avg)
        }
        return String(format: "%.1f", avg)
    }

    /// Total failure count attributed to main/master branch from histogram data.
    var mainBranchFailureCount: Int {
        histogramData.reduce(0) { $0 + $1.main }
    }

    private var dateFormatter: DateFormatter {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }

    // MARK: - Init

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    // MARK: - Actions

    func search() async {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }

        state = .loading
        results = []
        similarFailuresResult = nil
        selectedJobFilters = []

        do {
            let startStr = dateFormatter.string(from: startDate)
            let endStr = dateFormatter.string(from: endDate)

            let searchResult: FailureSearchResult = try await apiClient.fetch(
                APIEndpoint.searchFailures(
                    query: query,
                    startDate: startStr,
                    endDate: endStr
                )
            )
            results = searchResult.jobs ?? []

            // Fetch similar failures from the /api/failure endpoint for richer data
            // including jobCount histogram and samples
            let captures = results.compactMap(\.failureCaptures).first { !$0.isEmpty } ?? []
            await fetchSimilarFailures(name: query, captures: captures)

            state = .loaded
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    /// Fetch similar failures using the `/api/failure` endpoint.
    /// The server requires `failureCaptures` as a JSON-encoded array of strings.
    func fetchSimilarFailures(name: String, jobName: String? = nil, captures: [String] = []) async {
        isSimilarLoading = true
        defer { isSimilarLoading = false }

        do {
            let result: SimilarFailureResult = try await apiClient.fetch(
                APIEndpoint.similarFailures(
                    name: name,
                    jobName: jobName,
                    failureCaptures: captures
                )
            )
            similarFailuresResult = result
        } catch {
            // Non-fatal: similar failures are supplementary data
            similarFailuresResult = nil
        }
    }

    func toggleJobFilter(_ jobName: String) {
        if selectedJobFilters.contains(jobName) {
            selectedJobFilters.remove(jobName)
        } else {
            selectedJobFilters.insert(jobName)
        }
    }

    func clearResults() {
        results = []
        similarFailuresResult = nil
        selectedJobFilters = []
        state = .idle
    }

    func resetDateRange() {
        startDate = Calendar.current.date(byAdding: .day, value: -14, to: Date()) ?? Date()
        endDate = Date()
    }
}

// MARK: - JobData Extension

private extension JobData {
    var branch: String? {
        // The web implementation looks for job.branch, but our JobData doesn't include it.
        // For now, assume most jobs are on main/master unless we can parse from jobName.
        // This could be enhanced if the API returns branch info.
        nil
    }
}
