import XCTest
@testable import TorchCI

final class SettingsViewTests: XCTestCase {

    // MARK: - App Version Formatting

    func testFormatAppVersionReturnsVersionAndBuild() {
        // When using the default Bundle, formatAppVersion should return a
        // non-empty string in the format "X.Y (Z)".
        let version = SettingsView.formatAppVersion()
        XCTAssertFalse(version.isEmpty)
        XCTAssertTrue(version.contains("("), "Expected format 'version (build)' but got: \(version)")
        XCTAssertTrue(version.contains(")"), "Expected format 'version (build)' but got: \(version)")
    }

    func testFormatAppVersionFallsBackGracefully() {
        // A bundle without version keys should return the fallback "1.0 (1)".
        let emptyBundle = Bundle(for: SettingsViewTests.self)
        // The test bundle may or may not have version keys -- the method should
        // never crash regardless.
        let version = SettingsView.formatAppVersion(from: emptyBundle)
        XCTAssertFalse(version.isEmpty)
        XCTAssertTrue(version.contains("("))
    }

    // MARK: - Theme Descriptions

    func testThemeDescriptionForLight() {
        let description = SettingsView.themeDescription(for: .light)
        XCTAssertEqual(description, "Always use light mode")
    }

    func testThemeDescriptionForDark() {
        let description = SettingsView.themeDescription(for: .dark)
        XCTAssertEqual(description, "Always use dark mode")
    }

    func testThemeDescriptionForSystem() {
        let description = SettingsView.themeDescription(for: .system)
        XCTAssertEqual(description, "Match device appearance")
    }

    func testAllThemeModesHaveDescriptions() {
        for mode in ThemeMode.allCases {
            let description = SettingsView.themeDescription(for: mode)
            XCTAssertFalse(description.isEmpty, "ThemeMode.\(mode) should have a non-empty description")
        }
    }

    // MARK: - ThemeMode Properties

    func testThemeModeDisplayNames() {
        XCTAssertEqual(ThemeMode.light.displayName, "Light")
        XCTAssertEqual(ThemeMode.dark.displayName, "Dark")
        XCTAssertEqual(ThemeMode.system.displayName, "System")
    }

    func testThemeModeIcons() {
        XCTAssertEqual(ThemeMode.light.icon, "sun.max")
        XCTAssertEqual(ThemeMode.dark.icon, "moon")
        XCTAssertEqual(ThemeMode.system.icon, "circle.lefthalf.filled")
    }

    func testThemeModeRawValues() {
        XCTAssertEqual(ThemeMode.light.rawValue, "light")
        XCTAssertEqual(ThemeMode.dark.rawValue, "dark")
        XCTAssertEqual(ThemeMode.system.rawValue, "system")
    }

    func testThemeModeAllCasesCount() {
        XCTAssertEqual(ThemeMode.allCases.count, 3)
    }

    func testThemeModeInitFromRawValue() {
        XCTAssertEqual(ThemeMode(rawValue: "light"), .light)
        XCTAssertEqual(ThemeMode(rawValue: "dark"), .dark)
        XCTAssertEqual(ThemeMode(rawValue: "system"), .system)
        XCTAssertNil(ThemeMode(rawValue: "invalid"))
    }

    // MARK: - NotificationFrequency Properties

    func testNotificationFrequencyDisplayNames() {
        XCTAssertEqual(NotificationFrequency.immediate.displayName, "Immediate")
        XCTAssertEqual(NotificationFrequency.hourlyDigest.displayName, "Hourly Digest")
        XCTAssertEqual(NotificationFrequency.dailyDigest.displayName, "Daily Digest")
    }

    func testNotificationFrequencyDescriptions() {
        XCTAssertEqual(NotificationFrequency.immediate.description, "Notify as events occur")
        XCTAssertEqual(NotificationFrequency.hourlyDigest.description, "Batch notifications every hour")
        XCTAssertEqual(NotificationFrequency.dailyDigest.description, "Daily summary at 9:00 AM")
    }

    func testNotificationFrequencyRawValues() {
        XCTAssertEqual(NotificationFrequency.immediate.rawValue, "immediate")
        XCTAssertEqual(NotificationFrequency.hourlyDigest.rawValue, "hourlyDigest")
        XCTAssertEqual(NotificationFrequency.dailyDigest.rawValue, "dailyDigest")
    }

    func testNotificationFrequencyAllCasesCount() {
        XCTAssertEqual(NotificationFrequency.allCases.count, 3)
    }

    func testNotificationFrequencyInitFromRawValue() {
        XCTAssertEqual(NotificationFrequency(rawValue: "immediate"), .immediate)
        XCTAssertEqual(NotificationFrequency(rawValue: "hourlyDigest"), .hourlyDigest)
        XCTAssertEqual(NotificationFrequency(rawValue: "dailyDigest"), .dailyDigest)
        XCTAssertNil(NotificationFrequency(rawValue: "weekly"))
    }

    // MARK: - NotificationFrequency Codable

    func testNotificationFrequencyCodableRoundTrip() throws {
        for freq in NotificationFrequency.allCases {
            let data = try JSONEncoder().encode(freq)
            let decoded = try JSONDecoder().decode(NotificationFrequency.self, from: data)
            XCTAssertEqual(decoded, freq)
        }
    }

    // MARK: - RepoConfig

    func testRepoConfigId() {
        let config = RepoConfig(owner: "pytorch", name: "pytorch")
        XCTAssertEqual(config.id, "pytorch/pytorch")
    }

