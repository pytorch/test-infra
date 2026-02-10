import Foundation

@MainActor
final class CommitDetailViewModel: ObservableObject {
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

    /// Filter for which job statuses to display.
    enum StatusFilter: String, CaseIterable, Equatable {
        case all = "All"
        case failed = "Failed"
        case cancelled = "Cancelled"
        case pending = "Pending"
        case passed = "Passed"
        case skipped = "Skipped"
    }

    /// Sort order for jobs within each workflow group.
    enum SortOption: String, CaseIterable, Equatable {
        case status = "Status"
        case duration = "Duration"
        case name = "Name"
    }

    @Published var state: ViewState = .loading
    @Published var commitResponse: CommitResponse?
    @Published var groupedJobs: [(workflowName: String, jobs: [JobData])] = []
    @Published var expandedWorkflows: Set<String> = []
    @Published var statusFilter: StatusFilter = .all
    @Published var jobSearchText: String = ""
    @Published var sortOption: SortOption = .status
    @Published var lastRefreshed: Date?
    @Published var isAutoRefreshEnabled: Bool = true

    // MARK: - Auto-Refresh
    private static let autoRefreshInterval: TimeInterval = 60
    private var autoRefreshTask: Task<Void, Never>?

    // MARK: - Summary Stats

    var totalJobs: Int { commitResponse?.jobs.count ?? 0 }

    var passedJobs: Int {
        commitResponse?.jobs.filter { $0.isSuccess }.count ?? 0
    }

    var failedJobs: Int {
        commitResponse?.jobs.filter {
            $0.isFailure && $0.conclusion?.lowercased() != "cancelled" && $0.conclusion?.lowercased() != "canceled"
        }.count ?? 0
    }

    var pendingJobs: Int {
        commitResponse?.jobs.filter {
            let c = $0.conclusion?.lowercased()
            return c == nil || c == "pending" || c == "queued" || c == "in_progress"
        }.count ?? 0
    }

    var skippedJobs: Int {
        commitResponse?.jobs.filter {
            $0.conclusion?.lowercased() == "skipped"
        }.count ?? 0
    }

    var cancelledJobs: Int {
        commitResponse?.jobs.filter {
            let c = $0.conclusion?.lowercased()
            return c == "cancelled" || c == "canceled" || c == "time_out" || c == "timed_out"
        }.count ?? 0
    }

    var otherJobs: Int {
        totalJobs - passedJobs - failedJobs - pendingJobs - skippedJobs - cancelledJobs
    }

    /// The fraction of completed (non-pending) jobs out of total, for a progress bar.
    var completionRatio: Double {
        guard totalJobs > 0 else { return 0 }
        return Double(totalJobs - pendingJobs) / Double(totalJobs)
    }

    /// The fraction of passed jobs out of total, for a success bar.
    var successRatio: Double {
        guard totalJobs > 0 else { return 0 }
        return Double(passedJobs) / Double(totalJobs)
    }

    /// The fraction of failed jobs out of total.
    var failureRatio: Double {
        guard totalJobs > 0 else { return 0 }
        return Double(failedJobs) / Double(totalJobs)
    }

    // MARK: - Filtered Jobs

    /// Returns grouped jobs filtered by the current status filter and search text,
    /// then sorted by the selected sort option.
    var filteredGroupedJobs: [(workflowName: String, jobs: [JobData])] {
        groupedJobs.compactMap { group in
            let filtered = group.jobs.filter { job in
                matchesStatusFilter(job) && matchesSearchText(job)
            }
            if filtered.isEmpty { return nil }
            return (workflowName: group.workflowName, jobs: applySortOption(filtered))
        }
    }

    private func applySortOption(_ jobs: [JobData]) -> [JobData] {
        switch sortOption {
        case .status:
            return sortJobsByStatus(jobs)
        case .duration:
            return jobs.sorted { ($0.durationS ?? 0) > ($1.durationS ?? 0) }
        case .name:
            return jobs.sorted {
                ($0.jobName ?? $0.name ?? "").localizedCaseInsensitiveCompare($1.jobName ?? $1.name ?? "") == .orderedAscending
            }
        }
    }

    /// Number of visible jobs after applying filters.
    var visibleJobCount: Int {
        filteredGroupedJobs.reduce(0) { $0 + $1.jobs.count }
    }

    /// Whether any filter is actively reducing the job list.
    var isFiltering: Bool {
        statusFilter != .all || !jobSearchText.isEmpty || sortOption != .status
    }

    private func matchesStatusFilter(_ job: JobData) -> Bool {
        switch statusFilter {
        case .all:
            return true
        case .failed:
            let c = job.conclusion?.lowercased()
            return job.isFailure && c != "cancelled" && c != "canceled"
        case .pending:
            let c = job.conclusion?.lowercased()
            return c == nil || c == "pending" || c == "queued" || c == "in_progress"
        case .passed:
            return job.isSuccess
        case .cancelled:
            let c = job.conclusion?.lowercased()
            return c == "cancelled" || c == "canceled" || c == "time_out" || c == "timed_out"
        case .skipped:
            return job.conclusion?.lowercased() == "skipped"
        }
    }

