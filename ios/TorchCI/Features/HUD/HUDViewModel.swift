import Foundation
import SwiftUI

@MainActor
final class HUDViewModel: ObservableObject {
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
    @Published var hudData: HUDResponse?
    @Published var selectedRepo: RepoConfig
    @Published var selectedBranch: String = "main"
    @Published var currentPage: Int = 1
    @Published var searchFilter: String = ""
    @Published var isRegexEnabled: Bool = false
    @Published var consecutiveFailures: Int = 0
    @Published var failurePatterns: [String] = []
    @Published var isLoadingMore: Bool = false
    @Published var loadMoreError: String?
    private var hasMorePages: Bool = true

    // MARK: - Configuration

    static let repos: [RepoConfig] = [
        RepoConfig(owner: "pytorch", name: "pytorch"),
        RepoConfig(owner: "pytorch", name: "vision"),
        RepoConfig(owner: "pytorch", name: "audio"),
        RepoConfig(owner: "pytorch", name: "executorch"),
        RepoConfig(owner: "pytorch", name: "helion"),
    ]

    static let branches: [String] = [
        "main",
        "viable/strict",
        "nightly",
    ]

    // MARK: - Dependencies

    private let apiClient: APIClientProtocol

    // MARK: - Computed Properties

    var filteredJobNames: [String] {
        guard let hudData else { return [] }
        let names = hudData.jobNames
        guard !searchFilter.isEmpty else { return names }

        if isRegexEnabled {
            guard let regex = try? NSRegularExpression(
                pattern: searchFilter,
                options: [.caseInsensitive]
            ) else { return names }

            return names.filter { name in
                let range = NSRange(name.startIndex..., in: name)
                return regex.firstMatch(in: name, range: range) != nil
            }
        } else {
            let lowered = searchFilter.lowercased()
            return names.filter { $0.lowercased().contains(lowered) }
        }
    }

    var filteredRows: [HUDRow] {
        guard let hudData else { return [] }
        let jobIndices = filteredJobIndices
        return hudData.shaGrid.map { row in
            let filteredJobs = jobIndices.map { row.jobs[safe: $0] ?? nil }.compactMap { $0 }
            return HUDRow(
                sha: row.sha,
                commitTitle: row.commitTitle,
                commitMessageBody: row.commitMessageBody,
                prNumber: row.prNumber,
                author: row.author,
                authorUrl: row.authorUrl,
                time: row.time,
                jobs: filteredJobs,
                isForcedMerge: row.isForcedMerge,
                isForcedMergeWithFailures: row.isForcedMergeWithFailures,
                isAutoreverted: row.isAutoreverted,
                autorevertWorkflows: row.autorevertWorkflows,
                autorevertSignals: row.autorevertSignals
            )
        }
    }

    var filteredJobIndices: [Int] {
        guard let hudData else { return [] }
        let allNames = hudData.jobNames

        guard !searchFilter.isEmpty else {
            return Array(allNames.indices)
        }

        if isRegexEnabled {
            guard let regex = try? NSRegularExpression(
                pattern: searchFilter,
                options: [.caseInsensitive]
            ) else { return Array(allNames.indices) }

            return allNames.enumerated().compactMap { index, name in
                let range = NSRange(name.startIndex..., in: name)
                return regex.firstMatch(in: name, range: range) != nil ? index : nil
            }
        } else {
            let lowered = searchFilter.lowercased()
            return allNames.enumerated().compactMap { index, name in
                name.lowercased().contains(lowered) ? index : nil
            }
        }
    }

    var isViableStrict: Bool {
        selectedBranch == "viable/strict"
    }

    var showFailureWarning: Bool {
        isViableStrict && consecutiveFailures >= 3
    }

    var hasData: Bool {
        hudData != nil && !(hudData?.shaGrid.isEmpty ?? true)
    }

    var isLoading: Bool {
        state == .loading
    }

    // MARK: - Health Stats

    /// Overall job health stats across all visible rows (excludes empty slots).
    /// Uses `filteredJobNames` to determine viable/strict blocking status
    /// since HUD grid jobs don't carry their own name.
    var jobHealthStats: JobHealthStats {
        let rows = filteredRows
        let names = filteredJobNames
        var success = 0, flaky = 0, newFail = 0, repeatFail = 0, unstableFail = 0, blocking = 0, pending = 0

        for row in rows {
            for (jobIndex, job) in row.jobs.enumerated() {
                if job.isEmpty { continue }
                let jobName = jobIndex < names.count ? names[jobIndex] : ""
                if job.isFlaky {
                    flaky += 1
                } else if job.isSuccess {
                    success += 1
                } else if job.isFailure {
                    if job.isUnstable {
                        unstableFail += 1
                    } else if job.isRepeatFailure {
                        repeatFail += 1
                    } else {
                        newFail += 1
                    }
                    if HUDJob.isBlockingName(jobName) && !job.isUnstable {
                        blocking += 1
                    }
                } else if job.isPending {
                    pending += 1
                }
            }
        }

        let totalFailure = newFail + repeatFail
        let total = success + flaky + totalFailure + unstableFail + pending
        return JobHealthStats(
            successCount: success,
            flakyCount: flaky,
            failureCount: totalFailure,
            newFailureCount: newFail,
            repeatFailureCount: repeatFail,
            blockingFailureCount: blocking,
            pendingCount: pending,
            unstableCount: unstableFail,
            totalCount: total
        )
    }

