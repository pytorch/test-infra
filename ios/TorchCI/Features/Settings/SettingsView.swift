import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var authManager: AuthManager
    @EnvironmentObject var themeManager: ThemeManager
    @AppStorage("default_repo") private var defaultRepo: String = "pytorch/pytorch"
    @AppStorage("default_branch") private var defaultBranch: String = "main"

    @State private var cacheSize: String = "Calculating..."
    @State private var isClearingCache = false
    @State private var showClearCacheConfirmation = false
    @State private var showSignOutConfirmation = false

    private let availableRepos = HUDViewModel.repos
    private let availableBranches = HUDViewModel.branches

    var body: some View {
        Form {
            accountSection
            generalSection
            appearanceSection
            defaultsSection
            cacheSection
            aboutSection
        }
        .navigationTitle("Settings")
        .task {
            await calculateCacheSize()
        }
        .alert("Clear Cache", isPresented: $showClearCacheConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Clear", role: .destructive) {
                clearCache()
            }
        } message: {
            Text("This will remove all cached data. The app may load more slowly until the cache is rebuilt.")
        }
        .alert("Sign Out", isPresented: $showSignOutConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Sign Out", role: .destructive) {
                authManager.signOut()
            }
        } message: {
            Text("Are you sure you want to sign out? You will lose access to authenticated features.")
        }
    }

    // MARK: - Account

    private var accountSection: some View {
        Section {
            if authManager.isAuthenticated {
                authenticatedAccountRow
                signOutRow
            } else {
                signInRow
            }
        } header: {
            Text("Account")
        } footer: {
            if !authManager.isAuthenticated {
                Text("Sign in to trigger workflows, access private repos, and unlock authenticated features.")
            }
        }
    }

    private var authenticatedAccountRow: some View {
        HStack(spacing: 12) {
            avatarView
                .frame(width: 48, height: 48)
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 3) {
                Text(authManager.username ?? "GitHub User")
                    .font(.body.weight(.semibold))

                HStack(spacing: 4) {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.caption2)
                        .foregroundStyle(AppColors.success)
                    Text("Signed in with GitHub")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Signed in as \(authManager.username ?? "GitHub User")")
    }

    private var avatarView: some View {
        Group {
            if let avatarURL = authManager.avatarURL {
                AsyncImage(url: avatarURL) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    case .failure, .empty:
                        avatarPlaceholder
                    @unknown default:
                        avatarPlaceholder
                    }
                }
            } else {
                avatarPlaceholder
            }
        }
    }

    private var avatarPlaceholder: some View {
        Image(systemName: "person.circle.fill")
            .resizable()
            .foregroundStyle(Color(.systemGray3))
    }

    private var signOutRow: some View {
        Button(role: .destructive) {
            showSignOutConfirmation = true
        } label: {
            Label {
                Text("Sign Out")
            } icon: {
                Image(systemName: "rectangle.portrait.and.arrow.right")
                    .foregroundStyle(.red)
            }
        }
    }

    private var signInRow: some View {
        NavigationLink {
            LoginView()
        } label: {
            settingsRow(
                icon: "person.badge.key.fill",
                iconColor: Color.accentColor,
                title: "Sign In with GitHub",
                subtitle: "Access workflows, private repos, and more"
            )
        }
    }

    // MARK: - General (Notifications)

    private var generalSection: some View {
        Section {
            NavigationLink {
                NotificationSettingsView()
            } label: {
                settingsRow(
                    icon: "bell.badge.fill",
                    iconColor: .orange,
                    title: "Notifications",
                    subtitle: "CI failures, build completions, regressions"
                )
            }
        } header: {
            Text("General")
        }
    }

    // MARK: - Appearance

    private var appearanceSection: some View {
        Section {
            ForEach(ThemeMode.allCases, id: \.self) { mode in
                Button {
                    withAnimation {
                        themeManager.themeMode = mode
                    }
                } label: {
                    HStack(spacing: 12) {
                        themeIconView(for: mode)
                            .frame(width: 28, height: 28)

                        VStack(alignment: .leading, spacing: 2) {
                            Text(mode.displayName)
                                .font(.body)
                                .foregroundStyle(.primary)

                            Text(themeDescription(for: mode))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        Spacer()

                        if themeManager.themeMode == mode {
                            Image(systemName: "checkmark")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                }
                .accessibilityLabel("\(mode.displayName) theme")
                .accessibilityValue(themeManager.themeMode == mode ? "Selected" : "")
                .accessibilityHint(themeDescription(for: mode))
                .accessibilityAddTraits(themeManager.themeMode == mode ? .isSelected : [])
            }
        } header: {
            Text("Appearance")
        }
    }

    private func themeIconView(for mode: ThemeMode) -> some View {
        Image(systemName: mode.icon)
            .font(.body)
            .foregroundStyle(themeManager.themeMode == mode ? Color.accentColor : .secondary)
            .frame(width: 28)
    }

    static func themeDescription(for mode: ThemeMode) -> String {
        switch mode {
        case .light: return "Always use light mode"
        case .dark: return "Always use dark mode"
        case .system: return "Match device appearance"
        }
    }

    private func themeDescription(for mode: ThemeMode) -> String {
        Self.themeDescription(for: mode)
    }

    // MARK: - Defaults

    private var defaultsSection: some View {
        Section {
            Picker(selection: $defaultRepo) {
                ForEach(availableRepos) { repo in
                    Text(repo.displayName)
                        .tag(repo.id)
                }
            } label: {
                Label {
                    Text("Repository")
                } icon: {
                    Image(systemName: "folder.fill")
                        .foregroundStyle(Color.accentColor)
                }
            }

            Picker(selection: $defaultBranch) {
                ForEach(availableBranches, id: \.self) { branch in
                    Text(branch)
                        .tag(branch)
                }
            } label: {
                Label {
                    Text("Branch")
                } icon: {
                    Image(systemName: "arrow.triangle.branch")
                        .foregroundStyle(Color.accentColor)
                }
            }
        } header: {
            Text("Defaults")
        } footer: {
            Text("Used as initial values when opening the HUD and other repository views.")
        }
    }

    // MARK: - Cache

    private var cacheSection: some View {
        Section {
            HStack {
                Label {
                    Text("Cache Size")
                } icon: {
                    Image(systemName: "internaldrive.fill")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(cacheSize)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Cache size: \(cacheSize)")

            Button(role: .destructive) {
                showClearCacheConfirmation = true
            } label: {
                HStack {
                    Label {
                        Text("Clear Cache")
                    } icon: {
                        Image(systemName: "trash.fill")
                            .foregroundStyle(.red)
                    }
                    Spacer()
                    if isClearingCache {
                        ProgressView()
                            .controlSize(.small)
                    }
                }
            }
            .disabled(isClearingCache)
            .accessibilityLabel("Clear cache")
            .accessibilityHint("Removes all cached data")
        } header: {
            Text("Storage")
        } footer: {
            Text("Cached data helps the app load faster. Clearing it may temporarily increase load times.")
        }
    }

    // MARK: - About

    private var aboutSection: some View {
        Section {
            HStack {
                Label {
                    Text("Version")
                } icon: {
                    Image(systemName: "app.badge.fill")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(appVersion)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("App version \(appVersion)")

            NavigationLink {
                AboutView()
            } label: {
                settingsRow(
                    icon: "info.circle.fill",
                    iconColor: Color.accentColor,
                    title: "About TorchCI",
                    subtitle: "Learn more about this app"
                )
            }

            LinkButton(
                title: "GitHub Repository",
                url: "https://github.com/pytorch/test-infra",
                icon: "chevron.left.forwardslash.chevron.right"
            )

            LinkButton(
                title: "Send Feedback",
                url: "https://github.com/pytorch/test-infra/issues/new",
                icon: "bubble.left.fill"
            )
        } header: {
            Text("About")
        }
    }

    // MARK: - Reusable Settings Row

    private func settingsRow(
        icon: String,
        iconColor: Color,
        title: String,
        subtitle: String
    ) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.body)
                .foregroundStyle(iconColor)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: - App Version

    static func formatAppVersion(from bundle: Bundle = .main) -> String {
        let version = bundle.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = bundle.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }

    private var appVersion: String {
        Self.formatAppVersion()
    }

    // MARK: - Helpers

    private func calculateCacheSize() async {
        let fileManager = FileManager.default
        let paths = fileManager.urls(for: .cachesDirectory, in: .userDomainMask)
        let cacheDir = paths[0].appendingPathComponent("TorchCI", isDirectory: true)

        var totalSize: Int64 = 0

        if let enumerator = fileManager.enumerator(
            at: cacheDir,
            includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]
        ) {
            for case let fileURL as URL in Array(enumerator) {
                if let resourceValues = try? fileURL.resourceValues(forKeys: [.fileSizeKey]),
                   let fileSize = resourceValues.fileSize {
                    totalSize += Int64(fileSize)
                }
            }
        }

        cacheSize = ByteCountFormatter.string(fromByteCount: totalSize, countStyle: .file)
    }

    private func clearCache() {
        isClearingCache = true
        Task { @MainActor in
            await CacheManager.shared.clearAll()
            await calculateCacheSize()
            isClearingCache = false
        }
    }
}

#Preview {
    NavigationStack {
        SettingsView()
    }
    .environmentObject(AuthManager.shared)
    .environmentObject(ThemeManager.shared)
    .environmentObject(NotificationManager.shared)
}
