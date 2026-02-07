import Foundation

/// Response from the /api/{owner}/{repo}/pull/{prNumber} endpoint.
/// The API returns: { title: string, body: string, shas: [{sha, title}] }
struct PRResponse: Decodable {
    let title: String?
    let body: String?
    let shas: [PRShaInfo]?
    let state: String?
    let author: AuthorInfo?
    let number: Int?
    let createdAt: String?
    let updatedAt: String?
    let mergedAt: String?
    let closedAt: String?
    let headRef: String?
    let baseRef: String?

    /// Convenience: derive commits list from shas for the commit selector UI.
    var commits: [PRCommit] {
        shas?.map { PRCommit(sha: $0.sha, title: $0.title, time: nil) } ?? []
    }

    /// The head SHA is the last sha in the list (most recent commit).
    var headSha: String? {
        shas?.last?.sha
    }

    /// Extract branch name from body if available (e.g., "Differential Revision: D12345")
    var branchInfo: String? {
        guard let headRef = headRef, let baseRef = baseRef else { return nil }
        return "\(headRef) → \(baseRef)"
    }

    enum CodingKeys: String, CodingKey {
        case title, body, shas, state, author, number
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case mergedAt = "merged_at"
        case closedAt = "closed_at"
        case headRef = "head_ref"
        case baseRef = "base_ref"
    }
}

struct PRCommit: Decodable, Identifiable {
    let sha: String
    let title: String?
    let time: String?

    var id: String { sha }
    var shortSha: String { String(sha.prefix(7)) }
}

struct PRShaInfo: Decodable, Identifiable {
    let sha: String
    let title: String?

    var id: String { sha }
}
