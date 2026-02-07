import XCTest
@testable import TorchCI

final class KeychainHelperTests: XCTestCase {

    private let keychain = KeychainHelper.shared

    /// Unique prefix per test run to avoid collisions with real app data.
    private let testPrefix = "test_\(UUID().uuidString.prefix(8))_"

    private func testKey(_ suffix: String) -> String {
        "\(testPrefix)\(suffix)"
    }

    override func tearDown() {
        // Clean up any keys we created during the test.
        let keys = ["alpha", "beta", "gamma", "overwrite", "delete_me", "nonexistent"]
        for suffix in keys {
            keychain.delete(key: testKey(suffix))
        }
        super.tearDown()
    }

    // MARK: - Save then Read

    func testSaveThenReadReturnsValue() {
        let key = testKey("alpha")
        let value = "secret-token-12345"

        keychain.save(key: key, value: value)
        let result = keychain.read(key: key)

        XCTAssertEqual(result, value)
    }

    func testSaveThenReadWithSpecialCharacters() {
        let key = testKey("beta")
        let value = "p@$$w0rd!#%^&*()_+-=[]{}|;':\",./<>?"

        keychain.save(key: key, value: value)
        let result = keychain.read(key: key)

        XCTAssertEqual(result, value)
    }

    func testSaveThenReadEmptyString() {
        let key = testKey("gamma")
        let value = ""

        keychain.save(key: key, value: value)
        let result = keychain.read(key: key)

        // Empty data is valid UTF-8, but the guard on data(using:) returns
        // empty Data; SecItemAdd may or may not store it.  Just verify it
        // doesn't crash and returns something reasonable.
        XCTAssertNotNil(result)
    }

    // MARK: - Read Non-Existent

    func testReadNonExistentKeyReturnsNil() {
        let key = testKey("nonexistent")
        let result = keychain.read(key: key)
        XCTAssertNil(result)
    }

    // MARK: - Delete

    func testDeleteRemovesValue() {
        let key = testKey("delete_me")
        keychain.save(key: key, value: "to-be-deleted")

        // Verify it was saved
        XCTAssertNotNil(keychain.read(key: key))

        keychain.delete(key: key)

        let result = keychain.read(key: key)
        XCTAssertNil(result)
    }

    func testDeleteNonExistentKeyDoesNotCrash() {
        let key = testKey("nonexistent")
        // Should not throw or crash
        keychain.delete(key: key)
        XCTAssertNil(keychain.read(key: key))
    }

    // MARK: - Overwrite

    func testOverwriteReplacesValue() {
        let key = testKey("overwrite")
        let originalValue = "original-value"
        let newValue = "replacement-value"

        keychain.save(key: key, value: originalValue)
        XCTAssertEqual(keychain.read(key: key), originalValue)

        keychain.save(key: key, value: newValue)
        XCTAssertEqual(keychain.read(key: key), newValue)
    }

    func testMultipleOverwrites() {
        let key = testKey("overwrite")

        for i in 0..<5 {
            let value = "value-\(i)"
            keychain.save(key: key, value: value)
            XCTAssertEqual(keychain.read(key: key), value, "Iteration \(i)")
        }
    }
}
