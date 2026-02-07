import Foundation
import SwiftUI

// MARK: - API Response Models

struct FailedJobsAnnotationResponse: Decodable {
    let failedJobs: [JobData]?
    let annotationsMap: [String: JobAnnotationData]?
}

struct JobAnnotationData: Decodable {
    let annotation: String?
    let jobID: Int

    enum CodingKeys: String, CodingKey {
        case annotation
        case jobID
    }
}

@MainActor
final class FailedJobsViewModel: ObservableObject {
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

    enum FailureType: String, CaseIterable, CustomStringConvertible {
        case all = "All"
        case brokenTrunk = "Broken Trunk"
        case flaky = "Flaky"
        case infra = "Infra"
        case notAnnotated = "Not Annotated"

        var description: String { rawValue }

        var color: Color {
            switch self {
            case .all: return .primary
            case .brokenTrunk: return AppColors.failure
            case .flaky: return AppColors.unstable
            case .infra: return AppColors.pending
            case .notAnnotated: return .secondary
            }
        }

        var icon: String {
            switch self {
            case .all: return "list.bullet"
            case .brokenTrunk: return "xmark.octagon"
            case .flaky: return "arrow.triangle.2.circlepath"
            case .infra: return "server.rack"
            case .notAnnotated: return "questionmark.circle"
            }
        }
    }

    enum AnnotationValue: String, CaseIterable {
        case brokenTrunk = "broken_trunk"
        case flaky = "flaky"
        case infra = "infra"
        case none = ""

        var displayName: String {
            switch self {
            case .brokenTrunk: return "Broken Trunk"
            case .flaky: return "Flaky"
            case .infra: return "Infra"
            case .none: return "None"
            }
        }
    }

    // MARK: - State

    @Published var state: ViewState = .idle
    @Published var jobs: [JobData] = []
    @Published var selectedRepo: RepoConfig
    @Published var selectedBranch: String = "main"
    @Published var filterType: FailureType = .all
    @Published var searchFilter: String = ""
    @Published var currentPage: Int = 1
    @Published var annotations: [Int: AnnotationValue] = [:]
    @Published var timeRangeDays: Int = 7
    @Published var startDate: Date
    @Published var endDate: Date

    // MARK: - Configuration

    static let repos: [RepoConfig] = [
        RepoConfig(owner: "pytorch", name: "pytorch"),
        RepoConfig(owner: "pytorch", name: "vision"),
        RepoConfig(owner: "pytorch", name: "audio"),
        RepoConfig(owner: "pytorch", name: "executorch"),
    ]

    static let branches: [String] = [
        "main",
        "viable/strict",
        "nightly",
    ]

    // MARK: - Dependencies

    private let apiClient: APIClientProtocol
    let authManager: AuthManager

    // MARK: - Computed

    /// Represents a group of similar jobs with the same failure signature
    struct FailureGroup: Identifiable {
        let id = UUID()
        let jobs: [JobData]
        let failureType: FailureType
        let representativeJob: JobData

        var count: Int { jobs.count }
    }

    var filteredJobs: [JobData] {
        var filtered = jobs.filter(\.isFailure)

        if !searchFilter.isEmpty {
            let lowered = searchFilter.lowercased()
            filtered = filtered.filter { job in
                (job.jobName ?? job.name ?? "").lowercased().contains(lowered)
                || (job.workflowName ?? "").lowercased().contains(lowered)
            }
        }

        if filterType != .all {
            filtered = filtered.filter { job in
                classifyFailure(job) == filterType
            }
        }

        return filtered
    }

    /// Groups similar jobs together (same name, workflow, and failure signature)
    var groupedFailures: [FailureType: [FailureGroup]] {
        var failedJobs = jobs.filter(\.isFailure)

        // Apply search filter
        if !searchFilter.isEmpty {
            let lowered = searchFilter.lowercased()
            failedJobs = failedJobs.filter { job in
                (job.jobName ?? job.name ?? "").lowercased().contains(lowered)
                || (job.workflowName ?? "").lowercased().contains(lowered)
            }
        }

        var groups: [FailureType: [String: [JobData]]] = [:]

        for job in failedJobs {
            let failureType = classifyFailure(job)

            if groups[failureType] == nil {
                groups[failureType] = [:]
            }

            // Create a unique key for grouping similar jobs
            let jobName = job.jobName ?? job.name ?? "unknown"
            let workflowName = job.workflowName ?? ""
            let failureCaptures = (job.failureCaptures ?? []).joined(separator: "|")
            let key = "\(jobName)|\(workflowName)|\(failureCaptures)"

            if groups[failureType]![key] == nil {
                groups[failureType]![key] = []
            }
            groups[failureType]![key]!.append(job)
        }

        // Convert to FailureGroup arrays
        var result: [FailureType: [FailureGroup]] = [:]
        for (failureType, jobGroups) in groups {
            result[failureType] = jobGroups.values.compactMap { jobs in
                guard let representative = jobs.first else { return nil }
                return FailureGroup(
                    jobs: jobs.sorted { ($0.time ?? "") > ($1.time ?? "") },
                    failureType: failureType,
                    representativeJob: representative
                )
            }.sorted { $0.count > $1.count }
        }

        return result
    }

