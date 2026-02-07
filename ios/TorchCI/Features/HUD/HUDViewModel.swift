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
                isForcedMerge: row.isForcedMerge
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
    var jobHealthStats: JobHealthStats {
        let rows = filteredRows
        var totalSuccess = 0
        var totalFailure = 0
        var totalPending = 0
        var totalUnstable = 0

        for row in rows {
            for job in row.jobs {
                if job.isEmpty { continue }
                if job.isUnstable {
                    totalUnstable += 1
                } else if job.isSuccess {
                    totalSuccess += 1
                } else if job.isFailure {
                    totalFailure += 1
                } else if job.isPending {
                    totalPending += 1
                }
            }
        }

        let total = totalSuccess + totalFailure + totalPending + totalUnstable
        return JobHealthStats(
            successCount: totalSuccess,
            failureCount: totalFailure,
            pendingCount: totalPending,
            unstableCount: totalUnstable,
            totalCount: total
        )
    }

    // MARK: - Init

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
        self.selectedRepo = Self.repos[0]
    }

    // MARK: - Actions

    func loadData() async {
        state = .loading
        currentPage = 1
        hasMorePages = true
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

    private func loadNextPage() async {
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
                    let allNames = Array(Set(merged.jobNames + response.jobNames))
                    merged = HUDResponse(
                        shaGrid: merged.shaGrid + newRows,
                        jobNames: merged.jobNames.count >= allNames.count ? merged.jobNames : allNames
                    )
                    hudData = merged
                    currentPage = nextPage
                }
            }
        } catch {
            // Silently fail on load-more; user can pull-to-refresh
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
    let failureCount: Int
    let pendingCount: Int
    let unstableCount: Int
    let totalCount: Int

    var successRate: Double {
        totalCount > 0 ? Double(successCount) / Double(totalCount) : 0
    }

    var failureRate: Double {
        totalCount > 0 ? Double(failureCount) / Double(totalCount) : 0
    }

    var pendingRate: Double {
        totalCount > 0 ? Double(pendingCount) / Double(totalCount) : 0
    }

    var unstableRate: Double {
        totalCount > 0 ? Double(unstableCount) / Double(totalCount) : 0
    }

    var successPercentage: String {
        String(format: "%.0f%%", successRate * 100)
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
