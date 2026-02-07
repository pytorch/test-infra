import Foundation

actor HUDMonitor {
    private var isCancelled = false
    private let apiClient: APIClientProtocol

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    func cancel() {
        isCancelled = true
    }

    func checkForFailures(
        preferences: NotificationPreferences,
        onAlert: @Sendable @escaping (String, Int, [String]) -> Void
    ) async {
        guard preferences.enabled else { return }

        for repo in preferences.monitoredRepos {
            for branch in preferences.monitoredBranches {
                guard !isCancelled else { return }

                do {
                    let consecutiveFailures = try await countConsecutiveFailures(
                        repoOwner: repo.owner,
                        repoName: repo.name,
                        branch: branch
                    )

                    if consecutiveFailures.count >= preferences.failureThreshold {
                        onAlert(
                            "\(repo.displayName)/\(branch)",
                            consecutiveFailures.count,
                            consecutiveFailures.topPatterns
                        )
                    }
                } catch {
                    // Silently fail for background tasks
                    continue
                }
            }
        }
    }

    private func countConsecutiveFailures(
        repoOwner: String,
        repoName: String,
        branch: String
    ) async throws -> FailureResult {
        let endpoint = APIEndpoint.hud(
            repoOwner: repoOwner,
            repoName: repoName,
            branch: branch,
            page: 1,
            perPage: 20
        )

        let data: HUDResponse = try await apiClient.fetch(endpoint)
        var consecutiveRed = 0
        var failurePatterns: [String: Int] = [:]

        for row in data.shaGrid {
            let hasFailure = row.jobs.contains { job in
                job.conclusion == "failure" && !(job.unstable ?? false)
            }

            if hasFailure {
                consecutiveRed += 1
                for job in row.jobs where job.conclusion == "failure" {
                    if let name = job.name {
                        failurePatterns[name, default: 0] += 1
                    }
                }
            } else {
                break
            }
        }

        let topPatterns = failurePatterns
            .sorted { $0.value > $1.value }
            .prefix(3)
            .map(\.key)

        return FailureResult(count: consecutiveRed, topPatterns: topPatterns)
    }
}

struct FailureResult {
    let count: Int
    let topPatterns: [String]
}
