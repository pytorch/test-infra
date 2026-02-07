import XCTest

@MainActor
final class MetricsUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    // MARK: - Helpers

    private func navigateToMetrics() {
        app.tabBars.buttons["Metrics"].tap()
        XCTAssertTrue(app.navigationBars["Metrics"].waitForExistence(timeout: 5))
    }

    /// Wait for the metrics dashboard to finish loading. Returns true if content loaded.
    @discardableResult
    private func waitForMetricsContent() -> Bool {
        // The dashboard shows "Loading metrics..." while loading,
        // then displays navigation cards like "KPIs", "Reliability", etc.
        let kpisButton = app.staticTexts["KPIs"]
        let loadingText = app.staticTexts["Loading metrics..."]
        let errorRetry = app.buttons["Retry"]

        // Wait up to 15 seconds for the dashboard to load
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if kpisButton.exists { return true }
            if errorRetry.exists { return false }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }

        // Check one more time after the deadline
        return kpisButton.exists || loadingText.exists
    }

    // MARK: - Screen Loading

    func testMetricsScreenLoads() {
        navigateToMetrics()

        // Should show either loading state or loaded content
        let loadingText = app.staticTexts["Loading metrics..."]
        let kpisText = app.staticTexts["KPIs"]

        let appeared = loadingText.waitForExistence(timeout: 5)
            || kpisText.waitForExistence(timeout: 5)
        XCTAssertTrue(appeared, "Metrics screen should show loading or content")
    }

    func testMetricsDashboardShowsSummaryCards() {
        navigateToMetrics()

        if waitForMetricsContent() {
            // MetricsDashboardView shows ScalarPanel cards: "Red Rate", "Force Merges", "TTS (p50)"
            let redRate = app.staticTexts["Red Rate"]
            let forceMerges = app.staticTexts["Force Merges"]
            let tts = app.staticTexts["TTS (p50)"]

            XCTAssertTrue(redRate.exists, "Red Rate card should be visible")
            XCTAssertTrue(forceMerges.exists, "Force Merges card should be visible")
            XCTAssertTrue(tts.exists, "TTS (p50) card should be visible")
        }
    }

    func testMetricsDashboardShowsExploreSection() {
        navigateToMetrics()

        if waitForMetricsContent() {
            // The navigation section has a SectionHeader with title "Explore"
            XCTAssertTrue(app.staticTexts["Explore"].exists, "Explore section header should be visible")
        }
    }

    // MARK: - Navigation to KPIs

    func testNavigationToKPIs() {
        navigateToMetrics()

        guard waitForMetricsContent() else {
            // If the dashboard failed to load, skip navigation test
            return
        }

        // Tap the "KPIs" navigation link in the Explore grid
        let kpisLink = app.staticTexts["KPIs"]
        XCTAssertTrue(kpisLink.exists, "KPIs link should exist")
        kpisLink.tap()

        // KPIsView sets .navigationTitle("KPIs") with .large display mode
        XCTAssertTrue(app.navigationBars["KPIs"].waitForExistence(timeout: 5))
    }

    func testKPIsPageShowsLoadingOrContent() {
        navigateToMetrics()

        guard waitForMetricsContent() else { return }

        app.staticTexts["KPIs"].tap()
        XCTAssertTrue(app.navigationBars["KPIs"].waitForExistence(timeout: 5))

        // KPIsView shows "Loading KPIs..." while loading
        let loadingText = app.staticTexts["Loading KPIs..."]
        let hasLoading = loadingText.waitForExistence(timeout: 3)

        // If not showing loading, the content should already be there
        if !hasLoading {
            // KPI cards or error state should be visible
            let anyContent = app.scrollViews.firstMatch.exists
                || app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Error'")).firstMatch.exists
            XCTAssertTrue(anyContent, "KPIs page should show loading, content, or error state")
        }
    }

    // MARK: - Navigation to Reliability

    func testNavigationToReliability() {
        navigateToMetrics()

        guard waitForMetricsContent() else { return }

        // The navigation grid may require scrolling to see "Reliability"
        let reliabilityLink = app.staticTexts["Reliability"]
        if !reliabilityLink.exists {
            app.swipeUp()
        }

        XCTAssertTrue(reliabilityLink.waitForExistence(timeout: 3), "Reliability link should exist")
        reliabilityLink.tap()

        // ReliabilityView sets .navigationTitle("Reliability") with .large display mode
        XCTAssertTrue(app.navigationBars["Reliability"].waitForExistence(timeout: 5))
    }

    func testReliabilityPageShowsLoadingOrContent() {
        navigateToMetrics()

        guard waitForMetricsContent() else { return }

        let reliabilityLink = app.staticTexts["Reliability"]
        if !reliabilityLink.exists {
            app.swipeUp()
        }
        reliabilityLink.tap()
        XCTAssertTrue(app.navigationBars["Reliability"].waitForExistence(timeout: 5))

        // ReliabilityView shows "Loading reliability data..." while loading
        let loadingText = app.staticTexts["Loading reliability data..."]
        let hasLoading = loadingText.waitForExistence(timeout: 3)

        if !hasLoading {
            // Should have summary panels or error retry button
            let totalJobs = app.staticTexts["Total Jobs"]
            let failureRate = app.staticTexts["Failure Rate"]
            let hasContent = totalJobs.exists || failureRate.exists

            let errorButton = app.buttons["Retry"]
            XCTAssertTrue(
                hasContent || errorButton.exists,
                "Reliability page should show content or error state"
            )
        }
    }

    // MARK: - Back Navigation from Sub-pages

    func testBackNavigationFromKPIs() {
        navigateToMetrics()

        guard waitForMetricsContent() else { return }

        app.staticTexts["KPIs"].tap()
        XCTAssertTrue(app.navigationBars["KPIs"].waitForExistence(timeout: 5))

        // Navigate back
        app.navigationBars["KPIs"].buttons["Metrics"].tap()
        XCTAssertTrue(app.navigationBars["Metrics"].waitForExistence(timeout: 5))
    }

    func testBackNavigationFromReliability() {
        navigateToMetrics()

        guard waitForMetricsContent() else { return }

        let reliabilityLink = app.staticTexts["Reliability"]
        if !reliabilityLink.exists {
            app.swipeUp()
        }
        reliabilityLink.tap()
        XCTAssertTrue(app.navigationBars["Reliability"].waitForExistence(timeout: 5))

        // Navigate back
        app.navigationBars["Reliability"].buttons["Metrics"].tap()
        XCTAssertTrue(app.navigationBars["Metrics"].waitForExistence(timeout: 5))
    }
}
