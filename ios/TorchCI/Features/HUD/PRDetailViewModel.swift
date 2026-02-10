import Foundation

@MainActor
final class PRDetailViewModel: ObservableObject {
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

    enum JobFilter: String, CaseIterable {
        case all = "All"
        case failures = "Failures"
        case pending = "Pending"
    }

    @Published var state: ViewState = .loading
    @Published var prResponse: PRResponse?
    @Published var selectedSha: String?
    @Published var groupedJobs: [(workflowName: String, jobs: [JobData])] = []
    @Published var expandedWorkflows: Set<String> = []
    @Published var isBodyExpanded: Bool = false
    @Published var jobFilter: JobFilter = .all
    @Published var jobSearchQuery: String = ""
    @Published var isAutoRefreshEnabled: Bool = true

    // MARK: - Auto-Refresh
    private static let autoRefreshInterval: TimeInterval = 60
    private var autoRefreshTask: Task<Void, Never>?

    /// Cached job summary per commit SHA (populated as commits are selected).
    @Published var commitJobSummaries: [String: CommitJobSummary] = [:]

    struct CommitJobSummary {
        let total: Int
        let passed: Int
        let failed: Int
        let pending: Int
    }

    // MARK: - Config

    let prNumber: Int
    let repoOwner: String
    let repoName: String

    private let apiClient: APIClientProtocol

    // MARK: - Computed Properties

    var commits: [PRCommit] {
        prResponse?.commits ?? []
    }

    var selectedCommitTitle: String? {
        guard let sha = selectedSha else { return nil }
        return commits.first { $0.sha == sha }?.title
    }

    /// Jobs for the selected SHA. The PR endpoint does not return per-SHA jobs,
    /// so this is populated by `loadJobsForSha` after selection.
    @Published var jobsForSelectedSha: [JobData] = []
    @Published var isLoadingJobs: Bool = false
    @Published var jobLoadError: String?

    var totalJobs: Int { jobsForSelectedSha.count }

    var passedJobs: Int {
        jobsForSelectedSha.filter { $0.isSuccess }.count
    }

    var failedJobs: Int {
        jobsForSelectedSha.filter { $0.isFailure }.count
    }

    var pendingJobs: Int {
        jobsForSelectedSha.filter {
            let c = $0.conclusion?.lowercased()
            return c == nil || c == "pending" || c == "queued" || c == "in_progress"
        }.count
    }

    var skippedJobs: Int {
        jobsForSelectedSha.filter {
            let c = $0.conclusion?.lowercased()
            return c == "skipped" || c == "cancelled" || c == "canceled"
        }.count
    }

    /// Grouped jobs after applying the current filter and search query.
    var filteredGroupedJobs: [(workflowName: String, jobs: [JobData])] {
        let searchTerm = jobSearchQuery.trimmingCharacters(in: .whitespaces).lowercased()
        return groupedJobs.compactMap { group in
            var filtered = group.jobs

            // Apply status filter
            switch jobFilter {
            case .all:
                break
            case .failures:
                filtered = filtered.filter { $0.isFailure }
            case .pending:
                filtered = filtered.filter {
                    let c = $0.conclusion?.lowercased()
                    return c == nil || c == "pending" || c == "queued" || c == "in_progress"
                }
            }

            // Apply search filter
            if !searchTerm.isEmpty {
                filtered = filtered.filter { job in
                    let name = (job.jobName ?? job.name ?? "").lowercased()
                    return name.contains(searchTerm)
                }
            }

            guard !filtered.isEmpty else { return nil }
            return (workflowName: group.workflowName, jobs: filtered)
        }
    }

    /// Total jobs visible after filtering.
    var filteredJobCount: Int {
        filteredGroupedJobs.reduce(0) { $0 + $1.jobs.count }
    }

