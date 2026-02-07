import Foundation
import Security
import os.log

final class KeychainHelper: Sendable {
    static let shared = KeychainHelper()
    private let service = "com.pytorch.torchci"
    private let logger = Logger(subsystem: "com.pytorch.torchci", category: "Keychain")

    private init() {}

    @discardableResult
    func save(key: String, value: String) -> Bool {
        guard let data = value.data(using: .utf8) else {
            logger.error("Failed to encode value for key: \(key)")
            return false
        }

        // Delete any existing item first to avoid duplicates
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]

        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status != errSecSuccess {
            logger.error("Keychain save failed for key '\(key)': OSStatus \(status)")
        }
        return status == errSecSuccess
    }

    func read(key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let string = String(data: data, encoding: .utf8)
        else {
            if status != errSecItemNotFound {
                logger.error("Keychain read failed for key '\(key)': OSStatus \(status)")
            }
            return nil
        }

        return string
    }

    @discardableResult
    func delete(key: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            logger.error("Keychain delete failed for key '\(key)': OSStatus \(status)")
        }
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
