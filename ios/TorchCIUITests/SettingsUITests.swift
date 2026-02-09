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

        // Default Repository section
        XCTAssertTrue(app.staticTexts["Default Repository"].exists)

        // Cache section - scroll down to find it
        app.swipeUp()
        XCTAssertTrue(app.staticTexts["Cache"].waitForExistence(timeout: 3))

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

    func testNavigationToNotificationSettingsFromMore() {
        app.tabBars.buttons["More"].tap()
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))

        app.swipeUp()

        let notificationsCell = app.staticTexts["Notifications"]
        XCTAssertTrue(notificationsCell.waitForExistence(timeout: 3))
        notificationsCell.tap()

        XCTAssertTrue(app.navigationBars["Notifications"].waitForExistence(timeout: 5))
    }

    func testNotificationSettingsShowsEnableToggle() {
        app.tabBars.buttons["More"].tap()
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))

        app.swipeUp()

        app.staticTexts["Notifications"].tap()
        XCTAssertTrue(app.navigationBars["Notifications"].waitForExistence(timeout: 5))

        // NotificationSettingsView has a Toggle: "Enable Notifications"
        let enableToggle = app.switches["Enable Notifications"]
        XCTAssertTrue(enableToggle.waitForExistence(timeout: 3),
                       "Enable Notifications toggle should be visible")
    }

    // MARK: - Toggle Interaction

    func testToggleNotificationsInteraction() {
        app.tabBars.buttons["More"].tap()
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))

        app.swipeUp()

        app.staticTexts["Notifications"].tap()
        XCTAssertTrue(app.navigationBars["Notifications"].waitForExistence(timeout: 5))

        let enableToggle = app.switches["Enable Notifications"]
        XCTAssertTrue(enableToggle.waitForExistence(timeout: 3))

        // Record the initial state
        let initialValue = enableToggle.value as? String

        // Tap the toggle to change its state
        enableToggle.tap()

        // The value should have changed
        let newValue = enableToggle.value as? String
        XCTAssertNotEqual(initialValue, newValue,
                          "Toggle value should change after tapping")

        // Tap again to restore original state
        enableToggle.tap()

        let restoredValue = enableToggle.value as? String
        XCTAssertEqual(initialValue, restoredValue,
                       "Toggle should return to original state after tapping twice")
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
