import Foundation
import SwiftUI
import Combine

// MARK: - Deep Link Enum

/// Represents all navigable deep link destinations in TorchCI.
enum DeepLink: Equatable, Hashable {
    /// HUD tab with optional repo/branch context.
    case hud(repoOwner: String, repoName: String, branch: String)

    /// Commit detail page.
    case commit(repoOwner: String, repoName: String, sha: String)

    /// Pull request detail page.
    case pr(repoOwner: String, repoName: String, number: Int)

    /// Metrics tab.
    case metrics

    /// Tests tab.
    case tests

    /// Benchmarks tab.
    case benchmarks

    /// DevInfra tab.
    case devInfra

    /// TorchAgent tab.
    case torchAgent

    /// Settings tab.
    case settings

    /// Shared TorchAgent (Flambeau) session.
    case flambeau(uuid: String)

    /// OAuth callback -- forwarded to AuthManager, not handled by navigation.
    case oauthCallback(url: URL)

    // MARK: - Equatable

    static func == (lhs: DeepLink, rhs: DeepLink) -> Bool {
        switch (lhs, rhs) {
        case let (.hud(lo, ln, lb), .hud(ro, rn, rb)):
            return lo == ro && ln == rn && lb == rb
        case let (.commit(lo, ln, ls), .commit(ro, rn, rs)):
            return lo == ro && ln == rn && ls == rs
        case let (.pr(lo, ln, lp), .pr(ro, rn, rp)):
            return lo == ro && ln == rn && lp == rp
        case (.metrics, .metrics), (.tests, .tests), (.benchmarks, .benchmarks),
             (.devInfra, .devInfra), (.torchAgent, .torchAgent), (.settings, .settings):
            return true
        case let (.flambeau(lu), .flambeau(ru)):
            return lu == ru
        case let (.oauthCallback(lu), .oauthCallback(ru)):
            return lu == ru
        default:
            return false
        }
    }

    // MARK: - Hashable

    func hash(into hasher: inout Hasher) {
        switch self {
        case let .hud(owner, name, branch):
            hasher.combine("hud")
            hasher.combine(owner)
            hasher.combine(name)
            hasher.combine(branch)
        case let .commit(owner, name, sha):
            hasher.combine("commit")
            hasher.combine(owner)
            hasher.combine(name)
            hasher.combine(sha)
        case let .pr(owner, name, number):
            hasher.combine("pr")
            hasher.combine(owner)
            hasher.combine(name)
            hasher.combine(number)
        case .metrics:
            hasher.combine("metrics")
        case .tests:
            hasher.combine("tests")
        case .benchmarks:
            hasher.combine("benchmarks")
        case .devInfra:
            hasher.combine("devInfra")
        case .torchAgent:
            hasher.combine("torchAgent")
        case .settings:
            hasher.combine("settings")
        case let .flambeau(uuid):
            hasher.combine("flambeau")
            hasher.combine(uuid)
        case let .oauthCallback(url):
            hasher.combine("oauthCallback")
            hasher.combine(url)
        }
    }
}

// MARK: - Deep Link Handler

/// Parses incoming URLs (custom scheme and universal links) into ``DeepLink`` values
/// and broadcasts them via a Combine publisher for the UI layer to observe.
@MainActor
final class DeepLinkHandler: ObservableObject {
    static let shared = DeepLinkHandler()

    // MARK: - Published State

    /// The most recently received deep link. Observers should nil this out after handling.
    @Published var pendingDeepLink: DeepLink?

    // MARK: - Notification Name

    /// Legacy NotificationCenter bridge for components that cannot use Combine.
    static let deepLinkNotification = Notification.Name("com.pytorch.torchci.deepLink")
    static let deepLinkUserInfoKey = "deepLink"

    // MARK: - Init

    private init() {}

    // MARK: - Public API

    /// Attempt to parse a URL into a ``DeepLink``. Returns `nil` if the URL is not recognized.
    func parse(url: URL) -> DeepLink? {
        // Determine source: custom scheme (torchci://) or universal link (https://)
        if url.scheme == "torchci" {
            return parseCustomScheme(url: url)
        } else if url.scheme == "https" || url.scheme == "http" {
            return parseUniversalLink(url: url)
        }
        return nil
    }