    func testRepoConfigDisplayName() {
        let config = RepoConfig(owner: "pytorch", name: "test-infra")
        XCTAssertEqual(config.displayName, "pytorch/test-infra")
    }

    func testRepoConfigEquality() {
        let a = RepoConfig(owner: "pytorch", name: "pytorch")
        let b = RepoConfig(owner: "pytorch", name: "pytorch")
        XCTAssertEqual(a, b)
    }

    func testRepoConfigInequality() {
        let a = RepoConfig(owner: "pytorch", name: "pytorch")
        let b = RepoConfig(owner: "pytorch", name: "test-infra")
        XCTAssertNotEqual(a, b)
    }

    func testRepoConfigCodableRoundTrip() throws {
        let config = RepoConfig(owner: "pytorch", name: "vision")
        let data = try JSONEncoder().encode(config)
        let decoded = try JSONDecoder().decode(RepoConfig.self, from: data)
        XCTAssertEqual(decoded.owner, "pytorch")
        XCTAssertEqual(decoded.name, "vision")
        XCTAssertEqual(decoded.id, "pytorch/vision")
    }

    func testRepoConfigHashable() {
        let a = RepoConfig(owner: "pytorch", name: "pytorch")
        let b = RepoConfig(owner: "pytorch", name: "pytorch")
        let c = RepoConfig(owner: "pytorch", name: "audio")

        var set = Set<RepoConfig>()
        set.insert(a)
        set.insert(b)
        set.insert(c)

        XCTAssertEqual(set.count, 2, "Identical configs should deduplicate in a Set")
    }

    // MARK: - NotificationPreferences Defaults

    func testNotificationPreferencesDefaults() {
        let prefs = NotificationPreferences()
        XCTAssertTrue(prefs.enabled)
        XCTAssertEqual(prefs.failureThreshold, 3)
        XCTAssertEqual(prefs.monitoredBranches, ["viable/strict"])
        XCTAssertEqual(prefs.monitoredRepos.count, 1)
        XCTAssertEqual(prefs.monitoredRepos.first?.owner, "pytorch")
        XCTAssertEqual(prefs.monitoredRepos.first?.name, "pytorch")
    }

    func testNotificationPreferencesCodableRoundTrip() throws {
        var prefs = NotificationPreferences()
        prefs.enabled = false
        prefs.failureThreshold = 5
        prefs.monitoredBranches = ["main", "nightly"]
        prefs.monitoredRepos = [
            RepoConfig(owner: "pytorch", name: "pytorch"),
            RepoConfig(owner: "pytorch", name: "vision"),
        ]

        let data = try JSONEncoder().encode(prefs)
        let decoded = try JSONDecoder().decode(NotificationPreferences.self, from: data)

        XCTAssertEqual(decoded.enabled, false)
        XCTAssertEqual(decoded.failureThreshold, 5)
        XCTAssertEqual(decoded.monitoredBranches, ["main", "nightly"])
        XCTAssertEqual(decoded.monitoredRepos.count, 2)
        XCTAssertEqual(decoded.monitoredRepos[0].displayName, "pytorch/pytorch")
        XCTAssertEqual(decoded.monitoredRepos[1].displayName, "pytorch/vision")
    }

    func testNotificationPreferencesFailureThresholdRange() {
        var prefs = NotificationPreferences()

        // The stepper in the UI constrains to 1...10 but the model should
        // store whatever is set.
        prefs.failureThreshold = 1
        XCTAssertEqual(prefs.failureThreshold, 1)

        prefs.failureThreshold = 10
        XCTAssertEqual(prefs.failureThreshold, 10)
    }

    // MARK: - AppColors

    func testAppColorsForConclusionSuccess() {
        let color = AppColors.forConclusion("success")
        XCTAssertEqual(color, AppColors.success)
    }

    func testAppColorsForConclusionFailure() {
        let color = AppColors.forConclusion("failure")
        XCTAssertEqual(color, AppColors.failure)
    }

    func testAppColorsForConclusionPending() {
        XCTAssertEqual(AppColors.forConclusion("pending"), AppColors.pending)
        XCTAssertEqual(AppColors.forConclusion("queued"), AppColors.pending)
        XCTAssertEqual(AppColors.forConclusion("in_progress"), AppColors.pending)
    }

    func testAppColorsForConclusionCaseInsensitive() {
        XCTAssertEqual(AppColors.forConclusion("SUCCESS"), AppColors.success)
        XCTAssertEqual(AppColors.forConclusion("Failure"), AppColors.failure)
    }

    func testAppColorsForConclusionNilReturnsNeutral() {
        XCTAssertEqual(AppColors.forConclusion(nil), AppColors.neutral)
    }

    func testAppColorsForConclusionUnknownReturnsNeutral() {
        XCTAssertEqual(AppColors.forConclusion("unknown"), AppColors.neutral)
    }

    func testAppColorsForConclusionSkipped() {
        XCTAssertEqual(AppColors.forConclusion("skipped"), AppColors.skipped)
    }

    func testAppColorsForConclusionCancelled() {
        XCTAssertEqual(AppColors.forConclusion("cancelled"), AppColors.cancelled)
        XCTAssertEqual(AppColors.forConclusion("canceled"), AppColors.cancelled)
    }

    func testAppColorsForConclusionUnstable() {
        XCTAssertEqual(AppColors.forConclusion("unstable"), AppColors.unstable)
    }
}
