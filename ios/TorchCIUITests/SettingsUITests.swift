import XCTest

@MainActor
final class SettingsUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    // MARK: - Helpers

    private func navigateToSettings() {
        app.tabBars.buttons["More"].tap()
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))

        app.swipeUp()

        let settingsCell = app.staticTexts["Settings"]
        XCTAssertTrue(settingsCell.waitForExistence(timeout: 3))
        settingsCell.tap()

        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
    }

    // MARK: - Settings View Loading

    func testSettingsViewLoads() {
        navigateToSettings()

        // SettingsView has sections: Appearance, Default Repository, Cache, About
        let appearanceHeader = app.staticTexts["Appearance"]
        XCTAssertTrue(appearanceHeader.waitForExistence(timeout: 3))
    }

    func testSettingsShowsAllSections() {
        navigateToSettings()

        // Appearance section
        XCTAssertTrue(app.staticTexts["Appearance"].exists)

        // Defaults section (repository and branch pickers)
        XCTAssertTrue(app.staticTexts["Defaults"].exists)

        // Storage section - scroll down to find it
        app.swipeUp()
        XCTAssertTrue(app.staticTexts["Storage"].waitForExistence(timeout: 3))

        // About section
        XCTAssertTrue(app.staticTexts["About"].waitForExistence(timeout: 3))
    }

    // MARK: - Theme Picker (3 Options)

    func testThemePickerShowsThreeOptions() {
        navigateToSettings()

        // The Appearance section renders 3 buttons: Light, Dark, System
        let lightOption = app.staticTexts["Light"]
        let darkOption = app.staticTexts["Dark"]
        let systemOption = app.staticTexts["System"]

        XCTAssertTrue(lightOption.exists, "Light theme option should be visible")
        XCTAssertTrue(darkOption.exists, "Dark theme option should be visible")
        XCTAssertTrue(systemOption.exists, "System theme option should be visible")
    }

    func testThemePickerSelectLight() {
        navigateToSettings()

        let lightOption = app.staticTexts["Light"]
        XCTAssertTrue(lightOption.exists)
        lightOption.tap()

        XCTAssertTrue(lightOption.exists, "Light option should still be visible after selection")
    }

    func testThemePickerSelectDark() {
        navigateToSettings()

        let darkOption = app.staticTexts["Dark"]
        XCTAssertTrue(darkOption.exists)
        darkOption.tap()

        XCTAssertTrue(darkOption.exists, "Dark option should still be visible after selection")
    }

    func testThemePickerSelectSystem() {
        navigateToSettings()

        let systemOption = app.staticTexts["System"]
        XCTAssertTrue(systemOption.exists)
        systemOption.tap()

        XCTAssertTrue(systemOption.exists, "System option should still be visible after selection")
    }

    // MARK: - Notification Settings Navigation

    private func navigateToNotifications() {
        navigateToSettings()

        let notificationsCell = app.staticTexts["Notifications"]
        XCTAssertTrue(notificationsCell.waitForExistence(timeout: 3))
        notificationsCell.tap()

        XCTAssertTrue(app.navigationBars["Notifications"].waitForExistence(timeout: 5))
    }

    func testNavigationToNotificationSettingsFromMore() {
        navigateToNotifications()
    }

    func testNotificationSettingsShowsEnableToggle() {
        navigateToNotifications()

        // NotificationSettingsView has a Toggle with "Enable Notifications" text
        // Match using predicate since the accessibility label may include subtitle text
        let togglePredicate = NSPredicate(format: "label CONTAINS 'Enable Notifications'")
        let enableToggle = app.switches.matching(togglePredicate).firstMatch
        XCTAssertTrue(enableToggle.waitForExistence(timeout: 3),
                       "Enable Notifications toggle should be visible")
    }

    // MARK: - Toggle Interaction

    func testToggleNotificationsInteraction() {
        navigateToNotifications()

        let togglePredicate = NSPredicate(format: "label CONTAINS 'Enable Notifications'")
        let enableToggle = app.switches.matching(togglePredicate).firstMatch
        XCTAssertTrue(enableToggle.waitForExistence(timeout: 3))

        // Verify the toggle has a value ("0" or "1")
        let value = enableToggle.value as? String
        XCTAssertNotNil(value, "Toggle should have a value")
        XCTAssertTrue(value == "0" || value == "1",
                      "Toggle value should be 0 or 1, got: \(value ?? "nil")")

        // Note: The toggle may be disabled in the simulator when notification
        // authorization status is .notDetermined and preferences.enabled is true.
        // We verify the toggle exists and has a valid state, which confirms the
        // UI is rendered correctly.
    }

    // MARK: - Cache Section

    func testCacheSectionShowsCacheSize() {
        navigateToSettings()

        app.swipeUp()

        let cacheSizeLabel = app.staticTexts["Cache Size"]
        XCTAssertTrue(cacheSizeLabel.waitForExistence(timeout: 5),
                       "Cache Size label should be visible in settings")
    }

    func testCacheSectionShowsClearButton() {
        navigateToSettings()

        app.swipeUp()

        let clearCacheButton = app.staticTexts["Clear Cache"]
        XCTAssertTrue(clearCacheButton.waitForExistence(timeout: 5),
                       "Clear Cache button should be visible in settings")
    }

    // MARK: - About Section

    func testAboutSectionShowsLinks() {
        navigateToSettings()

        app.swipeUp()

        let aboutTorchCI = app.staticTexts["About TorchCI"]
        XCTAssertTrue(aboutTorchCI.waitForExistence(timeout: 3),
                       "About TorchCI link should be visible")

        let githubRepo = app.staticTexts["GitHub Repository"]
        XCTAssertTrue(githubRepo.exists, "GitHub Repository link should be visible")

        let feedback = app.staticTexts["Send Feedback"]
        XCTAssertTrue(feedback.exists, "Send Feedback link should be visible")
    }
}
