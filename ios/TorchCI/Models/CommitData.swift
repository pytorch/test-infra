import Foundation

struct PreviousRun: Decodable {
    let conclusion: String?
    let htmlUrl: String?
}

struct CommitResponse: Decodable {
    let commit: CommitInfo
    let jobs: [JobData]
}

struct CommitInfo: Decodable, Identifiable {
    let sha: String
    let commitTitle: String?
    let commitMessageBody: String?
    let author: String?
    let authorUrl: String?
    let time: String?
    let prNum: Int?
    let diffNum: String?

    var id: String { sha }
    var shortSha: String { String(sha.prefix(7)) }

    // Convenience aliases matching view usage
    var title: String? { commitTitle }
    var body: String? { commitMessageBody }
    var prNumber: Int? { prNum }

    var date: Date? {
        guard let time else { return nil }
        return ISO8601DateFormatter().date(from: time)
    }
}

/// Author information. Used when the API returns a structured author object
/// (e.g., from the GitHub API directly). For HUD commit data the author is
/// returned as a plain string (see `CommitInfo.author`).
struct AuthorInfo: Decodable {
    let login: String?
    let avatarUrl: String?
    let url: String?

    enum CodingKeys: String, CodingKey {
        case login
        case avatarUrl = "avatar_url"
        case url
    }
}

struct JobData: Decodable, Identifiable {
    /// The server-provided job ID (may be nil for pending/placeholder jobs).
    let jobId: Int?
    let name: String?
    let workflowName: String?
    let workflowId: Int?
    let jobName: String?
    let conclusion: String?
    let htmlUrl: String?
    let logUrl: String?
    let durationS: Int?
    let queueTimeS: Int?
    let failureLines: [String]?
    let failureCaptures: [String]?
    let failureContext: String?
    let runnerName: String?
    let runnerGroup: String?
    let status: String?
    let steps: [JobStep]?
    let time: String?
    let unstable: Bool?
    let previousRun: PreviousRun?
    let runAttempt: Int?
    /// The head branch this job ran on (e.g. "main", "viable/strict").
    let branch: String?

    /// Stable identity for SwiftUI; uses the server ID when available,
    /// otherwise falls back to a per-instance UUID.
    let id: String

    // JSON keys are camelCase (matching ClickHouse column aliases
    // and TypeScript interfaces).
    enum CodingKeys: String, CodingKey {
        case id, name, conclusion, status, steps, time, unstable
        case workflowName, workflowId, jobName
        case htmlUrl, logUrl, durationS, queueTimeS
        case failureLines, failureCaptures, failureContext
        case runnerName, runnerGroup, previousRun, runAttempt
        case branch = "head_branch"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedId = try container.decodeIfPresent(Int.self, forKey: .id)
        jobId = decodedId
        id = decodedId.map { String($0) } ?? UUID().uuidString
        name = try container.decodeIfPresent(String.self, forKey: .name)
        workflowName = try container.decodeIfPresent(String.self, forKey: .workflowName)
        workflowId = try container.decodeIfPresent(Int.self, forKey: .workflowId)
        jobName = try container.decodeIfPresent(String.self, forKey: .jobName)
        conclusion = try container.decodeIfPresent(String.self, forKey: .conclusion)
        htmlUrl = try container.decodeIfPresent(String.self, forKey: .htmlUrl)
        logUrl = try container.decodeIfPresent(String.self, forKey: .logUrl)
        durationS = try container.decodeIfPresent(Int.self, forKey: .durationS)
        queueTimeS = try container.decodeIfPresent(Int.self, forKey: .queueTimeS)
        failureLines = try container.decodeIfPresent([String].self, forKey: .failureLines)
        failureCaptures = try container.decodeIfPresent([String].self, forKey: .failureCaptures)
        failureContext = try container.decodeIfPresent(String.self, forKey: .failureContext)
        runnerName = try container.decodeIfPresent(String.self, forKey: .runnerName)
        runnerGroup = try container.decodeIfPresent(String.self, forKey: .runnerGroup)
        status = try container.decodeIfPresent(String.self, forKey: .status)
        steps = try container.decodeIfPresent([JobStep].self, forKey: .steps)
        time = try container.decodeIfPresent(String.self, forKey: .time)
        unstable = try container.decodeIfPresent(Bool.self, forKey: .unstable)
        previousRun = try container.decodeIfPresent(PreviousRun.self, forKey: .previousRun)
        runAttempt = try container.decodeIfPresent(Int.self, forKey: .runAttempt)
        branch = try container.decodeIfPresent(String.self, forKey: .branch)
    }

    /// Direct initializer for tests, previews, and manual construction.
    init(
        id: Int?, name: String?, workflowName: String?, workflowId: Int?,
        jobName: String?, conclusion: String?, htmlUrl: String?, logUrl: String?,
        durationS: Int?, queueTimeS: Int? = nil, failureLines: [String]?, failureCaptures: [String]?,
        failureContext: String?, runnerName: String?, runnerGroup: String?,
        status: String?, steps: [JobStep]?, time: String?, unstable: Bool?,
        previousRun: PreviousRun?, runAttempt: Int? = nil, branch: String? = nil
    ) {
        self.jobId = id
        self.id = id.map { String($0) } ?? UUID().uuidString
        self.name = name; self.workflowName = workflowName; self.workflowId = workflowId
        self.jobName = jobName; self.conclusion = conclusion
        self.htmlUrl = htmlUrl; self.logUrl = logUrl; self.durationS = durationS
        self.queueTimeS = queueTimeS
        self.failureLines = failureLines; self.failureCaptures = failureCaptures
        self.failureContext = failureContext; self.runnerName = runnerName
        self.runnerGroup = runnerGroup; self.status = status; self.steps = steps
        self.time = time; self.unstable = unstable; self.previousRun = previousRun
        self.runAttempt = runAttempt; self.branch = branch
    }

    var isFailure: Bool {
        switch conclusion {
        case "failure", "cancelled", "time_out", "timed_out":
            return true
        default:
            return false
        }
    }
    var isSuccess: Bool { conclusion == "success" }

    var durationFormatted: String? {
        guard let seconds = durationS else { return nil }
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        let secs = seconds % 60
        if hours > 0 {
            return "\(hours)h \(minutes)m \(secs)s"
        } else if minutes > 0 {
            return "\(minutes)m \(secs)s"
        } else {
            return "\(secs)s"
        }
    }
}

struct JobStep: Decodable, Identifiable {
    let name: String
    let conclusion: String?
    let number: Int
    let startedAt: String?
    let completedAt: String?

    var id: Int { number }

    enum CodingKeys: String, CodingKey {
        case name, conclusion, number
        case startedAt = "started_at"
        case completedAt = "completed_at"
    }
}
