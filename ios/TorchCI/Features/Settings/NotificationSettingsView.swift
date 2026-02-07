import SwiftUI
import UserNotifications

struct NotificationSettingsView: View {
    @EnvironmentObject var notificationManager: NotificationManager

    @State private var preferences: NotificationPreferences = .load()
    @State private var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @State private var showAddBranchSheet = false
    @State private var showAddRepoSheet = false
    @State private var newBranchName = ""
    @State private var newRepoOwner = ""
    @State private var newRepoName = ""
    @State private var showTestNotificationSent = false
    @State private var showNotificationPreview = false

    // Extended notification preferences (stored in UserDefaults separately)
    @AppStorage("notify_ci_failures") private var notifyOnCIFailures = true
    @AppStorage("notify_build_completions") private var notifyOnBuildCompletions = false
    @AppStorage("notify_regressions") private var notifyOnRegressions = true
    @AppStorage("notification_frequency") private var frequencyRawValue = NotificationFrequency.immediate.rawValue

    private var frequency: NotificationFrequency {
        get { NotificationFrequency(rawValue: frequencyRawValue) ?? .immediate }
        set { frequencyRawValue = newValue.rawValue }
    }

    var body: some View {
        List {
            authorizationSection
            masterToggleSection

            if preferences.enabled {
                notificationTypesSection
                frequencySection
                thresholdSection
                monitoredBranchesSection
                monitoredReposSection
                previewSection
            }
        }
        .navigationTitle("Notifications")
        .task {
            await refreshAuthorizationStatus()
        }
        .onChange(of: preferences.enabled) { _, newValue in
            if newValue && authorizationStatus != .authorized {
                notificationManager.requestAuthorization()
            }
            savePreferences()
        }
        .onChange(of: preferences.failureThreshold) { _, _ in
            savePreferences()
        }
        .sheet(isPresented: $showAddBranchSheet) {
            addBranchSheet
        }
        .sheet(isPresented: $showAddRepoSheet) {
            addRepoSheet
        }
        .sheet(isPresented: $showNotificationPreview) {
            notificationPreviewSheet
        }
    }

    // MARK: - Authorization Status

    private var authorizationSection: some View {
        Section {
            HStack(spacing: 12) {
                authorizationStatusBadge
                    .frame(width: 36, height: 36)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Push Notifications")
                        .font(.body.weight(.medium))
                    Text(authorizationStatusText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)

                Spacer()

                if authorizationStatus == .denied {
                    Button {
                        openSystemSettings()
                    } label: {
                        Text("Settings")
                            .font(.subheadline.weight(.medium))
                    }
                    .accessibilityHint("Opens iOS notification settings for TorchCI")
                } else if authorizationStatus == .notDetermined {
                    Button("Enable") {
                        notificationManager.requestAuthorization()
                        Task { @MainActor in
                            try? await Task.sleep(for: .seconds(1))
                            await refreshAuthorizationStatus()
                        }
                    }
                    .font(.subheadline.weight(.medium))
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .accessibilityHint("Requests permission to send push notifications")
                }
            }
            .padding(.vertical, 4)
        } footer: {
            if authorizationStatus == .denied {
                Text("Notifications are disabled in iOS Settings. Tap \"Settings\" above to open notification preferences for TorchCI.")
            }
        }
    }

    @ViewBuilder
    private var authorizationStatusBadge: some View {
        ZStack {
            Circle()
                .fill(authorizationStatusColor.opacity(0.15))
            Image(systemName: authorizationStatusIcon)
                .font(.body.weight(.semibold))
                .foregroundStyle(authorizationStatusColor)
        }
    }

    // MARK: - Master Toggle

