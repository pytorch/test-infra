import XCTest
@testable import TorchCI

final class NotificationSettingsTests: XCTestCase {

    // MARK: - NotificationPreferences Default Values

    func testDefaultPreferencesValues() {
        let prefs = NotificationPreferences()

        XCTAssertTrue(prefs.enabled)
        XCTAssertEqual(prefs.failureThreshold, 3)
        XCTAssertEqual(prefs.monitoredBranches, ["viable/strict"])
        XCTAssertEqual(prefs.monitoredRepos.count, 1)
        XCTAssertEqual(prefs.monitoredRepos.first?.owner, "pytorch")
        XCTAssertEqual(prefs.monitoredRepos.first?.name, "pytorch")
    }

    // MARK: - NotificationPreferences Codable

    func testPreferencesRoundTrip() {
        let original = NotificationPreferences(
            enabled: false,
            failureThreshold: 7,
            monitoredBranches: ["main", "nightly", "viable/strict"],
            monitoredRepos: [
                RepoConfig(owner: "pytorch", name: "pytorch"),
                RepoConfig(owner: "pytorch", name: "vision"),
            ]
        )

        let data = try! JSONEncoder().encode(original)
        let decoded = try! JSONDecoder().decode(NotificationPreferences.self, from: data)

        XCTAssertEqual(decoded.enabled, original.enabled)
        XCTAssertEqual(decoded.failureThreshold, original.failureThreshold)
        XCTAssertEqual(decoded.monitoredBranches, original.monitoredBranches)
        XCTAssertEqual(decoded.monitoredRepos.count, original.monitoredRepos.count)
        XCTAssertEqual(decoded.monitoredRepos[0].id, "pytorch/pytorch")
        XCTAssertEqual(decoded.monitoredRepos[1].id, "pytorch/vision")
    }

    func testPreferencesDecodingFromJSON() {
        let json = """
        {
            "enabled": true,
            "failureThreshold": 5,
            "monitoredBranches": ["main"],
            "monitoredRepos": [
                {"owner": "pytorch", "name": "audio"}
            ]
        }
        """

        let prefs: NotificationPreferences = MockData.decode(json)

        XCTAssertTrue(prefs.enabled)
        XCTAssertEqual(prefs.failureThreshold, 5)
        XCTAssertEqual(prefs.monitoredBranches, ["main"])
        XCTAssertEqual(prefs.monitoredRepos.count, 1)
        XCTAssertEqual(prefs.monitoredRepos.first?.displayName, "pytorch/audio")
    }

    func testPreferencesDisabledState() {
        let json = """
        {
            "enabled": false,
            "failureThreshold": 1,
            "monitoredBranches": [],
            "monitoredRepos": []
        }
        """

        let prefs: NotificationPreferences = MockData.decode(json)

        XCTAssertFalse(prefs.enabled)
        XCTAssertTrue(prefs.monitoredBranches.isEmpty)
        XCTAssertTrue(prefs.monitoredRepos.isEmpty)
    }

    // MARK: - NotificationPreferences UserDefaults Persistence

    func testPreferencesSaveAndLoad() {
        let testKey = "notification_preferences"
        // Clear any existing value
        UserDefaults.standard.removeObject(forKey: testKey)

        let prefs = NotificationPreferences(
            enabled: true,
            failureThreshold: 4,
            monitoredBranches: ["release/2.6"],
            monitoredRepos: [RepoConfig(owner: "pytorch", name: "executorch")]
        )
        prefs.save()

        let loaded = NotificationPreferences.load()

        XCTAssertEqual(loaded.enabled, true)
        XCTAssertEqual(loaded.failureThreshold, 4)
        XCTAssertEqual(loaded.monitoredBranches, ["release/2.6"])
        XCTAssertEqual(loaded.monitoredRepos.first?.id, "pytorch/executorch")

        // Cleanup
        UserDefaults.standard.removeObject(forKey: testKey)
    }

    func testPreferencesLoadReturnsDefaultWhenNoData() {
        let testKey = "notification_preferences"
        UserDefaults.standard.removeObject(forKey: testKey)

        let loaded = NotificationPreferences.load()

        // Should return defaults
        XCTAssertTrue(loaded.enabled)
        XCTAssertEqual(loaded.failureThreshold, 3)
        XCTAssertEqual(loaded.monitoredBranches, ["viable/strict"])
    }