    var failureCounts: [FailureType: Int] {
        let failedJobs = jobs.filter(\.isFailure)
        var counts: [FailureType: Int] = [.all: failedJobs.count]
        for job in failedJobs {
            let type = classifyFailure(job)
            counts[type, default: 0] += 1
        }
        return counts
    }

    var isLoading: Bool {
        state == .loading
    }

    var isAuthenticated: Bool {
        authManager.isAuthenticated
    }

    // MARK: - Init

    init(
        apiClient: APIClientProtocol = APIClient.shared,
        authManager: AuthManager = .shared
    ) {
        self.apiClient = apiClient
        self.authManager = authManager
        self.selectedRepo = Self.repos[0]

        // Initialize with last 7 days
        let now = Date()
        self.endDate = now
        self.startDate = Calendar.current.date(byAdding: .day, value: -7, to: now) ?? now
    }

    // MARK: - Actions

    func loadData() async {
        state = .loading
        do {
            // Format dates as ISO 8601 with milliseconds
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS"
            formatter.timeZone = TimeZone(identifier: "UTC")

            let startTimeString = formatter.string(from: startDate)
            let stopTimeString = formatter.string(from: endDate)

            let queryParams: [String: Any] = [
                "branch": selectedBranch,
                "repo": "\(selectedRepo.owner)/\(selectedRepo.name)",
                "startTime": startTimeString,
                "stopTime": stopTimeString
            ]

            let endpoint = APIEndpoint.failedJobsWithAnnotations(
                repoOwner: selectedRepo.owner,
                repoName: selectedRepo.name,
                queryParams: queryParams
            )

            let response: FailedJobsAnnotationResponse = try await apiClient.fetch(endpoint)

            // Update jobs
            jobs = response.failedJobs ?? []

            // Update annotations from the server
            var newAnnotations: [Int: AnnotationValue] = [:]
            for (jobIdString, annotationData) in response.annotationsMap ?? [:] {
                if let jobId = Int(jobIdString),
                   let rawAnnotation = annotationData.annotation,
                   let annotationValue = AnnotationValue(rawValue: rawAnnotation) {
                    newAnnotations[jobId] = annotationValue
                }
            }
            annotations = newAnnotations

            state = .loaded
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    func refresh() async {
        await loadData()
    }

    func selectRepo(_ repo: RepoConfig) {
        guard repo.id != selectedRepo.id else { return }
        selectedRepo = repo
        currentPage = 1
        jobs = []
        Task { await loadData() }
    }

    func selectBranch(_ branch: String) {
        guard branch != selectedBranch else { return }
        selectedBranch = branch
        currentPage = 1
        jobs = []
        Task { await loadData() }
    }

    func updateTimeRange(days: Int) {
        timeRangeDays = days
        let now = Date()
        endDate = now
        startDate = Calendar.current.date(byAdding: .day, value: -days, to: now) ?? now
        currentPage = 1
        jobs = []
        Task { await loadData() }
    }

    func updateCustomDateRange(start: Date, end: Date) {
        startDate = start
        endDate = end
        currentPage = 1
        jobs = []
        Task { await loadData() }
    }

    func annotate(jobId: Int, value: AnnotationValue) {
        annotations[jobId] = value
    }

    // MARK: - Private

    func classifyFailure(_ job: JobData) -> FailureType {
        // Check manual annotation first
        if let id = job.jobId, let annotation = annotations[id] {
            switch annotation {
            case .brokenTrunk: return .brokenTrunk
            case .flaky: return .flaky
            case .infra: return .infra
            case .none: break
            }
        }

        // If no annotation, check for heuristic classification
        // First check for infra issues (highest priority signal)
        if let lines = job.failureLines {
            let combined = lines.joined(separator: " ").lowercased()
            if combined.contains("docker") || combined.contains("runner") ||
               combined.contains("timeout") || combined.contains("disk space") ||
               combined.contains("infrastructure") || combined.contains("connection") ||
               combined.contains("oom") || combined.contains("no space left") ||
               combined.contains("network") || combined.contains("certificate") {
                return .infra
            }
        }

        // Check failureCaptures as well
        if let captures = job.failureCaptures {
            let combined = captures.joined(separator: " ").lowercased()
            if combined.contains("docker") || combined.contains("runner") ||
               combined.contains("timeout") || combined.contains("infrastructure") ||
               combined.contains("connection") || combined.contains("oom") {
                return .infra
            }
        }

        // Check if marked as unstable or has successful previous run
        if job.unstable == true {
            return .flaky
        }

        if let previous = job.previousRun, previous.conclusion == "success" {
            return .flaky
        }

        // If we have no annotation and no strong signals, it's not annotated
        return .notAnnotated
    }
}