    private var masterToggleSection: some View {
        Section {
            Toggle(isOn: $preferences.enabled) {
                Label {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Enable Notifications")
                            .font(.body)
                        Text("Monitor CI health in the background")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "bell.badge.fill")
                        .foregroundStyle(preferences.enabled ? AppColors.success : .secondary)
                }
            }
            .disabled(authorizationStatus != .authorized && preferences.enabled)
            .accessibilityHint(preferences.enabled ? "Notifications are currently on" : "Notifications are currently off")
        } footer: {
            if authorizationStatus == .authorized {
                Text("TorchCI monitors CI health in the background and alerts you based on your preferences below.")
            } else if preferences.enabled {
                Text("Please enable push notifications in iOS Settings to receive alerts.")
            }
        }
    }

    // MARK: - Notification Types

    private var notificationTypesSection: some View {
        Section {
            notificationTypeToggle(
                isOn: $notifyOnCIFailures,
                icon: "xmark.circle.fill",
                iconColor: AppColors.failure,
                title: "CI Failures",
                description: "Alert when branches exceed failure threshold"
            )

            notificationTypeToggle(
                isOn: $notifyOnBuildCompletions,
                icon: "checkmark.circle.fill",
                iconColor: AppColors.success,
                title: "Build Completions",
                description: "Notify when monitored builds finish"
            )

            notificationTypeToggle(
                isOn: $notifyOnRegressions,
                icon: "exclamationmark.triangle.fill",
                iconColor: .orange,
                title: "Regression Alerts",
                description: "Warn about performance or reliability regressions"
            )
        } header: {
            HStack {
                Text("Notification Types")
                Spacer()
                Text(enabledTypesCountLabel)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        } footer: {
            Text("Choose which types of events trigger notifications. At least one type must be enabled.")
        }
    }

    private func notificationTypeToggle(
        isOn: Binding<Bool>,
        icon: String,
        iconColor: Color,
        title: String,
        description: String
    ) -> some View {
        Toggle(isOn: isOn) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.body)
                    .foregroundStyle(isOn.wrappedValue ? iconColor : .secondary)
                    .frame(width: 24)

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.body)
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityLabel("\(title): \(description)")
    }

    private var enabledTypesCountLabel: String {
        let count = enabledNotificationTypeCount
        return "\(count) of 3 active"
    }

    var enabledNotificationTypeCount: Int {
        [notifyOnCIFailures, notifyOnBuildCompletions, notifyOnRegressions]
            .filter { $0 }
            .count
    }

    // MARK: - Notification Frequency

    private var frequencySection: some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: frequency.icon)
                    .font(.body)
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 24)

                VStack(alignment: .leading, spacing: 3) {
                    Text("Delivery")
                        .font(.body)
                    Text(frequency.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Picker("", selection: Binding(
                    get: { frequency },
                    set: { frequencyRawValue = $0.rawValue }
                )) {
                    ForEach(NotificationFrequency.allCases, id: \.self) { freq in
                        Text(freq.displayName).tag(freq)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
            }
        } header: {
            Text("Delivery Frequency")
        } footer: {
            Text(frequencyFooterText)
        }
    }

    private var frequencyFooterText: String {
        switch frequency {
        case .immediate:
            return "Notifications are sent as soon as issues are detected. Best for time-sensitive monitoring."
        case .hourlyDigest:
            return "Notifications are batched and sent once per hour. Reduces interruptions while staying informed."
        case .dailyDigest:
            return "Notifications are batched and sent once per day at 9:00 AM. Ideal for high-level oversight."
        }
    }

    // MARK: - Failure Threshold

    private var thresholdSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 12) {
                Stepper(value: $preferences.failureThreshold, in: 1...10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Failure Threshold")
                            .font(.body)
                        Text("Alert after \(preferences.failureThreshold) consecutive failure\(preferences.failureThreshold == 1 ? "" : "s")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityValue("\(preferences.failureThreshold) failures")

                thresholdGauge
            }
        } header: {
            Text("Alert Sensitivity")
        } footer: {
            Text("A higher threshold reduces noise by only alerting when multiple commits fail in a row. Lower values give earlier warnings.")
        }
    }

    private var thresholdGauge: some View {
        VStack(spacing: 4) {
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color(.systemGray5))
                        .frame(height: 6)

                    RoundedRectangle(cornerRadius: 3)
                        .fill(thresholdGaugeColor)
                        .frame(
                            width: geometry.size.width * CGFloat(preferences.failureThreshold) / 10.0,
                            height: 6
                        )
                        .animation(.easeInOut(duration: 0.2), value: preferences.failureThreshold)
                }
            }
            .frame(height: 6)

            HStack {
                Text("Sensitive")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
                Text("Quiet")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityHidden(true)
    }

    private var thresholdGaugeColor: Color {
        if preferences.failureThreshold <= 2 {
            return AppColors.failure
        } else if preferences.failureThreshold <= 5 {
            return AppColors.pending
        } else {
            return AppColors.success
        }
    }

    // MARK: - Monitored Branches

    private var monitoredBranchesSection: some View {
        Section {
            if preferences.monitoredBranches.isEmpty {
                HStack(spacing: 10) {
                    Image(systemName: "arrow.triangle.branch")
                        .foregroundStyle(.tertiary)
                        .frame(width: 24)
                    Text("No branches monitored")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
                .accessibilityLabel("No branches are currently being monitored")
            } else {
                ForEach(preferences.monitoredBranches, id: \.self) { branch in
                    HStack(spacing: 10) {
                        Image(systemName: "arrow.triangle.branch")
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 24)
                        Text(branch)
                            .font(.body)
                        Spacer()
                    }
                    .accessibilityLabel("Monitored branch: \(branch)")
                }
                .onDelete(perform: deleteBranch)
            }

            Button {
                newBranchName = ""
                showAddBranchSheet = true
            } label: {
                Label("Add Branch", systemImage: "plus.circle.fill")
                    .font(.body)
            }
        } header: {
            HStack {
                Text("Monitored Branches")
                Spacer()
                Text("\(preferences.monitoredBranches.count)")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        } footer: {
            Text("You will receive alerts when these branches have consecutive CI failures exceeding your threshold.")
        }
    }

    // MARK: - Monitored Repos

    private var monitoredReposSection: some View {
        Section {
            if preferences.monitoredRepos.isEmpty {
                HStack(spacing: 10) {
                    Image(systemName: "folder")
                        .foregroundStyle(.tertiary)
                        .frame(width: 24)
                    Text("No repositories monitored")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
                .accessibilityLabel("No repositories are currently being monitored")
            } else {
                ForEach(preferences.monitoredRepos) { repo in
                    HStack(spacing: 10) {
                        Image(systemName: "folder.fill")
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(repo.name)
                                .font(.body)
                            Text(repo.owner)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                    .accessibilityLabel("Monitored repository: \(repo.displayName)")
                }
                .onDelete(perform: deleteRepo)
            }

            Button {
                newRepoOwner = "pytorch"
                newRepoName = ""
                showAddRepoSheet = true
            } label: {
                Label("Add Repository", systemImage: "plus.circle.fill")
                    .font(.body)
            }
        } header: {
            HStack {
                Text("Monitored Repositories")
                Spacer()
                Text("\(preferences.monitoredRepos.count)")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        } footer: {
            Text("Notifications will only fire for CI failures in these repositories.")
        }
    }

    // MARK: - Preview & Test

    private var previewSection: some View {
        Section {
            Button {
                showNotificationPreview = true
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "eye.fill")
                        .foregroundStyle(Color.accentColor)
                        .frame(width: 24)
                    Text("Preview Notifications")
                        .font(.body)
                        .foregroundStyle(.primary)
                }
            }
            .accessibilityHint("Shows example notifications based on your current settings")

            Button {
                sendTestNotification()
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "paperplane.fill")
                        .foregroundStyle(
                            (authorizationStatus != .authorized || !anyNotificationTypeEnabled)
                            ? .secondary
                            : Color.accentColor
                        )
                        .frame(width: 24)
                    Text("Send Test Notification")
                        .font(.body)
                        .foregroundStyle(.primary)
                    Spacer()
                    if showTestNotificationSent {
                        Label("Sent", systemImage: "checkmark.circle.fill")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(AppColors.success)
                            .transition(.opacity)
                    }
                }
            }
            .disabled(authorizationStatus != .authorized || !anyNotificationTypeEnabled)
            .accessibilityHint("Sends a sample notification to your device")
        } header: {
            Text("Preview & Testing")
        } footer: {
            if authorizationStatus != .authorized {
                Text("Enable push notifications to test and preview.")
            } else if !anyNotificationTypeEnabled {
                Text("Enable at least one notification type to send a test notification.")
            } else {
                Text("Preview shows what notifications will look like. Test sends a sample notification to your device.")
            }
        }
    }

    private var anyNotificationTypeEnabled: Bool {
        notifyOnCIFailures || notifyOnBuildCompletions || notifyOnRegressions
    }

    // MARK: - Add Branch Sheet

    private var addBranchSheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Branch name", text: $newBranchName)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Branch Name")
                } footer: {
                    Text("Enter the full branch name, e.g. \"main\" or \"viable/strict\".")
                }

                Section {
                    ForEach(suggestedBranches, id: \.self) { branch in
                        Button {
                            newBranchName = branch
                        } label: {
                            HStack {
                                Image(systemName: "arrow.triangle.branch")
                                    .foregroundStyle(.secondary)
                                    .frame(width: 20)
                                Text(branch)
                                    .foregroundStyle(.primary)
                                Spacer()
                                if preferences.monitoredBranches.contains(branch) {
                                    Text("Added")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .disabled(preferences.monitoredBranches.contains(branch))
                    }
                } header: {
                    Text("Suggestions")
                }
            }
            .navigationTitle("Add Branch")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showAddBranchSheet = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        addBranch()
                    }
                    .disabled(newBranchName.trimmingCharacters(in: .whitespaces).isEmpty)
                    .fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: - Notification Preview Sheet

    private var notificationPreviewSheet: some View {
        NavigationStack {
            List {
                if notifyOnCIFailures {
                    Section {
                        NotificationPreviewCard(
                            icon: "xmark.circle.fill",
                            iconColor: AppColors.failure,
                            title: "CI Blocked: viable/strict",
                            message: "\(preferences.failureThreshold) consecutive failing commits on viable/strict. Top failure: TestOnnxModelExport failing on linux-focal-py3.8-clang10 / test (default, 1, 5, linux.2xlarge)",
                            time: "now"
                        )
                    } header: {
                        Text("CI Failure Alert")
                    }
                }

                if notifyOnBuildCompletions {
                    Section {
                        NotificationPreviewCard(
                            icon: "checkmark.circle.fill",
                            iconColor: AppColors.success,
                            title: "Build Complete: pytorch/pytorch",
                            message: "PR #123456 build finished successfully on main branch. All 247 jobs passed in 45 minutes.",
                            time: "2m ago"
                        )
                    } header: {
                        Text("Build Completion")
                    }
                }

                if notifyOnRegressions {
                    Section {
                        NotificationPreviewCard(
                            icon: "exclamationmark.triangle.fill",
                            iconColor: .orange,
                            title: "Regression Detected: Performance",
                            message: "Model inference time increased 23% on nightly branch. Commit abc1234 may have introduced a performance regression.",
                            time: "1h ago"
                        )
                    } header: {
                        Text("Regression Alert")
                    }
                }

                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Delivery: \(frequency.displayName)", systemImage: "clock")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                        Label("Monitored: \(preferences.monitoredRepos.count) repos, \(preferences.monitoredBranches.count) branches", systemImage: "scope")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                        Label("Threshold: \(preferences.failureThreshold) consecutive failures", systemImage: "chart.line.downtrend.xyaxis")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                } header: {
                    Text("Current Settings")
                }
            }
            .navigationTitle("Notification Preview")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        showNotificationPreview = false
                    }
                    .fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.large])
    }

    // MARK: - Add Repo Sheet

    private var addRepoSheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Owner", text: $newRepoOwner)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Repository", text: $newRepoName)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Repository")
                } footer: {
                    Text("Enter the GitHub owner and repository name, e.g. \"pytorch\" and \"pytorch\".")
                }

                Section {
                    ForEach(HUDViewModel.repos) { repo in
                        Button {
                            newRepoOwner = repo.owner
                            newRepoName = repo.name
                        } label: {
                            HStack {
                                Image(systemName: "folder.fill")
                                    .foregroundStyle(.secondary)
                                    .frame(width: 20)
                                Text(repo.displayName)
                                    .foregroundStyle(.primary)
                                Spacer()
                                if preferences.monitoredRepos.contains(where: { $0.id == repo.id }) {
                                    Text("Added")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .disabled(preferences.monitoredRepos.contains(where: { $0.id == repo.id }))
                    }
                } header: {
                    Text("Suggestions")
                }
            }
            .navigationTitle("Add Repository")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        showAddRepoSheet = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        addRepo()
                    }
                    .disabled(
                        newRepoOwner.trimmingCharacters(in: .whitespaces).isEmpty ||
                        newRepoName.trimmingCharacters(in: .whitespaces).isEmpty
                    )
                    .fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: - Helpers

    private var suggestedBranches: [String] {
        ["main", "viable/strict", "nightly", "release/2.6", "release/2.5"]
    }

    private var authorizationStatusIcon: String {
        switch authorizationStatus {
        case .authorized: return "bell.badge.fill"
        case .denied: return "bell.slash.fill"
        case .provisional: return "bell.fill"
        case .ephemeral: return "bell.fill"
        case .notDetermined: return "bell"
        @unknown default: return "bell"
        }
    }

    private var authorizationStatusColor: Color {
        switch authorizationStatus {
        case .authorized: return AppColors.success
        case .denied: return AppColors.failure
        case .provisional, .ephemeral: return AppColors.pending
        case .notDetermined: return AppColors.neutral
        @unknown default: return AppColors.neutral
        }
    }

    private var authorizationStatusText: String {
        switch authorizationStatus {
        case .authorized: return "Notifications are enabled"
        case .denied: return "Notifications are disabled in iOS Settings"
        case .provisional: return "Provisional notifications enabled"
        case .ephemeral: return "Temporary notifications enabled"
        case .notDetermined: return "Not yet requested"
        @unknown default: return "Unknown status"
        }
    }

    private func refreshAuthorizationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorizationStatus = settings.authorizationStatus
    }

    private func savePreferences() {
        notificationManager.updatePreferences(preferences)
    }

    private func deleteBranch(at offsets: IndexSet) {
        preferences.monitoredBranches.remove(atOffsets: offsets)
        savePreferences()
    }

    private func deleteRepo(at offsets: IndexSet) {
        preferences.monitoredRepos.remove(atOffsets: offsets)
        savePreferences()
    }

    private func addBranch() {
        let trimmed = newBranchName.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !preferences.monitoredBranches.contains(trimmed) else { return }
        preferences.monitoredBranches.append(trimmed)
        savePreferences()
        showAddBranchSheet = false
    }

    private func addRepo() {
        let owner = newRepoOwner.trimmingCharacters(in: .whitespaces)
        let name = newRepoName.trimmingCharacters(in: .whitespaces)
        guard !owner.isEmpty, !name.isEmpty else { return }

        let config = RepoConfig(owner: owner, name: name)
        guard !preferences.monitoredRepos.contains(where: { $0.id == config.id }) else { return }

        preferences.monitoredRepos.append(config)
        savePreferences()
        showAddRepoSheet = false
    }

    private func sendTestNotification() {
        notificationManager.scheduleHUDFailureNotification(
            branch: "test/notification",
            consecutiveFailures: preferences.failureThreshold,
            failurePatterns: ["This is a test notification from TorchCI"]
        )
        withAnimation {
            showTestNotificationSent = true
        }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(3))
            withAnimation {
                showTestNotificationSent = false
            }
        }
    }

    private func openSystemSettings() {
        if let settingsURL = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(settingsURL)
        }
    }
}