    func testPreferencesLoadReturnsDefaultForCorruptedData() {
        let testKey = "notification_preferences"
        // Write garbage data
        UserDefaults.standard.set(Data("not valid json".utf8), forKey: testKey)

        let loaded = NotificationPreferences.load()

        // Should return defaults rather than crash
        XCTAssertTrue(loaded.enabled)
        XCTAssertEqual(loaded.failureThreshold, 3)

        // Cleanup
        UserDefaults.standard.removeObject(forKey: testKey)
    }

    // MARK: - NotificationPreferences Mutation

    func testAddBranch() {
        var prefs = NotificationPreferences(
            enabled: true,
            failureThreshold: 3,
            monitoredBranches: ["main"],
            monitoredRepos: []
        )

        prefs.monitoredBranches.append("nightly")

        XCTAssertEqual(prefs.monitoredBranches.count, 2)
        XCTAssertEqual(prefs.monitoredBranches[1], "nightly")
    }

    func testRemoveBranch() {
        var prefs = NotificationPreferences(
            enabled: true,
            failureThreshold: 3,
            monitoredBranches: ["main", "nightly", "viable/strict"],
            monitoredRepos: []
        )

        prefs.monitoredBranches.remove(at: 1)

        XCTAssertEqual(prefs.monitoredBranches, ["main", "viable/strict"])
    }

    func testAddRepo() {
        var prefs = NotificationPreferences(
            enabled: true,
            failureThreshold: 3,
            monitoredBranches: [],
            monitoredRepos: [RepoConfig(owner: "pytorch", name: "pytorch")]
        )

        let newRepo = RepoConfig(owner: "pytorch", name: "vision")
        prefs.monitoredRepos.append(newRepo)

        XCTAssertEqual(prefs.monitoredRepos.count, 2)
        XCTAssertEqual(prefs.monitoredRepos[1].displayName, "pytorch/vision")
    }

    func testRemoveRepo() {
        var prefs = NotificationPreferences(
            enabled: true,
            failureThreshold: 3,
            monitoredBranches: [],
            monitoredRepos: [
                RepoConfig(owner: "pytorch", name: "pytorch"),
                RepoConfig(owner: "pytorch", name: "vision"),
            ]
        )

        prefs.monitoredRepos.remove(at: 0)

        XCTAssertEqual(prefs.monitoredRepos.count, 1)
        XCTAssertEqual(prefs.monitoredRepos.first?.id, "pytorch/vision")
    }

    // MARK: - RepoConfig

    func testRepoConfigId() {
        let config = RepoConfig(owner: "pytorch", name: "pytorch")

        XCTAssertEqual(config.id, "pytorch/pytorch")
    }

    func testRepoConfigDisplayName() {
        let config = RepoConfig(owner: "pytorch", name: "executorch")

        XCTAssertEqual(config.displayName, "pytorch/executorch")
    }

    func testRepoConfigEquality() {
        let config1 = RepoConfig(owner: "pytorch", name: "pytorch")
        let config2 = RepoConfig(owner: "pytorch", name: "pytorch")
        let config3 = RepoConfig(owner: "pytorch", name: "vision")

        XCTAssertEqual(config1, config2)
        XCTAssertNotEqual(config1, config3)
    }

    func testRepoConfigHashable() {
        let config1 = RepoConfig(owner: "pytorch", name: "pytorch")
        let config2 = RepoConfig(owner: "pytorch", name: "pytorch")

        var set = Set<RepoConfig>()
        set.insert(config1)
        set.insert(config2)

        XCTAssertEqual(set.count, 1, "Equal RepoConfigs should deduplicate in a Set")
    }

    func testRepoConfigCodable() {
        let json = """
        {"owner": "meta", "name": "llama"}
        """

        let config: RepoConfig = MockData.decode(json)

        XCTAssertEqual(config.owner, "meta")
        XCTAssertEqual(config.name, "llama")
        XCTAssertEqual(config.id, "meta/llama")
    }