    /// Parse a URL and immediately publish the resulting deep link.
    /// Returns `true` if the URL was recognized and published.
    @discardableResult
    func handle(url: URL) -> Bool {
        guard let link = parse(url: url) else { return false }
        publish(link)
        return true
    }

    /// Parse a push notification payload and publish the resulting deep link.
    /// Returns `true` if a deep link was extracted and published.
    @discardableResult
    func handle(notificationUserInfo: [AnyHashable: Any]) -> Bool {
        guard let link = parseNotificationPayload(notificationUserInfo) else { return false }
        publish(link)
        return true
    }

    // MARK: - Publishing

    private func publish(_ link: DeepLink) {
        pendingDeepLink = link

        // Also broadcast via NotificationCenter for components outside the SwiftUI hierarchy.
        NotificationCenter.default.post(
            name: Self.deepLinkNotification,
            object: nil,
            userInfo: [Self.deepLinkUserInfoKey: link]
        )
    }

    // MARK: - Custom Scheme Parsing
    // torchci://{host}/{path...}

    private func parseCustomScheme(url: URL) -> DeepLink? {
        guard let host = url.host(percentEncoded: false) ?? hostFallback(url: url) else {
            return nil
        }

        // Normalize: remove leading/trailing slashes, split path components
        let rawPath = url.path(percentEncoded: false)
        let pathComponents = rawPath
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)