// MARK: - Notification Frequency Enum

enum NotificationFrequency: String, Codable, CaseIterable {
    case immediate
    case hourlyDigest
    case dailyDigest

    var displayName: String {
        switch self {
        case .immediate: return "Immediate"
        case .hourlyDigest: return "Hourly Digest"
        case .dailyDigest: return "Daily Digest"
        }
    }

    var description: String {
        switch self {
        case .immediate: return "Notify as events occur"
        case .hourlyDigest: return "Batch notifications every hour"
        case .dailyDigest: return "Daily summary at 9:00 AM"
        }
    }

    var icon: String {
        switch self {
        case .immediate: return "bolt.fill"
        case .hourlyDigest: return "clock.fill"
        case .dailyDigest: return "calendar"
        }
    }
}

// MARK: - Notification Preview Card

struct NotificationPreviewCard: View {
    let icon: String
    let iconColor: Color
    let title: String
    let message: String
    let time: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(iconColor)
                .frame(width: 32)

            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Spacer()
                    Text(time)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }
}

#Preview("Settings View") {
    NavigationStack {
        NotificationSettingsView()
    }
    .environmentObject(NotificationManager.shared)
}

#Preview("Preview Sheet") {
    struct PreviewWrapper: View {
        @State private var showSheet = true

        var body: some View {
            Color.clear
                .sheet(isPresented: $showSheet) {
                    NavigationStack {
                        List {
                            Section {
                                NotificationPreviewCard(
                                    icon: "xmark.circle.fill",
                                    iconColor: AppColors.failure,
                                    title: "CI Blocked: viable/strict",
                                    message: "3 consecutive failing commits on viable/strict. Top failure: TestOnnxModelExport failing on linux",
                                    time: "now"
                                )
                            }
                        }
                        .navigationTitle("Preview")
                    }
                }
        }
    }
    return PreviewWrapper()
}
