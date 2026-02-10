import XCTest
@testable import TorchCI

@MainActor
final class DeepLinkHandlerTests: XCTestCase {
    private var handler: DeepLinkHandler!

    override func setUp() async throws {
        try await super.setUp()
        handler = DeepLinkHandler.shared
        handler.pendingDeepLink = nil
    }

    override func tearDown() async throws {
        handler.pendingDeepLink = nil
        handler = nil
        try await super.tearDown()
    }

    // MARK: - Custom Scheme: HUD

    func testParseHUDWithFullPath() {
        let url = URL(string: "torchci://hud/pytorch/pytorch/main")!
        let link = handler.parse(url: url)
        XCTAssertEqual(link, .hud(repoOwner: "pytorch", repoName: "pytorch", branch: "main"))
    }

    func testParseHUDBareHost() {
        let url = URL(string: "torchci://hud")!
        let link = handler.parse(url: url)
        XCTAssertEqual(link, .hud(repoOwner: "pytorch", repoName: "pytorch", branch: "main"))
    }

    func testParseHUDWithOwnerAndName() {
        let url = URL(string: "torchci://hud/meta-llama/llama")!
        let link = handler.parse(url: url)
        XCTAssertEqual(link, .hud(repoOwner: "meta-llama", repoName: "llama", branch: "main"))
    }

    func testParseHUDWithSlashBranch() {
        let url = URL(string: "torchci://hud/pytorch/pytorch/viable/strict")!
        let link = handler.parse(url: url)
        XCTAssertEqual(link, .hud(repoOwner: "pytorch", repoName: "pytorch", branch: "viable/strict"))
    }

    // MARK: - Custom Scheme: Commit

    func testParseCommitShortForm() {
        let url = URL(string: "torchci://commit/abc123def456")!
        let link = handler.parse(url: url)
        XCTAssertEqual(link, .commit(repoOwner: "pytorch", repoName: "pytorch", sha: "abc123def456"))
    }

    func testParseCommitFullForm() {
        let url = URL(string: "torchci://commit/meta-llama/llama/abc123def456")!
        let link = handler.parse(url: url)
        XCTAssertEqual(link, .commit(repoOwner: "meta-llama", repoName: "llama", sha: "abc123def456"))
    }

    func testParseCommitNoSHA() {
        let url = URL(string: "torchci://commit")!
        let link = handler.parse(url: url)
        XCTAssertNil(link)
    }

    // MARK: - Custom Scheme: PR

    func testParsePRShortForm() {
        let url = URL(string: "torchci://pr/12345")!
        let link = handler.parse(url: url)
        XCTAssertEqual(link, .pr(repoOwner: "pytorch", repoName: "pytorch", number: 12345))
    }

    func testParsePRFullForm() {
        let url = URL(string: "torchci://pr/pytorch/vision/5678")!
        let link = handler.parse(url: url)
        XCTAssertEqual(link, .pr(repoOwner: "pytorch", repoName: "vision", number: 5678))
    }

    func testParsePRInvalidNumber() {
        let url = URL(string: "torchci://pr/notanumber")!
        let link = handler.parse(url: url)
        XCTAssertNil(link)
    }

    // MARK: - Custom Scheme: Tab Links

    func testParseMetrics() {
        let url = URL(string: "torchci://metrics")!
        XCTAssertEqual(handler.parse(url: url), .metrics)
    }

    func testParseTests() {
        let url = URL(string: "torchci://tests")!
        XCTAssertEqual(handler.parse(url: url), .tests)
    }

    func testParseBenchmarks() {
        let url = URL(string: "torchci://benchmarks")!
        XCTAssertEqual(handler.parse(url: url), .benchmarks)
    }

    func testParseDevInfra() {
        let url = URL(string: "torchci://devinfra")!
        XCTAssertEqual(handler.parse(url: url), .devInfra)
    }

