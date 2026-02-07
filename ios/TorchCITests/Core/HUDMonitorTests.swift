import XCTest
@testable import TorchCI

final class HUDMonitorTests: XCTestCase {

    private var mockClient: MockAPIClient!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// Builds a minimal HUDResponse JSON with the given rows.
    /// Each row is an array of (jobName, conclusion, unstable) tuples.
    private func makeHUDResponseJSON(
        rows: [[(name: String, conclusion: String, unstable: Bool)]]
    ) -> String {
        var shaGridEntries: [String] = []

        for (index, jobs) in rows.enumerated() {
            let jobsJSON = jobs.map { job in
                """
                {
                    "id": \(index * 100 + shaGridEntries.count),
                    "name": "\(job.name)",
                    "conclusion": "\(job.conclusion)",
                    "unstable": \(job.unstable)
                }
                """
            }.joined(separator: ",")

            let entry = """
            {
                "sha": "sha\(index)",
                "commitTitle": "commit \(index)",
                "jobs": [\(jobsJSON)]
            }
            """
            shaGridEntries.append(entry)
        }

        let grid = shaGridEntries.joined(separator: ",")
        return """
        {
            "shaGrid": [\(grid)],
            "jobNames": ["build", "test"]
        }
        """
    }

    private func defaultPreferences(
        enabled: Bool = true,
        threshold: Int = 1
    ) -> NotificationPreferences {
        NotificationPreferences(
            enabled: enabled,
            failureThreshold: threshold,
            monitoredBranches: ["main"],
            monitoredRepos: [RepoConfig(owner: "pytorch", name: "pytorch")]
        )
    }

    // MARK: - Zero Consecutive Failures

    func testZeroConsecutiveFailuresReturnsZero() async {
        // All rows are success
        let json = makeHUDResponseJSON(rows: [
            [(name: "build", conclusion: "success", unstable: false)],
            [(name: "build", conclusion: "success", unstable: false)],
        ])

        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1,
            perPage: 20
        )
        mockClient.setResponse(json, for: endpoint.path)

        let monitor = HUDMonitor(apiClient: mockClient)
        let prefs = defaultPreferences(threshold: 1)

        var alertCalled = false
        await monitor.checkForFailures(preferences: prefs) { _, _, _ in
            alertCalled = true
        }

