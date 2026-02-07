import Foundation
import UserNotifications
import BackgroundTasks

@MainActor
final class NotificationManager: ObservableObject {
    static let shared = NotificationManager()

    @Published var isAuthorized = false
    @Published var preferences = NotificationPreferences.load()

    private let center = UNUserNotificationCenter.current()
    static let backgroundTaskID = "com.pytorch.torchci.hudmonitor"

    private init() {
        checkAuthorization()
    }

    func requestAuthorization() {
        Task { @MainActor in
            do {
                let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
                isAuthorized = granted
                if granted {
                    registerBackgroundTask()
                }
            } catch {
                isAuthorized = false
            }
        }
    }

    func checkAuthorization() {
        Task { @MainActor in
            let settings = await center.notificationSettings()
            isAuthorized = settings.authorizationStatus == .authorized
        }
    }

    func scheduleHUDFailureNotification(
        branch: String,
        consecutiveFailures: Int,
        failurePatterns: [String]
    ) {
        let content = UNMutableNotificationContent()
        content.title = "CI Blocked: \(branch)"
        content.body = "\(consecutiveFailures) consecutive failing commits on \(branch). Top failure: \(failurePatterns.first ?? "unknown")"
        content.sound = .default
        content.badge = NSNumber(value: consecutiveFailures)
        content.categoryIdentifier = "HUD_FAILURE"
        content.userInfo = [
            "branch": branch,
            "failures": consecutiveFailures,
        ]

        let request = UNNotificationRequest(
            identifier: "hud-failure-\(branch)-\(Date().timeIntervalSince1970)",
            content: content,
            trigger: nil // Deliver immediately
        )

        center.add(request)
    }

    func registerBackgroundTask() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.backgroundTaskID,
            using: .main
        ) { [weak self] task in
            guard let bgTask = task as? BGAppRefreshTask else { return }
            Task { @MainActor in
                self?.handleBackgroundTask(bgTask)
            }
        }
        scheduleBackgroundRefresh()
    }

    func scheduleBackgroundRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: Self.backgroundTaskID)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 5 * 60) // 5 minutes
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // Background task scheduling failed
        }
    }

    private func handleBackgroundTask(_ task: BGAppRefreshTask) {
        scheduleBackgroundRefresh() // Schedule next refresh

        let monitor = HUDMonitor()
        let currentPreferences = preferences

        task.expirationHandler = {
            Task { await monitor.cancel() }
        }

        Task { @MainActor [weak self] in
            await monitor.checkForFailures(preferences: currentPreferences) { [weak self] branch, count, patterns in
                Task { @MainActor in
                    self?.scheduleHUDFailureNotification(
                        branch: branch,
                        consecutiveFailures: count,
                        failurePatterns: patterns
                    )
                }
            }
            task.setTaskCompleted(success: true)
        }
    }

    func updatePreferences(_ prefs: NotificationPreferences) {
        preferences = prefs
        prefs.save()
    }
}

struct NotificationPreferences: Codable {
    var enabled: Bool = true
    var failureThreshold: Int = 3
    var monitoredBranches: [String] = ["viable/strict"]
    var monitoredRepos: [RepoConfig] = [
        RepoConfig(owner: "pytorch", name: "pytorch"),
    ]

    static func load() -> NotificationPreferences {
        guard let data = UserDefaults.standard.data(forKey: "notification_preferences"),
              let prefs = try? JSONDecoder().decode(NotificationPreferences.self, from: data)
        else {
            return NotificationPreferences()
        }
        return prefs
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) {
            UserDefaults.standard.set(data, forKey: "notification_preferences")
        }
    }
}

struct RepoConfig: Codable, Hashable, Identifiable {
    let owner: String
    let name: String

    var id: String { "\(owner)/\(name)" }
    var displayName: String { "\(owner)/\(name)" }
}
