import Foundation
import Combine

@MainActor
final class TestFileReportViewModel: ObservableObject {
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

    enum SortOption: String, CaseIterable {
        case failureCount = "Failures"
        case totalTests = "Total Tests"
        case duration = "Duration"
        case cost = "Cost"
        case fileName = "File Name"

        var systemImage: String {
            switch self {
            case .failureCount: return "exclamationmark.triangle"
            case .totalTests: return "number"
            case .duration: return "clock"
            case .cost: return "dollarsign.circle"
            case .fileName: return "abc"
            }
        }
    }

    @Published var state: ViewState = .idle
    @Published var searchQuery: String = ""
    @Published var sortOption: SortOption = .failureCount
    @Published var expandedFiles: Set<String> = []
    @Published var selectedDateRange: Int = 7 // days

    @Published private(set) var fileStats: [FileStats] = []
    @Published private(set) var rawResults: [FileReportResult] = []
    @Published private(set) var commits: [FileReportCommitSha] = []

    var filteredAndSortedFiles: [FileStats] {
        var filtered = fileStats

        // Apply search filter
        if !searchQuery.isEmpty {
            let query = searchQuery.lowercased()
            filtered = filtered.filter { stat in
                stat.file.lowercased().contains(query) ||
                stat.ownerLabels.contains { $0.lowercased().contains(query) }
            }
        }

        // Apply sorting
        switch sortOption {
        case .failureCount:
            filtered.sort { $0.failureCount > $1.failureCount }
        case .totalTests:
            filtered.sort { $0.totalTests > $1.totalTests }
        case .duration:
            filtered.sort { $0.totalDuration > $1.totalDuration }
        case .cost:
            filtered.sort { $0.estimatedCost > $1.estimatedCost }
        case .fileName:
            filtered.sort { $0.file.localizedCaseInsensitiveCompare($1.file) == .orderedAscending }
        }

        return filtered
    }

    // MARK: - Private

    private let apiClient: APIClientProtocol
    private var loadTask: Task<Void, Never>?
    private var debounceTask: Task<Void, Never>?

    // MARK: - Init

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    // MARK: - Public Methods

    func loadData() async {
        loadTask?.cancel()

        let task = Task { [weak self] in
            guard let self else { return }

            self.state = .loading

            do {
                try await self.fetchFileReport()
                guard !Task.isCancelled else { return }
                self.state = .loaded
            } catch {
                guard !Task.isCancelled else { return }
                self.state = .error(error.localizedDescription)
            }
        }
        loadTask = task
        await task.value
    }

    func refresh() async {
        await loadData()
    }

    func toggleExpanded(_ file: String) {
        if expandedFiles.contains(file) {
            expandedFiles.remove(file)
        } else {
            expandedFiles.insert(file)
        }
    }

    func resultsForFile(_ file: String) -> [FileReportResult] {
        rawResults.filter { $0.file == file }
    }

    func onSearchQueryChanged() {
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000) // 300ms
            guard !Task.isCancelled else { return }
            self?.objectWillChange.send()
        }
    }

    func onDateRangeChanged() {
        Task {
            await loadData()
        }
    }

    // MARK: - Private Methods

    private func fetchFileReport() async throws {
        let endDate = Int(Date().timeIntervalSince1970)
        let startDate = endDate - (selectedDateRange * 24 * 60 * 60)

        let response: FileReportResponse = try await apiClient.fetch(
            .fileReport(startDate: startDate, endDate: endDate)
        )
        guard !Task.isCancelled else { return }

        self.commits = response.shas.sorted { $0.pushDate < $1.pushDate }
        self.rawResults = response.results

        // Compute cost for each result
        let costMap = Dictionary(uniqueKeysWithValues: response.costInfo.map { ($0.label, $0.pricePerHour) })
        let ownerLabelMap = Dictionary(uniqueKeysWithValues: response.testOwnerLabels.map { ($0.file, $0.ownerLabels) })

        // Group results by file
        let grouped = Dictionary(grouping: response.results) { $0.file }

        // Aggregate stats per file
        var stats: [FileStats] = []
        for (file, results) in grouped {
            var totalTests = 0
            var successCount = 0
            var skippedCount = 0
            var totalDuration: TimeInterval = 0
            var totalCost: Double = 0
            var jobNames = Set<String>()

            for result in results {
                totalTests += result.count
                successCount += result.success
                skippedCount += result.skipped
                totalDuration += result.time

                // Calculate cost: time (seconds) * price_per_hour / 3600
                let pricePerHour = costMap[result.label] ?? 0
                totalCost += (result.time * pricePerHour) / 3600.0

                jobNames.insert(result.shortJobName)
            }

            let failureCount = totalTests - successCount - skippedCount
            let ownerLabels = ownerLabelMap[file] ?? ownerLabelMap["\(file).py"] ?? ["unknown"]

            stats.append(FileStats(
                file: file,
                totalTests: totalTests,
                successCount: successCount,
                failureCount: failureCount,
                skippedCount: skippedCount,
                totalDuration: totalDuration,
                estimatedCost: totalCost,
                jobNames: jobNames,
                ownerLabels: ownerLabels
            ))
        }

        self.fileStats = stats
    }
}
