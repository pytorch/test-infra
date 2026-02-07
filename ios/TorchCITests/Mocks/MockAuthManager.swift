import Foundation
@testable import TorchCI

/// A lightweight mock that mirrors the public surface of `AuthManager` without
/// requiring MainActor isolation or OAuth dependencies.
final class MockAuthManager {

    var isAuthenticated: Bool
    var username: String?
    var avatarURL: URL?
    var accessToken: String?

    private(set) var signInCallCount = 0
    private(set) var signOutCallCount = 0

    /// If non-nil, `signIn()` will throw this error.
    var signInError: Error?

    init(
        isAuthenticated: Bool = false,
        username: String? = nil,
        accessToken: String? = nil,
        avatarURL: URL? = nil
    ) {
        self.isAuthenticated = isAuthenticated
        self.username = username
        self.accessToken = accessToken
        self.avatarURL = avatarURL
    }

    func signIn() async throws {
        signInCallCount += 1
        if let error = signInError {
            throw error
        }
        isAuthenticated = true
        if username == nil { username = "mock-user" }
        if accessToken == nil { accessToken = "mock-token-12345" }
    }

    func signOut() {
        signOutCallCount += 1
        isAuthenticated = false
        username = nil
        accessToken = nil
        avatarURL = nil
    }

    // MARK: - Factory helpers

    static func authenticated(
        username: String = "pytorch-bot",
        token: String = "ghp_test123456789"
    ) -> MockAuthManager {
        MockAuthManager(
            isAuthenticated: true,
            username: username,
            accessToken: token
        )
    }

    static func unauthenticated() -> MockAuthManager {
        MockAuthManager()
    }
}