    // MARK: - NotificationFrequency

    func testNotificationFrequencyAllCases() {
        let cases = NotificationFrequency.allCases

        XCTAssertEqual(cases.count, 3)
        XCTAssertEqual(cases[0], .immediate)
        XCTAssertEqual(cases[1], .hourlyDigest)
        XCTAssertEqual(cases[2], .dailyDigest)
    }

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

    func testNotificationFrequencyIcons() {
        XCTAssertEqual(NotificationFrequency.immediate.icon, "bolt.fill")
        XCTAssertEqual(NotificationFrequency.hourlyDigest.icon, "clock.fill")
        XCTAssertEqual(NotificationFrequency.dailyDigest.icon, "calendar")
    }

    func testNotificationFrequencyRawValues() {
        XCTAssertEqual(NotificationFrequency.immediate.rawValue, "immediate")
        XCTAssertEqual(NotificationFrequency.hourlyDigest.rawValue, "hourlyDigest")
        XCTAssertEqual(NotificationFrequency.dailyDigest.rawValue, "dailyDigest")
    }

    func testNotificationFrequencyFromRawValue() {
        XCTAssertEqual(NotificationFrequency(rawValue: "immediate"), .immediate)
        XCTAssertEqual(NotificationFrequency(rawValue: "hourlyDigest"), .hourlyDigest)
        XCTAssertEqual(NotificationFrequency(rawValue: "dailyDigest"), .dailyDigest)
        XCTAssertNil(NotificationFrequency(rawValue: "invalid"))
        XCTAssertNil(NotificationFrequency(rawValue: ""))
    }

    func testNotificationFrequencyCodable() {
        let json = "\"hourlyDigest\""

        let data = json.data(using: .utf8)!
        let decoded = try! JSONDecoder().decode(NotificationFrequency.self, from: data)

        XCTAssertEqual(decoded, .hourlyDigest)
    }

    func testNotificationFrequencyCodableRoundTrip() {
        for freq in NotificationFrequency.allCases {
            let data = try! JSONEncoder().encode(freq)
            let decoded = try! JSONDecoder().decode(NotificationFrequency.self, from: data)
            XCTAssertEqual(decoded, freq)
        }
    }

    // MARK: - Failure Threshold Edge Cases

    func testFailureThresholdMinValue() {
        let prefs = NotificationPreferences(
            enabled: true,
            failureThreshold: 1,
            monitoredBranches: ["main"],
            monitoredRepos: []
        )

        XCTAssertEqual(prefs.failureThreshold, 1)
    }

    func testFailureThresholdMaxValue() {
        let prefs = NotificationPreferences(
            enabled: true,
            failureThreshold: 10,
            monitoredBranches: ["main"],
            monitoredRepos: []
        )

        XCTAssertEqual(prefs.failureThreshold, 10)
    }

    // MARK: - Preferences with Multiple Branches and Repos

    func testPreferencesWithManyBranches() {
        let branches = ["main", "viable/strict", "nightly", "release/2.6", "release/2.5"]
        let prefs = NotificationPreferences(
            enabled: true,
            failureThreshold: 3,
            monitoredBranches: branches,
            monitoredRepos: []
        )

        XCTAssertEqual(prefs.monitoredBranches.count, 5)
        XCTAssertTrue(prefs.monitoredBranches.contains("viable/strict"))
        XCTAssertTrue(prefs.monitoredBranches.contains("nightly"))
    }

    func testPreferencesWithManyRepos() {
        let repos = [
            RepoConfig(owner: "pytorch", name: "pytorch"),
            RepoConfig(owner: "pytorch", name: "vision"),
            RepoConfig(owner: "pytorch", name: "audio"),
            RepoConfig(owner: "pytorch", name: "text"),
            RepoConfig(owner: "pytorch", name: "executorch"),
        ]

        let prefs = NotificationPreferences(
            enabled: true,
            failureThreshold: 3,
            monitoredBranches: ["main"],
            monitoredRepos: repos
        )

        XCTAssertEqual(prefs.monitoredRepos.count, 5)

        let ids = Set(prefs.monitoredRepos.map(\.id))
        XCTAssertEqual(ids.count, 5, "All repo IDs should be unique")
    }

