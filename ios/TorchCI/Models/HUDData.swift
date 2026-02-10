import Foundation

struct HUDResponse: Decodable {
    let shaGrid: [HUDRow]
    let jobNames: [String]
}

struct HUDRow: Decodable, Identifiable {
    let sha: String
    let commitTitle: String?
    let commitMessageBody: String?
    let prNumber: Int?
    let author: String?
    let authorUrl: String?
    let time: String?
    let jobs: [HUDJob]
    let isForcedMerge: Bool?
    let isForcedMergeWithFailures: Bool?
    let isAutoreverted: Bool?
    let autorevertWorkflows: [String]?
    let autorevertSignals: [String]?

    var id: String { sha }

    enum CodingKeys: String, CodingKey {
        case sha, commitTitle, commitMessageBody, author, authorUrl, time, jobs
        case isForcedMerge, isForcedMergeWithFailures, isAutoreverted
        case autorevertWorkflows, autorevertSignals
        case prNumber = "prNum"
    }

    init(sha: String, commitTitle: String?, commitMessageBody: String?, prNumber: Int?,
         author: String?, authorUrl: String?, time: String?, jobs: [HUDJob],
         isForcedMerge: Bool? = nil, isForcedMergeWithFailures: Bool? = nil,
         isAutoreverted: Bool? = nil, autorevertWorkflows: [String]? = nil,
         autorevertSignals: [String]? = nil) {
        self.sha = sha; self.commitTitle = commitTitle
        self.commitMessageBody = commitMessageBody; self.prNumber = prNumber
        self.author = author; self.authorUrl = authorUrl; self.time = time
        self.jobs = jobs; self.isForcedMerge = isForcedMerge
        self.isForcedMergeWithFailures = isForcedMergeWithFailures
        self.isAutoreverted = isAutoreverted
        self.autorevertWorkflows = autorevertWorkflows
        self.autorevertSignals = autorevertSignals
    }

    var shortSha: String { String(sha.prefix(7)) }

    nonisolated(unsafe) private static let isoFormatter = ISO8601DateFormatter()
    nonisolated(unsafe) private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    var commitDate: Date? {
        guard let time else { return nil }
        return Self.isoFormatter.date(from: time)
    }

    var relativeTime: String {
        guard let date = commitDate else { return time ?? "" }
        return Self.relativeFormatter.localizedString(for: date, relativeTo: Date())
    }
}

struct HUDJob: Decodable, Identifiable {
    /// The server-provided job ID (may be nil for pending/placeholder jobs).
    let jobId: Int?
    let name: String?
    let conclusion: String?
    let htmlUrl: String?
    let logUrl: String?
    let durationS: Int?
    let queueTimeS: Int?
    let failureLines: [String]?
    let failureCaptures: [String]?
    let runnerName: String?
    let unstable: Bool?
    /// Whether a previous run of this job (same name, same SHA) failed.
    /// This is a simple boolean from the API (not a full PreviousRun object).
    let failedPreviousRun: Bool?
    let status: String?
    let failureAnnotation: String?
    let authorEmail: String?

    /// Stable identity for SwiftUI; uses the server ID when available,
    /// otherwise falls back to a per-instance UUID.
    let id: String

    // JSON keys are camelCase (matching the TypeScript interface)
    enum CodingKeys: String, CodingKey {
        case id, name, conclusion, status, htmlUrl, logUrl, durationS, queueTimeS
        case failureLines, failureCaptures, runnerName
        case unstable, failedPreviousRun, failureAnnotation, authorEmail
    }