    func testParseDevInfraCamelCase() {
        let url = URL(string: "torchci://devInfra")!
        XCTAssertEqual(handler.parse(url: url), .devInfra)
    }

    func testParseTorchAgent() {
        let url = URL(string: "torchci://torchagent")!
        XCTAssertEqual(handler.parse(url: url), .torchAgent)
    }

    func testParseTorchAgentCamelCase() {
        let url = URL(string: "torchci://torchAgent")!
        XCTAssertEqual(handler.parse(url: url), .torchAgent)
    }

    func testParseSettings() {
        let url = URL(string: "torchci://settings")!
        XCTAssertEqual(handler.parse(url: url), .settings)
    }

    // MARK: - Custom Scheme: Flambeau

    func testParseFlambeau() {
        let url = URL(string: "torchci://flambeau/abc-123-def")!
        let link = handler.parse(url: url)
        XCTAssertEqual(link, .flambeau(uuid: "abc-123-def"))
    }

    func testParseFlambeauNoUUID() {
        let url = URL(string: "torchci://flambeau")!
        let link = handler.parse(url: url)
        XCTAssertNil(link)
    }

    // MARK: - Custom Scheme: OAuth Callback

    func testParseOAuthCallback() {
        let url = URL(string: "torchci://callback?code=abc123&state=xyz")!
        let link = handler.parse(url: url)
        XCTAssertEqual(link, .oauthCallback(url: url))
    }

    // MARK: - Custom Scheme: Unknown

    func testParseUnknownHost() {
        let url = URL(string: "torchci://unknownpage")!
        let link = handler.parse(url: url)
        XCTAssertNil(link)
    }

    func testParseNonTorchCIScheme() {
        let url = URL(string: "myapp://something")!
        let link = handler.parse(url: url)
        XCTAssertNil(link)
    }

    // MARK: - Universal Links: Commit

    func testParseUniversalCommit() {
        let url = URL(string: "https://hud.pytorch.org/pytorch/pytorch/commit/abc123")!
        let link = handler.parse(url: url)
        XCTAssertEqual(link, .commit(repoOwner: "pytorch", repoName: "pytorch", sha: "abc123"))
    }

    // MARK: - Universal Links: PR

    func testParseUniversalPR() {
        let url = URL(string: "https://hud.pytorch.org/pytorch/pytorch/pull/99999")!
        let link = handler.parse(url: url)
        XCTAssertEqual(link, .pr(repoOwner: "pytorch", repoName: "pytorch", number: 99999))
    }

    func testParseUniversalPRInvalidNumber() {
        let url = URL(string: "https://hud.pytorch.org/pytorch/pytorch/pull/notanum")!
        let link = handler.parse(url: url)
        XCTAssertNil(link)
    }

    // MARK: - Universal Links: Flambeau

    func testParseUniversalFlambeauShared() {
        let url = URL(string: "https://hud.pytorch.org/flambeau/s/my-uuid-123")!
        let link = handler.parse(url: url)
        XCTAssertEqual(link, .flambeau(uuid: "my-uuid-123"))
    }

    func testParseUniversalTorchAgentShared() {
        let url = URL(string: "https://hud.pytorch.org/torchagent/shared/some-uuid")!
        let link = handler.parse(url: url)
        XCTAssertEqual(link, .flambeau(uuid: "some-uuid"))
    }

    // MARK: - Universal Links: HUD

    func testParseUniversalHUD() {
        let url = URL(string: "https://hud.pytorch.org/hud/pytorch/pytorch/main")!
        let link = handler.parse(url: url)
        XCTAssertEqual(link, .hud(repoOwner: "pytorch", repoName: "pytorch", branch: "main"))
    }

    // MARK: - Universal Links: Non-PyTorch Host

    func testParseUniversalWrongHost() {
        let url = URL(string: "https://example.com/pytorch/pytorch/commit/abc123")!
        let link = handler.parse(url: url)
        XCTAssertNil(link)
    }

    // MARK: - Notification Payload: HUD Failure

