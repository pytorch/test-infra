import Foundation
import UIKit

@MainActor
final class JobDetailViewModel: ObservableObject {
    // MARK: - State

    @Published var isFailureLinesExpanded: Bool = true
    @Published var isFailureCapturesExpanded: Bool = true
    @Published var isFailureContextExpanded: Bool = false
    @Published var isStepsExpanded: Bool = false
    @Published var isRunnerInfoExpanded: Bool = false
    @Published var copiedLink: Bool = false

    let job: JobData

    // MARK: - Init

    init(job: JobData) {
        self.job = job
        // Auto-expand steps if no failure info is present
        if !job.isFailure {
            isStepsExpanded = true
            isFailureLinesExpanded = false
            isFailureCapturesExpanded = false
        }
    }

    // MARK: - Computed Properties

    var displayName: String {
        job.jobName ?? job.name ?? "Unknown Job"
    }

    var workflowDisplayName: String {
        job.workflowName ?? "Unknown Workflow"
    }

    var conclusionDisplay: String {
        job.conclusion?.capitalized ?? job.status?.capitalized ?? "Unknown"
    }

    var jobIdDisplay: String? {
        job.jobId.map { "Job #\($0)" }
    }

    var workflowIdDisplay: String? {
        job.workflowId.map { "Workflow #\($0)" }
    }

    var runAttemptDisplay: String? {
        guard let attempt = job.runAttempt else { return nil }
        return "Attempt \(attempt)"
    }

    var queueTimeFormatted: String? {
        guard let queueTimeS = job.queueTimeS else { return nil }
        return DurationFormatter.format(queueTimeS)
    }

    var hasFailureInfo: Bool {
        let hasLines = !(job.failureLines ?? []).isEmpty
        let hasCaptures = !(job.failureCaptures ?? []).isEmpty
        let hasContext = !(job.failureContext ?? "").isEmpty
        return hasLines || hasCaptures || hasContext
    }

    var hasSteps: Bool {
        !(job.steps ?? []).isEmpty
    }

    var hasRunnerInfo: Bool {
        job.runnerName != nil || job.runnerGroup != nil
    }

    var hasPreviousRun: Bool {
        job.previousRun != nil
    }

    var githubURL: String? {
        job.htmlUrl
    }

    var logsURL: String? {
        job.logUrl
    }

    var sortedSteps: [JobStep] {
        (job.steps ?? []).sorted { $0.number < $1.number }
    }

    var stepsProgress: (completed: Int, total: Int) {
        let steps = job.steps ?? []
        let completed = steps.filter { $0.conclusion != nil && $0.conclusion != "in_progress" }.count
        return (completed, steps.count)
    }

    var hasAnyMetrics: Bool {
        job.durationS != nil || job.queueTimeS != nil
    }

    // MARK: - Step Analysis

    /// Counts of steps by conclusion status.
    var stepCounts: (success: Int, failure: Int, skipped: Int, pending: Int) {
        let steps = job.steps ?? []
        let success = steps.filter { $0.conclusion == "success" }.count
        let failure = steps.filter { $0.conclusion == "failure" }.count
        let skipped = steps.filter { $0.conclusion == "skipped" }.count
        let pending = steps.filter { $0.conclusion == nil || $0.conclusion == "in_progress" || $0.conclusion == "queued" }.count
        return (success, failure, skipped, pending)
    }

    /// Name of the first failed step, if any.
    var failedStepName: String? {
        sortedSteps.first { $0.conclusion == "failure" }?.name
    }

    /// Progress fraction (0.0 to 1.0) of completed steps.
    var stepsProgressFraction: Double {
        let progress = stepsProgress
        guard progress.total > 0 else { return 0 }
        return Double(progress.completed) / Double(progress.total)
    }

    /// A concise one-line status summary suitable for display beneath the job name.
    var statusSummaryText: String {
        let conclusion = job.conclusion?.lowercased()
        switch conclusion {
        case "success":
            if let duration = job.durationFormatted {
                return "Completed successfully in \(duration)"
            }
            return "Completed successfully"
        case "failure":
            if let stepName = failedStepName {
                return "Failed at: \(stepName)"
            }
            return "Failed"
        case "cancelled", "canceled":
            return "Cancelled"
        case "skipped":
            return "Skipped"
        default:
            if let status = job.status?.lowercased(), status == "in_progress" || status == "queued" {
                let progress = stepsProgress
                if progress.total > 0 {
                    return "Running (\(progress.completed)/\(progress.total) steps)"
                }
                return "Running"
            }
            return job.status?.capitalized ?? "Unknown"
        }
    }

    /// Total count of failure lines across all failure info.
    var totalFailureLineCount: Int {
        (job.failureLines?.count ?? 0)
    }

    /// The first failure capture, used as a summary preview.
    var failureSummary: String? {
        job.failureCaptures?.first
    }

    // MARK: - Actions

    func copyLink() {
        guard let urlString = job.htmlUrl else { return }
        UIPasteboard.general.string = urlString
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        copiedLink = true

        Task {
            try? await Task.sleep(for: .seconds(2))
            copiedLink = false
        }
    }

    @Published var copiedFailure: Bool = false

    func copyFailureSummary() {
        var parts: [String] = []
        parts.append("Job: \(displayName)")
        if let conclusion = job.conclusion {
            parts.append("Status: \(conclusion)")
        }
        if let url = job.htmlUrl {
            parts.append("Link: \(url)")
        }
        if let captures = job.failureCaptures, !captures.isEmpty {
            parts.append("Failures:")
            for capture in captures {
                parts.append("  - \(capture)")
            }
        } else if let lines = job.failureLines, !lines.isEmpty {
            parts.append("Failure lines:")
            for line in lines.prefix(10) {
                parts.append("  \(line)")
            }
            if lines.count > 10 {
                parts.append("  ... (\(lines.count - 10) more lines)")
            }
        }
        UIPasteboard.general.string = parts.joined(separator: "\n")
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        copiedFailure = true

        Task {
            try? await Task.sleep(for: .seconds(2))
            copiedFailure = false
        }
    }
}