    /// Custom decoder that handles all fields including failure data.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedId = try container.decodeIfPresent(Int.self, forKey: .id)
        jobId = decodedId
        id = decodedId.map { String($0) } ?? UUID().uuidString
        name = try container.decodeIfPresent(String.self, forKey: .name)
        conclusion = try container.decodeIfPresent(String.self, forKey: .conclusion)
        htmlUrl = try container.decodeIfPresent(String.self, forKey: .htmlUrl)
        logUrl = try container.decodeIfPresent(String.self, forKey: .logUrl)
        durationS = try container.decodeIfPresent(Int.self, forKey: .durationS)
        queueTimeS = try container.decodeIfPresent(Int.self, forKey: .queueTimeS)
        runnerName = try container.decodeIfPresent(String.self, forKey: .runnerName)
        status = try container.decodeIfPresent(String.self, forKey: .status)
        unstable = try container.decodeIfPresent(Bool.self, forKey: .unstable)
        failedPreviousRun = try container.decodeIfPresent(Bool.self, forKey: .failedPreviousRun)
        failureAnnotation = try container.decodeIfPresent(String.self, forKey: .failureAnnotation)
        authorEmail = try container.decodeIfPresent(String.self, forKey: .authorEmail)
        failureLines = try container.decodeIfPresent([String].self, forKey: .failureLines)
        failureCaptures = try container.decodeIfPresent([String].self, forKey: .failureCaptures)
    }

    // Direct initializer for tests and manual construction
    init(id: Int?, name: String?, conclusion: String?, htmlUrl: String?, logUrl: String?,
         durationS: Int?, queueTimeS: Int? = nil, failureLines: [String]?, failureCaptures: [String]?,
         runnerName: String?, unstable: Bool?, failedPreviousRun: Bool? = nil,
         failureAnnotation: String? = nil, authorEmail: String?, status: String? = nil) {
        self.jobId = id
        self.id = id.map { String($0) } ?? UUID().uuidString
        self.name = name; self.conclusion = conclusion; self.status = status
        self.htmlUrl = htmlUrl; self.logUrl = logUrl; self.durationS = durationS
        self.queueTimeS = queueTimeS
        self.failureLines = failureLines; self.failureCaptures = failureCaptures
        self.runnerName = runnerName; self.unstable = unstable
        self.failedPreviousRun = failedPreviousRun
        self.failureAnnotation = failureAnnotation; self.authorEmail = authorEmail
    }

    var isFailure: Bool { conclusion == "failure" }
    var isSuccess: Bool { conclusion == "success" }
    var isPending: Bool {
        guard jobId != nil else { return false }
        if let s = status?.lowercased(), s == "queued" || s == "in_progress" { return true }
        return conclusion == nil || conclusion == "pending"
    }
    var isUnstable: Bool { unstable == true }
    /// Job slot exists in the grid but no actual job was created for this commit.
    var isEmpty: Bool { conclusion == nil && jobId == nil }

    /// Failure has been classified/annotated by a team member.
    var isClassified: Bool { isFailure && failureAnnotation != nil }

    /// Succeeded but a previous run of the same job (same commit) failed — flaky.
    var isFlaky: Bool { isSuccess && failedPreviousRun == true }
    /// A failure that also failed on a previous run (known/preexisting breakage).
    var isRepeatFailure: Bool { isFailure && failedPreviousRun == true }
    /// A failure where the previous run did not fail (new breakage).
    var isNewFailure: Bool { isFailure && !isRepeatFailure }

    /// Whether this job name matches a viable-strict blocking pattern.
    /// Note: In HUD grid data, jobs often lack an individual `name`; use
    /// `HUDJob.isBlockingName(_:)` with the name from the `jobNames` array instead.
    var isViableStrictBlocking: Bool {
        guard let name else { return false }
        return Self.isBlockingName(name)
    }

    /// Check whether a job name matches a viable/strict blocking pattern.
    /// Uses regex matching consistent with the web app's `isJobViableStrictBlocking`.
    static func isBlockingName(_ name: String) -> Bool {
        let lowered = name.lowercased()
        // Exclude memory leak and rerun jobs (web uses ", mem_leak" and ", rerun_" with comma prefix)
        if lowered.contains(", mem_leak") || lowered.contains(", rerun_") { return false }
        // Case-insensitive regex patterns matching web's VIABLE_STRICT_BLOCKING_JOBS for pytorch/pytorch
        let blockingPatterns: [String] = ["pull", "trunk", "lint", "linux-aarch64"]
        return blockingPatterns.contains { pattern in
            lowered.range(of: pattern, options: .regularExpression) != nil
        }
    }

    /// Check whether a specific job triggered an autorevert signal.
    /// Ports the web app's `isJobAutorevertSignal` from autorevertUtils.ts.
    static func isAutorevertSignal(jobName: String, row: HUDRow) -> Bool {
        guard let workflows = row.autorevertWorkflows, !workflows.isEmpty,
              let signals = row.autorevertSignals, !signals.isEmpty else {
            return false
        }

        let lowWorkflows = workflows.map { $0.lowercased() }

        // Split "workflow / jobName (config)" into parts, stripping parenthesized suffixes
        let parts = jobName.lowercased()
            .split(separator: "/")
            .map { part in
                var trimmed = part.trimmingCharacters(in: .whitespaces)
                // Remove trailing " (...)" parenthesized config
                if let parenRange = trimmed.range(of: #" \(.*\)$"#, options: .regularExpression) {
                    trimmed = String(trimmed[..<parenRange.lowerBound]).trimmingCharacters(in: .whitespaces)
                }
                return trimmed
            }

        guard !parts.isEmpty else { return false }
        let jobWorkflow = parts[0]
        let jobNameParts = Array(parts.dropFirst())

        // The job's workflow must be in the autorevert workflows list
        guard lowWorkflows.contains(jobWorkflow) else { return false }

        // Check if any signal matches the job name parts
        return signals.contains { signal in
            let signalParts = signal.lowercased()
                .split(separator: "/")
                .map { $0.trimmingCharacters(in: .whitespaces) }
            return jobNameParts.enumerated().allSatisfy { idx, part in
                idx < signalParts.count && part == signalParts[idx]
            }
        }
    }

    var durationFormatted: String? {
        guard let seconds = durationS else { return nil }
        return DurationFormatter.format(seconds)
    }

    var accessibilityStatus: String {
        if isClassified { return "classified" }
        if isUnstable { return "unstable" }
        if isFlaky { return "flaky" }
        if isFailure { return "failure" }
        if isSuccess { return "success" }
        if isPending { return "pending" }
        return "unknown"
    }
}