    func testNotificationHUDFailure() {
        let payload: [AnyHashable: Any] = [
            "type": "hud_failure",
            "branch": "main",
        ]
        let result = handler.handle(notificationUserInfo: payload)
        XCTAssertTrue(result)
        XCTAssertEqual(handler.pendingDeepLink, .hud(repoOwner: "pytorch", repoName: "pytorch", branch: "main"))
    }

    func testNotificationHUDFailureCustomRepo() {
        let payload: [AnyHashable: Any] = [
            "type": "hud_failure",
            "repoOwner": "meta-llama",
            "repoName": "llama",
            "branch": "release",
        ]
        let result = handler.handle(notificationUserInfo: payload)
        XCTAssertTrue(result)
        XCTAssertEqual(handler.pendingDeepLink, .hud(repoOwner: "meta-llama", repoName: "llama", branch: "release"))
    }

    // MARK: - Notification Payload: Commit

    func testNotificationCommit() {
        let payload: [AnyHashable: Any] = [
            "type": "commit",
            "sha": "abc123",
        ]
        let result = handler.handle(notificationUserInfo: payload)
        XCTAssertTrue(result)
        XCTAssertEqual(handler.pendingDeepLink, .commit(repoOwner: "pytorch", repoName: "pytorch", sha: "abc123"))
    }

    // MARK: - Notification Payload: PR

    func testNotificationPRInt() {
        let payload: [AnyHashable: Any] = [
            "type": "pr",
            "prNumber": 42,
        ]
        let result = handler.handle(notificationUserInfo: payload)
        XCTAssertTrue(result)
        XCTAssertEqual(handler.pendingDeepLink, .pr(repoOwner: "pytorch", repoName: "pytorch", number: 42))
    }

    func testNotificationPRString() {
        let payload: [AnyHashable: Any] = [
            "type": "pr",
            "prNumber": "99",
        ]
        let result = handler.handle(notificationUserInfo: payload)
        XCTAssertTrue(result)
        XCTAssertEqual(handler.pendingDeepLink, .pr(repoOwner: "pytorch", repoName: "pytorch", number: 99))
    }

    // MARK: - Notification Payload: Flambeau

    func testNotificationFlambeau() {
        let payload: [AnyHashable: Any] = [
            "type": "flambeau",
            "uuid": "session-uuid",
        ]
        let result = handler.handle(notificationUserInfo: payload)
        XCTAssertTrue(result)
        XCTAssertEqual(handler.pendingDeepLink, .flambeau(uuid: "session-uuid"))
    }

    // MARK: - Notification Payload: URL Fallback

    func testNotificationURLFallback() {
        let payload: [AnyHashable: Any] = [
            "url": "torchci://metrics",
        ]
        let result = handler.handle(notificationUserInfo: payload)
        XCTAssertTrue(result)
        XCTAssertEqual(handler.pendingDeepLink, .metrics)
    }

    // MARK: - Notification Payload: Branch Fallback

    func testNotificationBranchFallback() {
        let payload: [AnyHashable: Any] = [
            "branch": "nightly",
        ]
        let result = handler.handle(notificationUserInfo: payload)
        XCTAssertTrue(result)
        XCTAssertEqual(handler.pendingDeepLink, .hud(repoOwner: "pytorch", repoName: "pytorch", branch: "nightly"))
    }

    // MARK: - Notification Payload: Empty

    func testNotificationEmptyPayload() {
        let payload: [AnyHashable: Any] = [:]
        let result = handler.handle(notificationUserInfo: payload)
        XCTAssertFalse(result)
        XCTAssertNil(handler.pendingDeepLink)
    }

    // MARK: - DeepLink Target Tab

    func testTargetTabHUD() {
        XCTAssertEqual(DeepLink.hud(repoOwner: "a", repoName: "b", branch: "c").targetTab, .hud)
    }

