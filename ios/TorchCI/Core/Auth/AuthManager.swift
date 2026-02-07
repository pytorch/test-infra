import Foundation
import AuthenticationServices
import UIKit

@MainActor
final class AuthManager: ObservableObject {
    static let shared = AuthManager()

    @Published private(set) var isAuthenticated = false
    @Published private(set) var username: String?
    @Published private(set) var avatarURL: URL?
    @Published private(set) var accessToken: String?

    private let keychain = KeychainHelper.shared

    private let clientID = "your_github_client_id"
    private let redirectURI = "torchci://callback"
    private let scope = "public_repo workflow"

    /// Retains the current auth session so it is not deallocated mid-flow.
    private var currentAuthSession: ASWebAuthenticationSession?

    /// Provides a presentation anchor for ASWebAuthenticationSession.
    private let contextProvider = AuthPresentationContextProvider()

    private init() {
        loadStoredCredentials()
    }

    func signIn() async throws {
        let authURL = buildAuthURL()
        let callbackURL = try await performOAuth(url: authURL)
        let code = try extractCode(from: callbackURL)
        let token = try await exchangeCodeForToken(code)
        await setAuthenticated(token: token)
    }

    func signOut() {
        accessToken = nil
        username = nil
        avatarURL = nil
        isAuthenticated = false
        keychain.delete(key: "github_access_token")
        keychain.delete(key: "github_username")
        keychain.delete(key: "github_avatar_url")
    }

    private func loadStoredCredentials() {
        if let token = keychain.read(key: "github_access_token") {
            accessToken = token
            username = keychain.read(key: "github_username")
            if let urlString = keychain.read(key: "github_avatar_url") {
                avatarURL = URL(string: urlString)
            }
            isAuthenticated = true
        }
    }

    private func buildAuthURL() -> URL {
        var components = URLComponents(string: "https://github.com/login/oauth/authorize")!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "scope", value: scope),
            URLQueryItem(name: "state", value: UUID().uuidString),
        ]
        return components.url!
    }

    private func performOAuth(url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: "torchci"
            ) { [weak self] callbackURL, error in
                // Clear the retained session reference
                Task { @MainActor in
                    self?.currentAuthSession = nil
                }
                if let error {
                    continuation.resume(throwing: error)
                } else if let callbackURL {
                    continuation.resume(returning: callbackURL)
                } else {
                    continuation.resume(throwing: APIError.invalidResponse)
                }
            }
            session.presentationContextProvider = contextProvider
            session.prefersEphemeralWebBrowserSession = false
            // Retain the session so it is not deallocated before completion
            currentAuthSession = session
            session.start()
        }
    }

    private func extractCode(from url: URL) throws -> String {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let code = components.queryItems?.first(where: { $0.name == "code" })?.value
        else {
            throw APIError.invalidResponse
        }
        return code
    }

    private func exchangeCodeForToken(_ code: String) async throws -> String {
        // Exchange authorization code for access token via backend
        // In production, this should go through your backend to keep client_secret safe
        let endpoint = APIEndpoint(
            path: "/api/auth/callback/github",
            method: .POST,
            body: try? JSONSerialization.data(withJSONObject: ["code": code])
        )
        let response: TokenResponse = try await APIClient.shared.fetch(endpoint)
        return response.accessToken
    }

    private func setAuthenticated(token: String) async {
        accessToken = token
        keychain.save(key: "github_access_token", value: token)

        // Fetch user info
        do {
            let userInfo: GitHubUser = try await fetchGitHubUser(token: token)
            username = userInfo.login
            avatarURL = URL(string: userInfo.avatarURL)
            keychain.save(key: "github_username", value: userInfo.login)
            keychain.save(key: "github_avatar_url", value: userInfo.avatarURL)
        } catch {
            // Auth succeeded even if user fetch fails
        }

        isAuthenticated = true
    }

    private func fetchGitHubUser(token: String) async throws -> GitHubUser {
        var request = URLRequest(url: URL(string: "https://api.github.com/user")!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONDecoder().decode(GitHubUser.self, from: data)
    }
}

private struct TokenResponse: Decodable {
    let accessToken: String

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
    }
}

private struct GitHubUser: Decodable {
    let login: String
    let avatarURL: String

    enum CodingKeys: String, CodingKey {
        case login
        case avatarURL = "avatar_url"
    }
}

// MARK: - Presentation Context Provider

/// Provides the presentation anchor for ASWebAuthenticationSession.
/// This is required for the OAuth sheet to display on screen.
private final class AuthPresentationContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // Return the key window as the presentation anchor
        let scenes = UIApplication.shared.connectedScenes
        let windowScene = scenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene
        return windowScene?.windows.first(where: { $0.isKeyWindow }) ?? ASPresentationAnchor()
    }
}