        switch host {
        // torchci://hud/{owner}/{name}/{branch}
        case "hud":
            return parseHUDPath(pathComponents)

        // torchci://commit/{sha} or torchci://commit/{owner}/{name}/{sha}
        case "commit":
            return parseCommitPath(pathComponents)

        // torchci://pr/{number} or torchci://pr/{owner}/{name}/{number}
        case "pr":
            return parsePRPath(pathComponents)

        // torchci://metrics
        case "metrics":
            return .metrics

        // torchci://tests
        case "tests":
            return .tests

        // torchci://benchmarks
        case "benchmarks":
            return .benchmarks

        // torchci://devinfra or torchci://devInfra
        case "devinfra", "devInfra":
            return .devInfra

        // torchci://torchagent or torchci://torchAgent
        case "torchagent", "torchAgent":
            return .torchAgent

        // torchci://settings
        case "settings":
            return .settings

        // torchci://flambeau/{uuid}
        case "flambeau":
            guard let uuid = pathComponents.first, !uuid.isEmpty else { return nil }
            return .flambeau(uuid: uuid)

        // torchci://callback → OAuth callback
        case "callback":
            return .oauthCallback(url: url)

        default:
            return nil
        }
    }

    // MARK: - Universal Link Parsing
    // https://hud.pytorch.org/...

    private func parseUniversalLink(url: URL) -> DeepLink? {
        guard let host = url.host(percentEncoded: false),
              host == "hud.pytorch.org" || host == "www.hud.pytorch.org"
        else {
            return nil
        }

        let pathComponents = url.path(percentEncoded: false)
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)

        guard !pathComponents.isEmpty else { return nil }

        // Match against known web URL patterns

        // /hud/{owner}/{name}/{branch}
        if pathComponents.first == "hud" {
            let rest = Array(pathComponents.dropFirst())
            return parseHUDPath(rest)
        }

        // /flambeau/s/{uuid} (shared session)
        if pathComponents.first == "flambeau" && pathComponents.count >= 3 && pathComponents[1] == "s" {
            return .flambeau(uuid: pathComponents[2])
        }

        // /torchagent/shared/{uuid} (alternate shared session URL)
        if pathComponents.first == "torchagent" && pathComponents.count >= 3 && pathComponents[1] == "shared" {
            return .flambeau(uuid: pathComponents[2])
        }

        // /{owner}/{name}/commit/{sha}
        if pathComponents.count >= 4 && pathComponents[2] == "commit" {
            let owner = pathComponents[0]
            let name = pathComponents[1]
            let sha = pathComponents[3]
            return .commit(repoOwner: owner, repoName: name, sha: sha)
        }

        // /{owner}/{name}/pull/{number}
        if pathComponents.count >= 4 && pathComponents[2] == "pull" {
            let owner = pathComponents[0]
            let name = pathComponents[1]
            if let number = Int(pathComponents[3]) {
                return .pr(repoOwner: owner, repoName: name, number: number)
            }
        }

        return nil
    }

    // MARK: - Path Parsers

    /// Parse HUD path components: `[owner, name, branch]` or `[owner, name]` (defaults to main).
    private func parseHUDPath(_ components: [String]) -> DeepLink? {
        guard components.count >= 2 else {
            // Bare /hud with no owner/name → default to pytorch/pytorch/main
            return .hud(repoOwner: "pytorch", repoName: "pytorch", branch: "main")
        }
        let owner = components[0]
        let name = components[1]
        // Branch may contain slashes (e.g., "viable/strict"), so join remaining components.
        let branch: String
        if components.count >= 3 {
            branch = components[2...].joined(separator: "/")
        } else {
            branch = "main"
        }
        return .hud(repoOwner: owner, repoName: name, branch: branch)
    }

    /// Parse commit path: `[sha]` or `[owner, name, sha]`.
    private func parseCommitPath(_ components: [String]) -> DeepLink? {
        switch components.count {
        case 1:
            return .commit(repoOwner: "pytorch", repoName: "pytorch", sha: components[0])
        case 3...:
            return .commit(repoOwner: components[0], repoName: components[1], sha: components[2])
        default:
            return nil
        }
    }

    /// Parse PR path: `[number]` or `[owner, name, number]`.
    private func parsePRPath(_ components: [String]) -> DeepLink? {
        switch components.count {
        case 1:
            guard let number = Int(components[0]) else { return nil }
            return .pr(repoOwner: "pytorch", repoName: "pytorch", number: number)
        case 3...:
            guard let number = Int(components[2]) else { return nil }
            return .pr(repoOwner: components[0], repoName: components[1], number: number)
        default:
            return nil
        }
    }

    // MARK: - Notification Payload Parsing

    /// Extract a deep link from a push notification's userInfo dictionary.
    ///
    /// Expected payload keys:
    /// - `"type"`: One of `"hud_failure"`, `"commit"`, `"pr"`, `"flambeau"`
    /// - `"branch"`: Branch name (for HUD)
    /// - `"repoOwner"`: Repository owner (optional, defaults to "pytorch")
    /// - `"repoName"`: Repository name (optional, defaults to "pytorch")
    /// - `"sha"`: Commit SHA (for commit links)
    /// - `"prNumber"`: PR number as string or int (for PR links)
    /// - `"uuid"`: Session UUID (for flambeau links)
    /// - `"url"`: Fallback deep link URL as a string
    private func parseNotificationPayload(_ userInfo: [AnyHashable: Any]) -> DeepLink? {
        let repoOwner = userInfo["repoOwner"] as? String ?? "pytorch"
        let repoName = userInfo["repoName"] as? String ?? "pytorch"

        if let type = userInfo["type"] as? String {
            switch type {
            case "hud_failure":
                let branch = userInfo["branch"] as? String ?? "main"
                return .hud(repoOwner: repoOwner, repoName: repoName, branch: branch)

            case "commit":
                if let sha = userInfo["sha"] as? String {
                    return .commit(repoOwner: repoOwner, repoName: repoName, sha: sha)
                }

            case "pr":
                if let number = prNumber(from: userInfo) {
                    return .pr(repoOwner: repoOwner, repoName: repoName, number: number)
                }

            case "flambeau":
                if let uuid = userInfo["uuid"] as? String {
                    return .flambeau(uuid: uuid)
                }

            default:
                break
            }
        }

        // Fallback: try to parse the "url" key.
        if let urlString = userInfo["url"] as? String,
           let url = URL(string: urlString) {
            return parse(url: url)
        }

        // Fallback for legacy HUD failure notifications with "branch" key.
        if let branch = userInfo["branch"] as? String {
            return .hud(repoOwner: repoOwner, repoName: repoName, branch: branch)
        }

        return nil
    }

    // MARK: - Helpers

    /// Extract PR number from a notification payload value that may be String or Int.
    private func prNumber(from userInfo: [AnyHashable: Any]) -> Int? {
        if let number = userInfo["prNumber"] as? Int {
            return number
        }
        if let numberStr = userInfo["prNumber"] as? String {
            return Int(numberStr)
        }
        return nil
    }

    /// Fallback host extraction for older iOS URL parsing where `url.host()` may return nil
    /// for custom scheme URLs like `torchci://hud/...`.
    private func hostFallback(url: URL) -> String? {
        // URLComponents with custom schemes can place the host in the path.
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        // If host is available directly, use it.
        if let host = components.host, !host.isEmpty {
            return host
        }
        // Some URL parsers put everything in the path for opaque scheme URLs.
        // Try extracting the first path segment as the host.
        let path = components.path
        let segments = path.split(separator: "/", omittingEmptySubsequences: true)
        return segments.first.map(String.init)
    }
}

