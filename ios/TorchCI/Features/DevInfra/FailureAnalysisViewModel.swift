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
    @Published var similarFailuresError: String?
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

    /// Histogram data showing failure counts grouped by day over the selected date range.
    /// Returns array of tuples: (date, mainBranchCount, otherBranchCount)
    /// Uses integer day offsets for reliable sorting across month boundaries.
    nonisolated(unsafe) private static let displayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MM/d"
        return f
    }()
    nonisolated(unsafe) private static let isoFormatter = ISO8601DateFormatter()

    var histogramData: [(date: String, main: Int, other: Int)] {
        let samples = similarFailuresResult?.samples ?? results

        let calendar = Calendar.current
        let rangeStart = calendar.startOfDay(for: startDate)
        let rangeEnd = calendar.startOfDay(for: endDate)

        // Compute the number of days in the selected range (inclusive)
        let dayCount = max((calendar.dateComponents([.day], from: rangeStart, to: rangeEnd).day ?? 0) + 1, 1)

        // Create buckets keyed by day offset (0 = oldest, dayCount-1 = newest)
        var buckets: [(label: String, main: Int, other: Int)] = (0..<dayCount).map { offset in
            let date = calendar.date(byAdding: .day, value: offset, to: rangeStart) ?? rangeStart
            return (label: Self.displayFormatter.string(from: date), main: 0, other: 0)
        }

        // Count failures per day
        let highlighted: Set<String> = ["master", "main"]
        for job in samples {
            guard let timeStr = job.time,
                  let time = Self.isoFormatter.date(from: timeStr) else { continue }

            let jobDay = calendar.startOfDay(for: time)
            let bucketIndex = calendar.dateComponents([.day], from: rangeStart, to: jobDay).day ?? -1
            guard bucketIndex >= 0 && bucketIndex < dayCount else { continue }

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

    nonisolated(unsafe) private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

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
            let startStr = Self.dateFormatter.string(from: startDate)
            let endStr = Self.dateFormatter.string(from: endDate)

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
            similarFailuresError = nil
        } catch {
            // Non-fatal: similar failures are supplementary data
            similarFailuresResult = nil
            similarFailuresError = "Could not load similar failures: \(error.localizedDescription)"
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

