import SwiftUI

struct LoginView: View {
    @EnvironmentObject var authManager: AuthManager

    @State private var isLoading = false
    @State private var showError = false
    @State private var errorMessage = ""
    @State private var showSignOutConfirmation = false
    @State private var showTokenCopied = false

    var body: some View {
        Group {
            if authManager.isAuthenticated {
                authenticatedView
            } else {
                signInView
            }
        }
        .animation(.easeInOut(duration: 0.3), value: authManager.isAuthenticated)
        .navigationTitle("GitHub Account")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Sign In Failed", isPresented: $showError) {
            Button("Try Again") {
                signIn()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(errorMessage.isEmpty ? "Unable to sign in. Please try again." : errorMessage)
        }
        .alert("Sign Out", isPresented: $showSignOutConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Sign Out", role: .destructive) {
                authManager.signOut()
            }
        } message: {
            Text("Are you sure you want to sign out? Your access token will be removed from this device.")
        }
    }

    // MARK: - Sign In View

    private var signInView: some View {
        VStack(spacing: 0) {
            Spacer()

            // App branding section
            VStack(spacing: 16) {
                // TorchCI logo representation
                Image(systemName: "flame.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [.orange, .red],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )

                Text("TorchCI")
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .foregroundStyle(.primary)
            }
            .padding(.bottom, 48)

            // GitHub icon
            ZStack {
                Circle()
                    .fill(Color(white: 0.14))
                    .frame(width: 80, height: 80)

                Image(systemName: "chevron.left.forwardslash.chevron.right")
                    .font(.system(size: 32, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .accessibilityLabel("GitHub")
            .padding(.bottom, 24)

            // Title
            Text("Sign in with GitHub")
                .font(.system(size: 24, weight: .semibold))
                .padding(.bottom, 12)

            // Description
            Text("Access your CI data, trigger workflows,\nand manage build configurations")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineSpacing(4)
                .padding(.bottom, 36)

            // Feature highlights
            VStack(alignment: .leading, spacing: 14) {
                featureRow(icon: "checkmark.circle.fill", text: "View workflow runs and build status")
                featureRow(icon: "checkmark.circle.fill", text: "Trigger and manage CI workflows")
                featureRow(icon: "checkmark.circle.fill", text: "Access private repositories")
            }
            .padding(.horizontal, 40)
            .padding(.bottom, 36)

            // GitHub Sign In button
            Button {
                signIn()
            } label: {
                HStack(spacing: 10) {
                    if isLoading {
                        ProgressView()
                            .tint(.white)
                            .controlSize(.small)
                    } else {
                        Image(systemName: "chevron.left.forwardslash.chevron.right")
                            .font(.system(size: 16, weight: .semibold))
                    }

                    Text(isLoading ? "Signing in..." : "Sign in with GitHub")
                        .font(.system(size: 16, weight: .semibold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(Color(white: 0.14))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .padding(.horizontal, 32)
            .disabled(isLoading)
            .opacity(isLoading ? 0.7 : 1.0)
            .accessibilityLabel(isLoading ? "Signing in" : "Sign in with GitHub")

            Spacer()

            // Privacy footer
            VStack(spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "lock.shield.fill")
                        .font(.caption2)
                    Text("Secure OAuth Authentication")
                        .font(.caption)
                        .fontWeight(.medium)
                }
                .foregroundStyle(.secondary)

                Text("We never see your password. GitHub scopes: public_repo, workflow")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 32)
            .padding(.bottom, 24)
        }
    }

    // MARK: - Authenticated View

    private var authenticatedView: some View {
        List {
            // Profile header section
            Section {
                VStack(spacing: 16) {
                    // Avatar
                    profileAvatar
                        .frame(width: 80, height: 80)

                    // Username and status
                    VStack(spacing: 6) {
                        if let username = authManager.username {
                            Text(username)
                                .font(.title2.weight(.bold))
                        }

                        // Signed in badge
                        HStack(spacing: 5) {
                            Image(systemName: "checkmark.seal.fill")
                                .font(.caption)
                            Text("Connected")
                                .font(.subheadline.weight(.medium))
                        }
                        .foregroundStyle(AppColors.success)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .listRowBackground(Color.clear)
            }

            // Quick actions section
            Section {
                if let username = authManager.username,
                   let profileURL = URL(string: "https://github.com/\(username)") {
                    Link(destination: profileURL) {
                        HStack {
                            Label("View GitHub Profile", systemImage: "person.crop.circle")
                                .foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: "arrow.up.right.square")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Link(destination: URL(string: "https://github.com/settings/connections/applications")!) {
                    HStack {
                        Label("Manage App Permissions", systemImage: "gear")
                            .foregroundStyle(.primary)
                        Spacer()
                        Image(systemName: "arrow.up.right.square")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("Quick Actions")
            }

            // Account details section
            Section {
                HStack {
                    Label("Authentication", systemImage: "lock.shield")
                    Spacer()
                    Text("OAuth Token")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                HStack {
                    Label("Permissions", systemImage: "key")
                    Spacer()
                    Text("public_repo, workflow")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                if let token = authManager.accessToken {
                    HStack {
                        Label("Token", systemImage: "ellipsis.rectangle")
                        Spacer()
                        Text(maskedToken(token))
                            .font(.subheadline.monospaced())
                            .foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("Account Details")
            }

            // Sign out section
            Section {
                Button(role: .destructive) {
                    showSignOutConfirmation = true
                } label: {
                    HStack {
                        Spacer()
                        Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                            .fontWeight(.medium)
                        Spacer()
                    }
                }
            } footer: {
                Text("Signing out will remove your access token from this device. You can sign in again at any time.")
            }
        }
    }

    // MARK: - Subviews

    private var profileAvatar: some View {
        Group {
            if let avatarURL = authManager.avatarURL {
                AsyncImage(url: avatarURL) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    case .failure:
                        avatarPlaceholder
                    case .empty:
                        ProgressView()
                            .frame(width: 80, height: 80)
                    @unknown default:
                        avatarPlaceholder
                    }
                }
                .clipShape(Circle())
                .overlay(
                    Circle()
                        .strokeBorder(Color(.systemGray4), lineWidth: 1)
                )
            } else {
                avatarPlaceholder
            }
        }
    }

    private var avatarPlaceholder: some View {
        Image(systemName: "person.circle.fill")
            .resizable()
            .foregroundStyle(Color(.systemGray3))
            .frame(width: 80, height: 80)
    }

    private func featureRow(icon: String, text: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(AppColors.success)
                .frame(width: 20)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.primary)
            Spacer()
        }
    }

    // MARK: - Helpers

    /// Masks all but the last 4 characters of the token for display.
    static func maskedToken(_ token: String) -> String {
        guard token.count > 4 else {
            return String(repeating: "*", count: token.count)
        }
        let suffix = String(token.suffix(4))
        return String(repeating: "*", count: min(token.count - 4, 8)) + suffix
    }

    private func maskedToken(_ token: String) -> String {
        Self.maskedToken(token)
    }

    // MARK: - Actions

    private func signIn() {
        isLoading = true
        Task { @MainActor in
            do {
                try await authManager.signIn()
            } catch {
                errorMessage = error.localizedDescription
                showError = true
            }
            isLoading = false
        }
    }
}

#Preview("Signed Out") {
    NavigationStack {
        LoginView()
    }
    .environmentObject(AuthManager.shared)
}