        XCTAssertFalse(alertCalled, "No alert should fire when there are 0 consecutive failures")
    }

    // MARK: - Three Failures Then Success

    func testThreeFailuresThenSuccessReturnsThree() async {
        // 3 failures followed by 1 success
        let json = makeHUDResponseJSON(rows: [
            [(name: "build", conclusion: "failure", unstable: false)],
            [(name: "test", conclusion: "failure", unstable: false)],
            [(name: "lint", conclusion: "failure", unstable: false)],
            [(name: "build", conclusion: "success", unstable: false)],
        ])

        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1,
            perPage: 20
        )
        mockClient.setResponse(json, for: endpoint.path)

        let monitor = HUDMonitor(apiClient: mockClient)
        let prefs = defaultPreferences(threshold: 2)

        var capturedCount: Int?
        var capturedPatterns: [String]?
        await monitor.checkForFailures(preferences: prefs) { _, count, patterns in
            capturedCount = count
            capturedPatterns = patterns
        }

        XCTAssertEqual(capturedCount, 3)
        XCTAssertNotNil(capturedPatterns)
        XCTAssertFalse(capturedPatterns!.isEmpty)
    }

    // MARK: - All Failures Returns Full Count

    func testAllFailuresReturnsFullCount() async {
        // All 5 rows are failures
        let json = makeHUDResponseJSON(rows: [
            [(name: "build", conclusion: "failure", unstable: false)],
            [(name: "build", conclusion: "failure", unstable: false)],
            [(name: "test", conclusion: "failure", unstable: false)],
            [(name: "test", conclusion: "failure", unstable: false)],
            [(name: "lint", conclusion: "failure", unstable: false)],
        ])

        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1,
            perPage: 20
        )
        mockClient.setResponse(json, for: endpoint.path)

        let monitor = HUDMonitor(apiClient: mockClient)
        let prefs = defaultPreferences(threshold: 1)

        var capturedCount: Int?
        await monitor.checkForFailures(preferences: prefs) { _, count, _ in
            capturedCount = count
        }

        XCTAssertEqual(capturedCount, 5)
    }

    // MARK: - Empty Data Returns Zero

    func testEmptyDataReturnsZero() async {
        let json = #"{"shaGrid":[],"jobNames":[]}"#

        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1,
            perPage: 20
        )
        mockClient.setResponse(json, for: endpoint.path)

        let monitor = HUDMonitor(apiClient: mockClient)
        let prefs = defaultPreferences(threshold: 1)

        var alertCalled = false
        await monitor.checkForFailures(preferences: prefs) { _, _, _ in
            alertCalled = true
        }

        XCTAssertFalse(alertCalled, "No alert should fire for empty data")
    }

    // MARK: - Disabled Preferences Skips Check

    func testDisabledPreferencesDoesNotFetch() async {
        let monitor = HUDMonitor(apiClient: mockClient)
        let prefs = NotificationPreferences(
            enabled: false,
            failureThreshold: 1,
            monitoredBranches: ["main"],
            monitoredRepos: [RepoConfig(owner: "pytorch", name: "pytorch")]
        )

        var alertCalled = false
        await monitor.checkForFailures(preferences: prefs) { _, _, _ in
            alertCalled = true
        }

        XCTAssertFalse(alertCalled)
        XCTAssertEqual(mockClient.callCount, 0, "API should not be called when notifications are disabled")
    }

    // MARK: - Cancellation Stops Processing

    func testCancellationStopsProcessing() async {
        // Set up a response with failures to ensure alert would normally fire
        let json = makeHUDResponseJSON(rows: [
            [(name: "build", conclusion: "failure", unstable: false)],
            [(name: "build", conclusion: "failure", unstable: false)],
            [(name: "build", conclusion: "failure", unstable: false)],
        ])

        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1,
            perPage: 20
        )
        mockClient.setResponse(json, for: endpoint.path)

        // Use a small delay so we can cancel before completion
        mockClient.artificialDelayNanoseconds = 500_000_000 // 500ms

        let monitor = HUDMonitor(apiClient: mockClient)
        let prefs = defaultPreferences(threshold: 1)

        var alertCalled = false

        // Cancel immediately
        await monitor.cancel()

        await monitor.checkForFailures(preferences: prefs) { _, _, _ in
            alertCalled = true
        }

        XCTAssertFalse(alertCalled, "Alert should not fire after cancellation")
    }

    // MARK: - Unstable Failures Are Excluded

    func testUnstableFailuresAreNotCountedAsConsecutive() async {
        // Row with only unstable failure, followed by success
        let json = makeHUDResponseJSON(rows: [
            [(name: "flaky-test", conclusion: "failure", unstable: true)],
            [(name: "build", conclusion: "success", unstable: false)],
        ])

        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1,
            perPage: 20
        )
        mockClient.setResponse(json, for: endpoint.path)

        let monitor = HUDMonitor(apiClient: mockClient)
        let prefs = defaultPreferences(threshold: 1)

        var alertCalled = false
        await monitor.checkForFailures(preferences: prefs) { _, _, _ in
            alertCalled = true
        }

        XCTAssertFalse(alertCalled, "Unstable-only failures should not trigger an alert")
    }

    // MARK: - API Error Is Handled Gracefully

    func testAPIErrorDoesNotCrash() async {
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1,
            perPage: 20
        )
        mockClient.setError(APIError.serverError(500), for: endpoint.path)

        let monitor = HUDMonitor(apiClient: mockClient)
        let prefs = defaultPreferences(threshold: 1)

        var alertCalled = false
        await monitor.checkForFailures(preferences: prefs) { _, _, _ in
            alertCalled = true
        }

        XCTAssertFalse(alertCalled, "Errors should be silently handled")
    }
}
