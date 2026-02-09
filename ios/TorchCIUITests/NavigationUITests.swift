import XCTest

@MainActor
final class NavigationUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    // MARK: - Tab Bar

    func testAllTabsAreVisible() {
        XCTAssertTrue(app.tabBars.buttons["HUD"].exists)
        XCTAssertTrue(app.tabBars.buttons["Metrics"].exists)
        XCTAssertTrue(app.tabBars.buttons["Tests"].exists)
        XCTAssertTrue(app.tabBars.buttons["Benchmarks"].exists)
        XCTAssertTrue(app.tabBars.buttons["More"].exists)
    }

    func testTabSwitchingToMetrics() {
        app.tabBars.buttons["Metrics"].tap()
        // MetricsDashboardView sets .navigationTitle("Metrics")
        XCTAssertTrue(app.navigationBars["Metrics"].waitForExistence(timeout: 5))
    }

    func testTabSwitchingToTests() {
        app.tabBars.buttons["Tests"].tap()
        // TestSearchView sets .navigationTitle("Test Search")
        XCTAssertTrue(app.navigationBars["Test Search"].waitForExistence(timeout: 5))
    }

    func testTabSwitchingToBenchmarks() {
        app.tabBars.buttons["Benchmarks"].tap()
        // BenchmarkListView has a navigation title visible on the Benchmarks tab
        let benchmarksNavBar = app.navigationBars.element(boundBy: 0)
        XCTAssertTrue(benchmarksNavBar.waitForExistence(timeout: 5))
    }

    func testTabSwitchingToMore() {
        app.tabBars.buttons["More"].tap()
        // MoreView sets .navigationTitle("More")
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))
    }

    func testTabSwitchingBackToHUD() {
        app.tabBars.buttons["More"].tap()
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))
        app.tabBars.buttons["HUD"].tap()
        XCTAssertTrue(app.navigationBars["CI HUD"].waitForExistence(timeout: 5))
    }

    // MARK: - More Menu Items

    func testMoreMenuDevInfraItemsExist() {
        app.tabBars.buttons["More"].tap()
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))

        XCTAssertTrue(app.staticTexts["Failure Analysis"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Failed Jobs Classifier"].exists)
        XCTAssertTrue(app.staticTexts["Runners"].exists)
        XCTAssertTrue(app.staticTexts["Utilization"].exists)
        XCTAssertTrue(app.staticTexts["Nightlies"].exists)
        XCTAssertTrue(app.staticTexts["Job Cancellations"].exists)
    }

    func testMoreMenuAIItemsExist() {
        app.tabBars.buttons["More"].tap()
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))

        XCTAssertTrue(app.staticTexts["PyTorch CI Agent"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Claude Billing"].exists)
    }

    func testMoreMenuAccountAndSettingsItemsExist() {
        app.tabBars.buttons["More"].tap()
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))

        // Scroll down to make settings visible since the list can be long
        app.swipeUp()

        XCTAssertTrue(app.staticTexts["Settings"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Notifications"].exists)
    }

    // MARK: - Navigation to Settings

    func testNavigationToSettings() {
        app.tabBars.buttons["More"].tap()
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))

        app.swipeUp()

        let settingsCell = app.staticTexts["Settings"]
        XCTAssertTrue(settingsCell.waitForExistence(timeout: 3))
        settingsCell.tap()

        // SettingsView sets .navigationTitle("Settings")
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
    }

    // MARK: - Navigation to Notifications

    func testNavigationToNotifications() {
        app.tabBars.buttons["More"].tap()
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))

        app.swipeUp()

        let notificationsCell = app.staticTexts["Notifications"]
        XCTAssertTrue(notificationsCell.waitForExistence(timeout: 3))
        notificationsCell.tap()

        // NotificationSettingsView sets .navigationTitle("Notifications")
        XCTAssertTrue(app.navigationBars["Notifications"].waitForExistence(timeout: 5))
    }

    // MARK: - Back Navigation

    func testBackNavigationFromSettings() {
        app.tabBars.buttons["More"].tap()
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))

        app.swipeUp()

        app.staticTexts["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))

        // Tap the back button to return to More
        app.navigationBars["Settings"].buttons["More"].tap()
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))
    }

    func testBackNavigationFromNotifications() {
        app.tabBars.buttons["More"].tap()
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))

        app.swipeUp()

        app.staticTexts["Notifications"].tap()
        XCTAssertTrue(app.navigationBars["Notifications"].waitForExistence(timeout: 5))

        // Tap the back button to return to More
        app.navigationBars["Notifications"].buttons["More"].tap()
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))
    }
}
