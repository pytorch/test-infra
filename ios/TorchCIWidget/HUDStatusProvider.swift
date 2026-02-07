import Foundation
import WidgetKit

// MARK: - Timeline Provider

struct HUDStatusProvider: AppIntentTimelineProvider {
    typealias Entry = HUDStatusEntry
    typealias Intent = HUDWidgetIntent

    private static let baseURL = URL(string: "https://hud.pytorch.org")!

    func placeholder(in context: Context) -> HUDStatusEntry {
        HUDStatusEntry.placeholder
    }

    func snapshot(for configuration: HUDWidgetIntent, in context: Context) async -> HUDStatusEntry {
        if context.isPreview {
            return HUDStatusEntry.placeholder
        }
        do {
            let commits = try await fetchHUDData(configuration: configuration, maxCommits: maxCommits(for: context.family))
            return HUDStatusEntry(
                date: .now,
                configuration: configuration,
                commits: commits,
                repoDisplay: configuration.repositoryName,
                branchDisplay: configuration.branchName,
                isPlaceholder: false
            )
        } catch {
            return HUDStatusEntry.error(configuration: configuration)
        }
    }

    func timeline(for configuration: HUDWidgetIntent, in context: Context) async -> Timeline<HUDStatusEntry> {
        let refreshDate = Calendar.current.date(byAdding: .minute, value: 15, to: .now) ?? .now

        do {
            let commits = try await fetchHUDData(configuration: configuration, maxCommits: maxCommits(for: context.family))
            let entry = HUDStatusEntry(
                date: .now,
                configuration: configuration,
                commits: commits,
                repoDisplay: configuration.repositoryName,
                branchDisplay: configuration.branchName,
                isPlaceholder: false
            )
            return Timeline(entries: [entry], policy: .after(refreshDate))
        } catch {
            let entry = HUDStatusEntry.error(configuration: configuration)
            // On error, retry sooner (5 minutes)
            let retryDate = Calendar.current.date(byAdding: .minute, value: 5, to: .now) ?? .now
            return Timeline(entries: [entry], policy: .after(retryDate))
        }
    }

    // MARK: - Data Fetching

    private func fetchHUDData(configuration: HUDWidgetIntent, maxCommits: Int) async throws -> [WidgetCommit] {
        let owner = configuration.repoOwner
        let name = configuration.repoName
        let branch = configuration.branchName

        // Build URL matching the API pattern: /api/hud/{owner}/{name}/{branch}/{page}?per_page=N
        // We only need the first page with a small number of commits for the widget
        let perPage = maxCommits
        let path = "/api/hud/\(owner)/\(name)/\(branch)/1"

        guard var components = URLComponents(url: Self.baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: true) else {
            throw WidgetFetchError.invalidURL
        }
        components.queryItems = [URLQueryItem(name: "per_page", value: "\(perPage)")]

        guard let url = components.url else {
            throw WidgetFetchError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 15

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw WidgetFetchError.invalidResponse
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw WidgetFetchError.httpError(httpResponse.statusCode)
        }

        let hudResponse = try JSONDecoder().decode(WidgetHUDResponse.self, from: data)
        return convertToWidgetCommits(hudResponse.shaGrid, maxCommits: maxCommits)
    }

    private func convertToWidgetCommits(_ rows: [WidgetHUDRow], maxCommits: Int) -> [WidgetCommit] {
        let limitedRows = Array(rows.prefix(maxCommits))
        return limitedRows.map { row in
            let passCount = row.jobs.filter { $0.conclusion == "success" }.count
            let failCount = row.jobs.filter { $0.conclusion == "failure" && $0.unstable != true }.count
            let pendingCount = row.jobs.filter { $0.conclusion == nil || $0.conclusion == "pending" }.count
            let totalJobs = row.jobs.count

            let overallStatus: WidgetCommit.CommitStatus
            if totalJobs == 0 {
                overallStatus = .unknown
            } else if failCount > 0 && passCount > 0 {
                overallStatus = .mixed
            } else if failCount > 0 {
                overallStatus = .failure
            } else if pendingCount > passCount {
                overallStatus = .pending
            } else if passCount == 0 && pendingCount > 0 {
                overallStatus = .pending
            } else {
                overallStatus = .success
            }

            let relativeTime = formatRelativeTime(row.time)

            return WidgetCommit(
                id: row.sha,
                sha: row.sha,
                shortSha: String(row.sha.prefix(7)),
                title: row.commitTitle ?? "No title",
                author: row.author ?? "unknown",
                relativeTime: relativeTime,
                overallStatus: overallStatus,
                passCount: passCount,
                failCount: failCount,
                pendingCount: pendingCount,
                totalJobs: totalJobs,
                isForcedMerge: row.isForcedMerge ?? false
            )
        }
    }

    private func formatRelativeTime(_ isoString: String?) -> String {
        guard let isoString, !isoString.isEmpty else { return "--" }
        guard let date = ISO8601DateFormatter().date(from: isoString) else { return isoString }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: .now)
    }

    private func maxCommits(for family: WidgetFamily) -> Int {
        switch family {
        case .systemSmall: return 1
        case .systemMedium: return 3
        case .systemLarge: return 5
        default: return 3
        }
    }
}

// MARK: - Widget-local Decodable models
// These mirror the main app's HUDData models but are self-contained for the widget extension.

private struct WidgetHUDResponse: Decodable {
    let shaGrid: [WidgetHUDRow]
    let jobNames: [String]
}

private struct WidgetHUDRow: Decodable {
    let sha: String
    let commitTitle: String?
    let commitMessageBody: String?
    let prNumber: Int?
    let author: String?
    let authorUrl: String?
    let time: String?
    let jobs: [WidgetHUDJob]
    let isForcedMerge: Bool?
}

private struct WidgetHUDJob: Decodable {
    let id: Int?
    let name: String?
    let conclusion: String?
    let htmlUrl: String?
    let logUrl: String?
    let durationS: Int?
    let failureLines: [String]?
    let failureCaptures: [String]?
    let runnerName: String?
    let unstable: Bool?
    let authorEmail: String?

    enum CodingKeys: String, CodingKey {
        case id, name, conclusion, unstable
        case htmlUrl = "html_url"
        case logUrl = "log_url"
        case durationS = "duration_s"
        case failureLines = "failure_lines"
        case failureCaptures = "failure_captures"
        case runnerName = "runner_name"
        case authorEmail = "author_email"
    }
}

// MARK: - Widget Fetch Error

enum WidgetFetchError: LocalizedError {
    case invalidURL
    case invalidResponse
    case httpError(Int)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid URL"
        case .invalidResponse:
            return "Invalid response from server"
        case .httpError(let code):
            return "HTTP error \(code)"
        }
    }
}
