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

        let list = app.collectionViews.firstMatch
        list.swipeUp()

        let settingsCell = list.staticTexts["Settings"]
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

        let list = app.collectionViews.firstMatch

        // Appearance section
        XCTAssertTrue(list.staticTexts["Appearance"].exists)

        // Default Repository section
        XCTAssertTrue(list.staticTexts["Default Repository"].exists)

        // Cache section - scroll down to find it
        list.swipeUp()
        XCTAssertTrue(list.staticTexts["Cache"].waitForExistence(timeout: 3))

        // About section
        XCTAssertTrue(list.staticTexts["About"].waitForExistence(timeout: 3))
    }

    // MARK: - Theme Picker (3 Options)

    func testThemePickerShowsThreeOptions() {
        navigateToSettings()

        let list = app.collectionViews.firstMatch

        // The Appearance section renders 3 buttons: Light, Dark, System
        // Each is rendered as a Button with the theme name as text
        let lightOption = list.staticTexts["Light"]
        let darkOption = list.staticTexts["Dark"]
        let systemOption = list.staticTexts["System"]

        XCTAssertTrue(lightOption.exists, "Light theme option should be visible")
        XCTAssertTrue(darkOption.exists, "Dark theme option should be visible")
        XCTAssertTrue(systemOption.exists, "System theme option should be visible")
    }

    func testThemePickerSelectLight() {
        navigateToSettings()

        let list = app.collectionViews.firstMatch

        // Tap "Light" option
        let lightOption = list.staticTexts["Light"]
        XCTAssertTrue(lightOption.exists)
        lightOption.tap()

        // After selecting, a checkmark should appear next to Light.
        // The checkmark is an Image(systemName: "checkmark") in the same row.
        // We verify the option is tappable (no crash) as a baseline.
        XCTAssertTrue(lightOption.exists, "Light option should still be visible after selection")
    }

    func testThemePickerSelectDark() {
        navigateToSettings()

        let list = app.collectionViews.firstMatch

        let darkOption = list.staticTexts["Dark"]
        XCTAssertTrue(darkOption.exists)
        darkOption.tap()

        XCTAssertTrue(darkOption.exists, "Dark option should still be visible after selection")
    }

    func testThemePickerSelectSystem() {
        navigateToSettings()

        let list = app.collectionViews.firstMatch

        let systemOption = list.staticTexts["System"]
        XCTAssertTrue(systemOption.exists)
        systemOption.tap()

        XCTAssertTrue(systemOption.exists, "System option should still be visible after selection")
    }

    // MARK: - Notification Settings Navigation

    func testNavigationToNotificationSettingsFromMore() {
        // Navigate to Notifications from the More tab (not from Settings)
        app.tabBars.buttons["More"].tap()
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))

        let list = app.collectionViews.firstMatch
        list.swipeUp()

        let notificationsCell = list.staticTexts["Notifications"]
        XCTAssertTrue(notificationsCell.waitForExistence(timeout: 3))
        notificationsCell.tap()

        XCTAssertTrue(app.navigationBars["Notifications"].waitForExistence(timeout: 5))
    }

    func testNotificationSettingsShowsEnableToggle() {
        app.tabBars.buttons["More"].tap()
        XCTAssertTrue(app.navigationBars["More"].waitForExistence(timeout: 5))

        let list = app.collectionViews.firstMatch
        list.swipeUp()

        list.staticTexts["Notifications"].tap()
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

        let list = app.collectionViews.firstMatch
        list.swipeUp()

        list.staticTexts["Notifications"].tap()
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

        let list = app.collectionViews.firstMatch
        list.swipeUp()

        // The cache section shows "Cache Size" label
        let cacheSizeLabel = list.staticTexts["Cache Size"]
        XCTAssertTrue(cacheSizeLabel.waitForExistence(timeout: 5),
                       "Cache Size label should be visible in settings")
    }

    func testCacheSectionShowsClearButton() {
        navigateToSettings()

        let list = app.collectionViews.firstMatch
        list.swipeUp()

        // The cache section has a "Clear Cache" button
        let clearCacheButton = list.staticTexts["Clear Cache"]
        XCTAssertTrue(clearCacheButton.waitForExistence(timeout: 5),
                       "Clear Cache button should be visible in settings")
    }

    // MARK: - About Section

    func testAboutSectionShowsLinks() {
        navigateToSettings()

        let list = app.collectionViews.firstMatch
        list.swipeUp()

        let aboutTorchCI = list.staticTexts["About TorchCI"]
        XCTAssertTrue(aboutTorchCI.waitForExistence(timeout: 3),
                       "About TorchCI link should be visible")

        let githubRepo = list.staticTexts["GitHub Repository"]
        XCTAssertTrue(githubRepo.exists, "GitHub Repository link should be visible")

        let feedback = list.staticTexts["Send Feedback"]
        XCTAssertTrue(feedback.exists, "Send Feedback link should be visible")
    }
}