    private func matchesSearchText(_ job: JobData) -> Bool {
        guard !jobSearchText.isEmpty else { return true }
        let query = jobSearchText.lowercased()
        let name = (job.jobName ?? job.name ?? "").lowercased()
        return name.contains(query)
    }

    func clearFilters() {
        statusFilter = .all
        jobSearchText = ""
        sortOption = .status
    }

    // MARK: - Config

    let sha: String
    let repoOwner: String
    let repoName: String

    private let apiClient: APIClientProtocol

    // MARK: - Init

    init(
        sha: String,
        repoOwner: String = "pytorch",
        repoName: String = "pytorch",
        apiClient: APIClientProtocol = APIClient.shared
    ) {
        self.sha = sha
        self.repoOwner = repoOwner
        self.repoName = repoName
        self.apiClient = apiClient
    }

    // MARK: - Data Loading

    func loadCommit() async {
        state = .loading
        do {
            let client = apiClient
            let response: CommitResponse = try await client.fetch(
                .commit(repoOwner: repoOwner, repoName: repoName, sha: sha)
            )
            commitResponse = response
            groupJobs(response.jobs)
            state = .loaded
            lastRefreshed = Date()
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    func refresh() async {
        do {
            let client = apiClient
            let response: CommitResponse = try await client.fetch(
                .commit(repoOwner: repoOwner, repoName: repoName, sha: sha)
            )
            commitResponse = response
            groupJobs(response.jobs)
            state = .loaded
            lastRefreshed = Date()
        } catch {
            // Only show error if we don't already have data
            if commitResponse == nil {
                state = .error(error.localizedDescription)
            }
        }
    }

    func startAutoRefresh() {
        stopAutoRefresh()
        guard isAutoRefreshEnabled else { return }
        autoRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.autoRefreshInterval))
                guard !Task.isCancelled else { break }
                guard let self, self.isAutoRefreshEnabled, self.state == .loaded else { continue }
                await self.refresh()
            }
        }
    }

    func stopAutoRefresh() {
        autoRefreshTask?.cancel()
        autoRefreshTask = nil
    }

    func toggleAutoRefresh() {
        isAutoRefreshEnabled.toggle()
        if isAutoRefreshEnabled {
            startAutoRefresh()
        } else {
            stopAutoRefresh()
        }
    }


    // MARK: - Grouping

    private func groupJobs(_ jobs: [JobData]) {
        var dict: [String: [JobData]] = [:]
        for job in jobs {
            let workflow = job.workflowName ?? "Unknown Workflow"
            dict[workflow, default: []].append(job)
        }

        // Sort jobs within each workflow: failures first, then pending, then success
        groupedJobs = dict
            .sorted { $0.key.localizedCaseInsensitiveCompare($1.key) == .orderedAscending }
            .map { (workflowName: $0.key, jobs: sortJobsByStatus($0.value)) }

        // Auto-expand workflows that have failures
        for group in groupedJobs where group.jobs.contains(where: { $0.isFailure }) {
            expandedWorkflows.insert(group.workflowName)
        }
    }

    private func sortJobsByStatus(_ jobs: [JobData]) -> [JobData] {
        jobs.sorted { lhs, rhs in
            let lhsPriority = statusPriority(lhs.conclusion)
            let rhsPriority = statusPriority(rhs.conclusion)
            if lhsPriority != rhsPriority {
                return lhsPriority < rhsPriority
            }
            // If same status, sort alphabetically by job name
            let lhsName = lhs.jobName ?? lhs.name ?? ""
            let rhsName = rhs.jobName ?? rhs.name ?? ""
            return lhsName.localizedCaseInsensitiveCompare(rhsName) == .orderedAscending
        }
    }

    private func statusPriority(_ conclusion: String?) -> Int {
        switch conclusion?.lowercased() {
        case "failure": return 0
        case "pending", "queued", "in_progress": return 1
        case "cancelled", "canceled", "time_out", "timed_out": return 2
        case "skipped": return 3
        case "success": return 4
        default: return 5
        }
    }

    // MARK: - Actions

    func toggleWorkflow(_ name: String) {
        if expandedWorkflows.contains(name) {
            expandedWorkflows.remove(name)
        } else {
            expandedWorkflows.insert(name)
        }
    }

    func expandAllWorkflows() {
        expandedWorkflows = Set(groupedJobs.map { $0.workflowName })
    }

    /// Expand all workflows that have jobs matching the current filters.
    func expandFilteredWorkflows() {
        let matching = filteredGroupedJobs.map { $0.workflowName }
        expandedWorkflows.formUnion(matching)
    }

    func collapseAllWorkflows() {
        expandedWorkflows.removeAll()
    }

    var hasExpandedWorkflows: Bool {
        !expandedWorkflows.isEmpty
    }

    var commitURL: String {
        "https://github.com/\(repoOwner)/\(repoName)/commit/\(sha)"
    }

    var prURL: String? {
        guard let prNumber = commitResponse?.commit.prNumber else { return nil }
        return "https://github.com/\(repoOwner)/\(repoName)/pull/\(prNumber)"
    }

    var isAutorevert: Bool {
        guard let title = commitResponse?.commit.title else { return false }
        return title.lowercased().contains("revert") || title.lowercased().contains("autorevert")
    }
}