    func testTargetTabCommit() {
        XCTAssertEqual(DeepLink.commit(repoOwner: "a", repoName: "b", sha: "c").targetTab, .hud)
    }

    func testTargetTabPR() {
        XCTAssertEqual(DeepLink.pr(repoOwner: "a", repoName: "b", number: 1).targetTab, .hud)
    }

    func testTargetTabMetrics() {
        XCTAssertEqual(DeepLink.metrics.targetTab, .metrics)
    }

    func testTargetTabTests() {
        XCTAssertEqual(DeepLink.tests.targetTab, .tests)
    }

    func testTargetTabBenchmarks() {
        XCTAssertEqual(DeepLink.benchmarks.targetTab, .benchmarks)
    }

    func testTargetTabDevInfra() {
        XCTAssertEqual(DeepLink.devInfra.targetTab, .devInfra)
    }

    func testTargetTabTorchAgent() {
        XCTAssertEqual(DeepLink.torchAgent.targetTab, .torchAgent)
    }

    func testTargetTabSettings() {
        XCTAssertEqual(DeepLink.settings.targetTab, .settings)
    }

    func testTargetTabFlambeau() {
        XCTAssertEqual(DeepLink.flambeau(uuid: "x").targetTab, .torchAgent)
    }

    // MARK: - Handle Method

    func testHandlePublishesPendingLink() {
        let url = URL(string: "torchci://metrics")!
        let result = handler.handle(url: url)
        XCTAssertTrue(result)
        XCTAssertEqual(handler.pendingDeepLink, .metrics)
    }

    func testHandleReturnsFalseForUnknown() {
        let url = URL(string: "torchci://unknownpage")!
        let result = handler.handle(url: url)
        XCTAssertFalse(result)
        XCTAssertNil(handler.pendingDeepLink)
    }

    // MARK: - DeepLink Equatable

    func testDeepLinkEquality() {
        let a = DeepLink.hud(repoOwner: "pytorch", repoName: "pytorch", branch: "main")
        let b = DeepLink.hud(repoOwner: "pytorch", repoName: "pytorch", branch: "main")
        XCTAssertEqual(a, b)
    }

    func testDeepLinkInequality() {
        let a = DeepLink.hud(repoOwner: "pytorch", repoName: "pytorch", branch: "main")
        let b = DeepLink.hud(repoOwner: "pytorch", repoName: "pytorch", branch: "nightly")
        XCTAssertNotEqual(a, b)
    }

    func testDeepLinkDifferentCases() {
        let a = DeepLink.metrics
        let b = DeepLink.tests
        XCTAssertNotEqual(a, b)
    }

    // MARK: - Debug Description

    func testDebugDescriptionHUD() {
        let link = DeepLink.hud(repoOwner: "pytorch", repoName: "pytorch", branch: "main")
        XCTAssertEqual(link.debugDescription, "hud(pytorch/pytorch/main)")
    }

    func testDebugDescriptionCommit() {
        let link = DeepLink.commit(repoOwner: "pytorch", repoName: "pytorch", sha: "abc123def456")
        XCTAssertEqual(link.debugDescription, "commit(pytorch/pytorch/abc123d)")
    }

    func testDebugDescriptionPR() {
        let link = DeepLink.pr(repoOwner: "pytorch", repoName: "pytorch", number: 42)
        XCTAssertEqual(link.debugDescription, "pr(pytorch/pytorch/#42)")
    }

    func testDebugDescriptionSimpleTabs() {
        XCTAssertEqual(DeepLink.metrics.debugDescription, "metrics")
        XCTAssertEqual(DeepLink.tests.debugDescription, "tests")
        XCTAssertEqual(DeepLink.benchmarks.debugDescription, "benchmarks")
        XCTAssertEqual(DeepLink.devInfra.debugDescription, "devInfra")
        XCTAssertEqual(DeepLink.torchAgent.debugDescription, "torchAgent")
        XCTAssertEqual(DeepLink.settings.debugDescription, "settings")
    }
}