// MARK: - DeepLink Convenience Properties

extension DeepLink {
    /// The ``AppTab`` that should be selected for this deep link.
    var targetTab: AppTab {
        switch self {
        case .hud, .commit, .pr:
            return .hud
        case .metrics:
            return .metrics
        case .tests:
            return .tests
        case .benchmarks:
            return .benchmarks
        case .devInfra:
            return .devInfra
        case .torchAgent, .flambeau:
            return .torchAgent
        case .settings, .oauthCallback:
            return .settings
        }
    }

    /// A human-readable description for logging/debugging purposes.
    var debugDescription: String {
        switch self {
        case let .hud(owner, name, branch):
            return "hud(\(owner)/\(name)/\(branch))"
        case let .commit(owner, name, sha):
            return "commit(\(owner)/\(name)/\(sha.prefix(7)))"
        case let .pr(owner, name, number):
            return "pr(\(owner)/\(name)/#\(number))"
        case .metrics:
            return "metrics"
        case .tests:
            return "tests"
        case .benchmarks:
            return "benchmarks"
        case .devInfra:
            return "devInfra"
        case .torchAgent:
            return "torchAgent"
        case .settings:
            return "settings"
        case let .flambeau(uuid):
            return "flambeau(\(uuid.prefix(8))...)"
        case .oauthCallback:
            return "oauthCallback"
        }
    }
}

// MARK: - View Modifier for Deep Link Handling

/// A view modifier that observes ``DeepLinkHandler`` and drives navigation state.
/// Attach this to the root ``ContentView`` to coordinate tab switches and
/// navigation pushes in response to incoming deep links.
struct DeepLinkNavigationModifier: ViewModifier {
    @ObservedObject var deepLinkHandler: DeepLinkHandler
    @Binding var selectedTab: AppTab
    @Binding var hudDeepLink: DeepLink?
    @Binding var navigationPath: NavigationPath

    func body(content: Content) -> some View {
        content
            .onOpenURL { url in
                deepLinkHandler.handle(url: url)
            }
            .onChange(of: deepLinkHandler.pendingDeepLink) { _, newLink in
                guard let link = newLink else { return }
                handleDeepLink(link)
                // Clear the pending link after a short delay to allow navigation
                // animations to complete. The delay prevents re-entrance issues
                // if the same link arrives twice in quick succession.
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(500))
                    if deepLinkHandler.pendingDeepLink == link {
                        deepLinkHandler.pendingDeepLink = nil
                    }
                }
            }
    }

    private func handleDeepLink(_ link: DeepLink) {
        // OAuth callbacks are handled by AuthManager, not navigation.
        if case .oauthCallback = link { return }

        // Switch to the correct tab.
        withAnimation(.easeInOut(duration: 0.25)) {
            selectedTab = link.targetTab
        }

        // For links that need to push views onto a NavigationStack,
        // forward the deep link to the HUD tab's navigation binding.
        switch link {
        case .hud, .commit, .pr, .flambeau:
            // Small delay to ensure tab switch completes first.
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(100))
                hudDeepLink = link
            }
        case .metrics, .tests, .benchmarks, .devInfra, .torchAgent, .settings, .oauthCallback:
            // Tab switch is sufficient; no further navigation needed.
            break
        }
    }
}

extension View {
    /// Apply deep link navigation handling to this view.
    func handleDeepLinks(
        handler: DeepLinkHandler,
        selectedTab: Binding<AppTab>,
        hudDeepLink: Binding<DeepLink?>,
        navigationPath: Binding<NavigationPath>
    ) -> some View {
        modifier(DeepLinkNavigationModifier(
            deepLinkHandler: handler,
            selectedTab: selectedTab,
            hudDeepLink: hudDeepLink,
            navigationPath: navigationPath
        ))
    }
}
