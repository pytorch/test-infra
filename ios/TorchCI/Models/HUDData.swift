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

    var id: String { sha }

    enum CodingKeys: String, CodingKey {
        case sha, commitTitle, commitMessageBody, author, authorUrl, time, jobs, isForcedMerge
        case prNumber = "prNum"
    }

    var shortSha: String { String(sha.prefix(7)) }

    var commitDate: Date? {
        guard let time else { return nil }
        return ISO8601DateFormatter().date(from: time)
    }

    var relativeTime: String {
        guard let date = commitDate else { return time ?? "" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
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
    let failureLines: [String]?
    let failureCaptures: [String]?
    let runnerName: String?
    let unstable: Bool?
    let previousRun: PreviousRun?
    let authorEmail: String?

    /// Stable identity for SwiftUI; uses the server ID when available,
    /// otherwise falls back to a per-instance UUID.
    let id: String

    // JSON keys are camelCase (matching the ClickHouse column aliases
    // and TypeScript interface: htmlUrl, logUrl, durationS, etc.)
    enum CodingKeys: String, CodingKey {
        case id, name, conclusion, htmlUrl, logUrl, durationS
        case failureLines, failureCaptures, runnerName
        case unstable, previousRun, authorEmail
    }

    /// Custom decoder that handles all fields including failure data.
    /// Failure data is needed by FailedJobsView for classification and previews.
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
        runnerName = try container.decodeIfPresent(String.self, forKey: .runnerName)
        unstable = try container.decodeIfPresent(Bool.self, forKey: .unstable)
        previousRun = try container.decodeIfPresent(PreviousRun.self, forKey: .previousRun)
        authorEmail = try container.decodeIfPresent(String.self, forKey: .authorEmail)
        failureLines = try container.decodeIfPresent([String].self, forKey: .failureLines)
        failureCaptures = try container.decodeIfPresent([String].self, forKey: .failureCaptures)
    }

    // Direct initializer for tests and manual construction
    init(id: Int?, name: String?, conclusion: String?, htmlUrl: String?, logUrl: String?,
         durationS: Int?, failureLines: [String]?, failureCaptures: [String]?,
         runnerName: String?, unstable: Bool?, previousRun: PreviousRun?, authorEmail: String?) {
        self.jobId = id
        self.id = id.map { String($0) } ?? UUID().uuidString
        self.name = name; self.conclusion = conclusion
        self.htmlUrl = htmlUrl; self.logUrl = logUrl; self.durationS = durationS
        self.failureLines = failureLines; self.failureCaptures = failureCaptures
        self.runnerName = runnerName; self.unstable = unstable
        self.previousRun = previousRun; self.authorEmail = authorEmail
    }

    var isFailure: Bool { conclusion == "failure" }
    var isSuccess: Bool { conclusion == "success" }
    var isPending: Bool { (conclusion == nil || conclusion == "pending") && jobId != nil }
    var isUnstable: Bool { unstable == true }
    /// Job slot exists in the grid but no actual job was created for this commit.
    var isEmpty: Bool { conclusion == nil && jobId == nil }

    /// A failure that also failed on the previous commit (repeat/known breakage).
    var isRepeatFailure: Bool { isFailure && previousRun?.conclusion == "failure" }
    /// A failure where the previous commit succeeded (new breakage).
    var isNewFailure: Bool { isFailure && !isRepeatFailure }

    /// Whether this job name matches a viable-strict blocking pattern.
    var isViableStrictBlocking: Bool {
        guard let name else { return false }
        let lowered = name.lowercased()
        // Matches the web HUD's VIABLE_STRICT_BLOCKING_JOBS for pytorch/pytorch
        let blockingPatterns = ["pull", "trunk", "lint", "linux-aarch64"]
        let excludePatterns = ["mem_leak", "rerun_disabled"]
        if excludePatterns.contains(where: { lowered.contains($0) }) { return false }
        return blockingPatterns.contains(where: { lowered.contains($0) })
    }

    var durationFormatted: String? {
        guard let seconds = durationS else { return nil }
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        let secs = seconds % 60
        if hours > 0 {
            return "\(hours)h \(minutes)m"
        } else if minutes > 0 {
            return "\(minutes)m \(secs)s"
        } else {
            return "\(secs)s"
        }
    }
}

struct PreviousRun: Decodable {
    let conclusion: String?
    let htmlUrl: String?
}