    /// Whether the current filter or search is hiding some jobs.
    var isFiltering: Bool {
        jobFilter != .all || !jobSearchQuery.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var prURL: String {
        "https://github.com/\(repoOwner)/\(repoName)/pull/\(prNumber)"
    }

    var hudURL: String {
        "https://hud.pytorch.org/\(repoOwner)/\(repoName)/pull/\(prNumber)"
    }

    /// Color key for the PR state badge.  Returns `"neutral"` when the API
    /// does not provide a state (which is the current default).
    var prStateColor: String {
        switch prResponse?.state?.lowercased() {
        case "open": return "success"
        case "closed": return "failure"
        case "merged": return "unstable"
        default: return "neutral"
        }
    }

    /// SF Symbol name for the PR state badge.
    var prStateIcon: String {
        switch prResponse?.state?.lowercased() {
        case "open": return "arrow.triangle.branch"
        case "closed": return "xmark.circle"
        case "merged": return "arrow.triangle.merge"
        default: return "questionmark.circle"
        }
    }

    /// Whether the API returned any metadata beyond title/shas.
    var hasMetadata: Bool {
        prResponse?.hasMetadata ?? false
    }

    /// Human-readable relative time for when the PR was created.
    /// Returns `nil` when the API does not provide `created_at`.
    var createdTimeAgo: String? {
        guard let dateString = prResponse?.createdAt else { return nil }
        return Self.relativeTime(from: dateString)
    }

    /// Human-readable relative time for when the PR was last updated.
    /// Returns `nil` when the API does not provide `updated_at`.
    var updatedTimeAgo: String? {
        guard let dateString = prResponse?.updatedAt else { return nil }
        return Self.relativeTime(from: dateString)
    }

    // MARK: - Init

    init(
        prNumber: Int,
        repoOwner: String = "pytorch",
        repoName: String = "pytorch",
        apiClient: APIClientProtocol = APIClient.shared
    ) {
        self.prNumber = prNumber
        self.repoOwner = repoOwner
        self.repoName = repoName
        self.apiClient = apiClient
    }

    // MARK: - Data Loading

    func loadPR() async {
        state = .loading
        do {
            let response: PRResponse = try await apiClient.fetch(
                .pullRequest(repoOwner: repoOwner, repoName: repoName, prNumber: prNumber)
            )
            prResponse = response

            // Select the head SHA by default (most recent commit)
            if let headSha = response.headSha {
                await selectSha(headSha)
            } else if let lastCommit = response.commits.last {
                await selectSha(lastCommit.sha)
            }

            state = .loaded
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    func refresh() async {
        do {
            let response: PRResponse = try await apiClient.fetch(
                .pullRequest(repoOwner: repoOwner, repoName: repoName, prNumber: prNumber)
            )
            prResponse = response

            // Preserve selected SHA if still valid, otherwise select head
            if let currentSha = selectedSha,
               response.shas?.contains(where: { $0.sha == currentSha }) == true {
                await selectSha(currentSha)
            } else if let headSha = response.headSha {
                await selectSha(headSha)
            }

            state = .loaded
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    // MARK: - SHA Selection

    func selectSha(_ sha: String) async {
        selectedSha = sha
        isLoadingJobs = true
        // Reset filter when switching commits
        jobFilter = .all
        jobSearchQuery = ""
        // Load jobs for this SHA via the commit endpoint
        jobLoadError = nil
        do {
            let response: CommitResponse = try await apiClient.fetch(
                .commit(repoOwner: repoOwner, repoName: repoName, sha: sha)
            )
            jobsForSelectedSha = response.jobs
        } catch {
            jobsForSelectedSha = []
            jobLoadError = error.localizedDescription
        }
        rebuildGroupedJobs()
        isLoadingJobs = false

        // Cache the summary for this commit's chip indicator
        if !jobsForSelectedSha.isEmpty {
            commitJobSummaries[sha] = CommitJobSummary(
                total: totalJobs,
                passed: passedJobs,
                failed: failedJobs,
                pending: pendingJobs
            )
        }
    }

    private func rebuildGroupedJobs() {
        let jobs = jobsForSelectedSha
        var dict: [String: [JobData]] = [:]
        for job in jobs {
            let workflow = job.workflowName ?? "Unknown Workflow"
            dict[workflow, default: []].append(job)
        }
        groupedJobs = dict
            .sorted { $0.key.localizedCaseInsensitiveCompare($1.key) == .orderedAscending }
            .map { (workflowName: $0.key, jobs: $0.value) }

        // Auto-expand workflows with failures
        expandedWorkflows = []
        for group in groupedJobs where group.jobs.contains(where: { $0.isFailure }) {
            expandedWorkflows.insert(group.workflowName)
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
        expandedWorkflows = Set(filteredGroupedJobs.map { $0.workflowName })
    }

    func collapseAllWorkflows() {
        expandedWorkflows.removeAll()
    }

    func toggleBodyExpanded() {
        isBodyExpanded.toggle()
    }

    func setJobFilter(_ filter: JobFilter) {
        jobFilter = filter
    }

    func clearJobSearch() {
        jobSearchQuery = ""
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

    /// Expand only workflows that have failed jobs, collapse the rest.
    func showFailuresOnly() {
        jobFilter = .failures
        expandedWorkflows = Set(
            filteredGroupedJobs.map { $0.workflowName }
        )
    }

    // MARK: - Time Formatting

    /// Parses an ISO 8601 date string and returns a relative description like "3h ago".
    static func relativeTime(from dateString: String) -> String? {
        let date: Date?

        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        date = isoFormatter.date(from: dateString) ?? {
            let basic = ISO8601DateFormatter()
            return basic.date(from: dateString)
        }()

        guard let parsedDate = date else { return nil }

        let now = Date()
        let interval = now.timeIntervalSince(parsedDate)

        if interval < 60 {
            return "just now"
        } else if interval < 3600 {
            let minutes = Int(interval / 60)
            return "\(minutes)m ago"
        } else if interval < 86400 {
            let hours = Int(interval / 3600)
            return "\(hours)h ago"
        } else if interval < 604_800 {
            let days = Int(interval / 86400)
            return "\(days)d ago"
        } else {
            let weeks = Int(interval / 604_800)
            return "\(weeks)w ago"
        }
    }
}