    // MARK: - Init

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
        self.selectedRepo = Self.repos[0]
    }

    // MARK: - Actions

    /// Number of pages to fetch on initial load.
    /// At per_page=30, loading 2 pages gives ~60 commits (similar to the old per_page=50).
    private static let initialPageCount = 2

    func loadData() async {
        state = .loading
        currentPage = 1
        hasMorePages = true
        loadMoreError = nil
        do {
            let endpoint = APIEndpoint.hud(
                repoOwner: selectedRepo.owner,
                repoName: selectedRepo.name,
                branch: selectedBranch,
                page: 1
            )
            let response: HUDResponse = try await apiClient.fetch(endpoint)
            hudData = response
            hasMorePages = !response.shaGrid.isEmpty
            computeConsecutiveFailures()
            state = .loaded

            // Auto-load additional pages to compensate for reduced per_page
            if hasMorePages {
                for page in 2...Self.initialPageCount {
                    await loadNextPage()
                    guard hasMorePages else { break }
                }
            }
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    func loadMoreIfNeeded() {
        guard !isLoadingMore, hasMorePages, state == .loaded else { return }
        isLoadingMore = true
        Task {
            await loadNextPage()
        }
    }

    func retryLoadMore() {
        loadMoreError = nil
        loadMoreIfNeeded()
    }

    func dismissLoadMoreError() {
        loadMoreError = nil
    }

    private func loadNextPage() async {
        loadMoreError = nil
        let nextPage = currentPage + 1
        do {
            let endpoint = APIEndpoint.hud(
                repoOwner: selectedRepo.owner,
                repoName: selectedRepo.name,
                branch: selectedBranch,
                page: nextPage
            )
            let response: HUDResponse = try await apiClient.fetch(endpoint)
            if response.shaGrid.isEmpty {
                hasMorePages = false
            } else {
                // Append new rows, keeping existing job names union
                let existingSHAs = Set(hudData?.shaGrid.map(\.sha) ?? [])
                let newRows = response.shaGrid.filter { !existingSHAs.contains($0.sha) }
                if newRows.isEmpty {
                    hasMorePages = false
                } else {
                    var merged = hudData ?? HUDResponse(shaGrid: [], jobNames: [])
                    // Preserve ordering: keep existing names in order, append only new ones
                    let existingNames = Set(merged.jobNames)
                    let newNames = response.jobNames.filter { !existingNames.contains($0) }
                    let allNames = merged.jobNames + newNames
                    merged = HUDResponse(
                        shaGrid: merged.shaGrid + newRows,
                        jobNames: allNames
                    )
                    hudData = merged
                    currentPage = nextPage
                }
            }
        } catch {
            loadMoreError = error.localizedDescription
        }
        isLoadingMore = false
    }

    func refresh() async {
        await loadData()
    }

    func selectRepo(_ repo: RepoConfig) {
        guard repo.id != selectedRepo.id else { return }
        selectedRepo = repo
        hudData = nil
        Task { await loadData() }
    }

    func selectBranch(_ branch: String) {
        guard branch != selectedBranch else { return }
        selectedBranch = branch
        hudData = nil
        Task { await loadData() }
    }

    func onPageChange(_ page: Int) {
        currentPage = page
        Task { await loadData() }
    }

    func toggleRegex() {
        isRegexEnabled.toggle()
    }

    func clearFilter() {
        searchFilter = ""
    }

    // MARK: - Job Organization

    /// Groups job names by workflow prefix (e.g., "linux-build / test1" -> "linux-build")
    var jobsByWorkflow: [String: [String]] {
        guard let hudData else { return [:] }
        var groups: [String: [String]] = [:]

        for jobName in hudData.jobNames {
            let workflow = extractWorkflow(from: jobName)
            groups[workflow, default: []].append(jobName)
        }

        return groups
    }

    private func extractWorkflow(from jobName: String) -> String {
        if let slashRange = jobName.range(of: " / ") {
            return String(jobName[..<slashRange.lowerBound])
        }
        return "Other"
    }

    // MARK: - Private Helpers

    private func computeConsecutiveFailures() {
        guard let rows = hudData?.shaGrid else {
            consecutiveFailures = 0
            failurePatterns = []
            return
        }

        var count = 0
        var patterns: [String: Int] = [:]

        for row in rows {
            let hasNonUnstableFailure = row.jobs.contains { job in
                job.conclusion == "failure" && !(job.unstable ?? false)
            }

            if hasNonUnstableFailure {
                count += 1
                for job in row.jobs where job.conclusion == "failure" && !(job.unstable ?? false) {
                    if let name = job.name {
                        patterns[name, default: 0] += 1
                    }
                }
            } else {
                break
            }
        }

        consecutiveFailures = count
        failurePatterns = patterns
            .sorted { $0.value > $1.value }
            .prefix(5)
            .map(\.key)
    }
}

// MARK: - Job Health Stats

struct JobHealthStats {
    let successCount: Int
    let flakyCount: Int
    let failureCount: Int
    let newFailureCount: Int
    let repeatFailureCount: Int
    let blockingFailureCount: Int
    let pendingCount: Int
    let unstableCount: Int
    let totalCount: Int

    var successPercentage: String {
        let passCount = successCount + flakyCount
        return totalCount > 0 ? String(format: "%.0f%%", Double(passCount) / Double(totalCount) * 100) : "0%"
    }

    var isEmpty: Bool {
        totalCount == 0
    }
}

// MARK: - Safe Array Access

private extension Array {
    subscript(safe index: Int) -> Element? {
        guard indices.contains(index) else { return nil }
        return self[index]
    }
}