    // MARK: - Duplicate Prevention Logic

    func testDuplicateBranchNotAdded() {
        // This tests the guard logic used in the view's addBranch() method
        var branches = ["main", "nightly"]
        let newBranch = "main"

        let trimmed = newBranch.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !branches.contains(trimmed) else {
            // Should hit this path
            XCTAssertTrue(branches.contains(trimmed))
            return
        }
        branches.append(trimmed)
        XCTFail("Should not reach here because branch already exists")
    }

    func testDuplicateRepoNotAdded() {
        // This tests the guard logic used in the view's addRepo() method
        var repos = [RepoConfig(owner: "pytorch", name: "pytorch")]
        let newConfig = RepoConfig(owner: "pytorch", name: "pytorch")

        guard !repos.contains(where: { $0.id == newConfig.id }) else {
            // Should hit this path
            XCTAssertEqual(repos.count, 1)
            return
        }
        repos.append(newConfig)
        XCTFail("Should not reach here because repo already exists")
    }

    func testWhitespaceOnlyBranchNotAdded() {
        let branch = "   "
        let trimmed = branch.trimmingCharacters(in: .whitespaces)

        XCTAssertTrue(trimmed.isEmpty, "Whitespace-only branch should be treated as empty")
    }

    func testBranchNameTrimming() {
        let branch = "  main  "
        let trimmed = branch.trimmingCharacters(in: .whitespaces)

        XCTAssertEqual(trimmed, "main")
    }

    // MARK: - RepoConfig Contains Check

    func testRepoContainsById() {
        let repos = [
            RepoConfig(owner: "pytorch", name: "pytorch"),
            RepoConfig(owner: "pytorch", name: "vision"),
        ]

        XCTAssertTrue(repos.contains(where: { $0.id == "pytorch/pytorch" }))
        XCTAssertTrue(repos.contains(where: { $0.id == "pytorch/vision" }))
        XCTAssertFalse(repos.contains(where: { $0.id == "pytorch/audio" }))
    }

    // MARK: - IndexSet Deletion

    func testDeleteBranchByIndexSet() {
        var prefs = NotificationPreferences(
            enabled: true,
            failureThreshold: 3,
            monitoredBranches: ["main", "nightly", "viable/strict"],
            monitoredRepos: []
        )

        let offsets = IndexSet(integer: 1)
        prefs.monitoredBranches.remove(atOffsets: offsets)

        XCTAssertEqual(prefs.monitoredBranches, ["main", "viable/strict"])
    }

    func testDeleteRepoByIndexSet() {
        var prefs = NotificationPreferences(
            enabled: true,
            failureThreshold: 3,
            monitoredBranches: [],
            monitoredRepos: [
                RepoConfig(owner: "pytorch", name: "pytorch"),
                RepoConfig(owner: "pytorch", name: "vision"),
                RepoConfig(owner: "pytorch", name: "audio"),
            ]
        )

        let offsets = IndexSet([0, 2])
        prefs.monitoredRepos.remove(atOffsets: offsets)

        XCTAssertEqual(prefs.monitoredRepos.count, 1)
        XCTAssertEqual(prefs.monitoredRepos.first?.name, "vision")
    }

    // MARK: - Preferences Encoding Stability

    func testPreferencesEncodingProducesValidJSON() {
        let prefs = NotificationPreferences(
            enabled: true,
            failureThreshold: 5,
            monitoredBranches: ["main"],
            monitoredRepos: [RepoConfig(owner: "pytorch", name: "pytorch")]
        )

        let data = try! JSONEncoder().encode(prefs)
        let jsonObject = try! JSONSerialization.jsonObject(with: data)

        XCTAssertTrue(jsonObject is [String: Any], "Encoded preferences should be a JSON dictionary")

        let dict = jsonObject as! [String: Any]
        XCTAssertNotNil(dict["enabled"])
        XCTAssertNotNil(dict["failureThreshold"])
        XCTAssertNotNil(dict["monitoredBranches"])
        XCTAssertNotNil(dict["monitoredRepos"])
    }
}
