import UIKit
import UserNotifications
import BackgroundTasks

/// UIApplicationDelegate implementation for TorchCI.
///
/// Responsibilities:
/// - Register for remote (push) notifications via APNs.
/// - Forward the device token to the backend for push delivery.
/// - Handle notification taps by routing payloads through ``DeepLinkHandler``.
/// - Register the background app refresh task for CI monitoring.
///
/// Wire this into the SwiftUI lifecycle via `@UIApplicationDelegateAdaptor` in ``TorchCIApp``.
final class AppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {

    // MARK: - Constants

    private static let deviceTokenKey = "apns_device_token"
    private static let backgroundFetchTaskID = NotificationManager.backgroundTaskID

    // MARK: - Application Lifecycle

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Set ourselves as the UNUserNotificationCenter delegate so we can
        // intercept notification taps and foreground presentation.
        UNUserNotificationCenter.current().delegate = self

        // Register notification categories for actionable notifications.
        registerNotificationCategories()

        // Register the background fetch task identifier.
        registerBackgroundTasks()

        // If the app was launched from a notification tap, handle it.
        if let remoteNotification = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
            Task { @MainActor in
                DeepLinkHandler.shared.handle(notificationUserInfo: remoteNotification)
            }
        }

        return true
    }

    // MARK: - Remote Notification Registration

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let tokenString = deviceToken.map { String(format: "%02x", $0) }.joined()

        // Store locally for reference.
        UserDefaults.standard.set(tokenString, forKey: Self.deviceTokenKey)

        // Forward to backend.
        Task {
            await registerDeviceToken(tokenString)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Non-fatal: local notifications and background fetch still work.
        print("[TorchCI] Failed to register for remote notifications: \(error.localizedDescription)")
    }

    // MARK: - Silent Push / Background Notification

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        // Check if this is a silent push for background data refresh.
        if let contentAvailable = userInfo["content-available"] as? Int, contentAvailable == 1 {
            Task {
                await performBackgroundHUDCheck()
                completionHandler(.newData)
            }
            return
        }

        // Otherwise treat as a notification with data.
        Task { @MainActor in
            DeepLinkHandler.shared.handle(notificationUserInfo: userInfo)
        }
        completionHandler(.noData)
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Called when a notification is delivered while the app is in the foreground.
    /// We show it as a banner so the user is still aware of CI failures.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .badge, .sound])
    }

    /// Called when the user taps a notification (foreground or background).
    /// Route the payload through ``DeepLinkHandler`` to navigate in-app.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let actionIdentifier = response.actionIdentifier

        Task { @MainActor in
            switch actionIdentifier {
            case UNNotificationDefaultActionIdentifier:
                // Standard tap -- navigate to the relevant page.
                DeepLinkHandler.shared.handle(notificationUserInfo: userInfo)

            case "VIEW_HUD_ACTION":
                // Custom action: go to HUD for the branch that triggered the alert.
                let branch = userInfo["branch"] as? String ?? "main"
                let repoOwner = userInfo["repoOwner"] as? String ?? "pytorch"
                let repoName = userInfo["repoName"] as? String ?? "pytorch"
                let link = DeepLink.hud(repoOwner: repoOwner, repoName: repoName, branch: branch)
                DeepLinkHandler.shared.pendingDeepLink = link

            case "VIEW_COMMIT_ACTION":
                // Custom action: go to the specific failing commit.
                if let sha = userInfo["sha"] as? String {
                    let repoOwner = userInfo["repoOwner"] as? String ?? "pytorch"
                    let repoName = userInfo["repoName"] as? String ?? "pytorch"
                    let link = DeepLink.commit(repoOwner: repoOwner, repoName: repoName, sha: sha)
                    DeepLinkHandler.shared.pendingDeepLink = link
                } else {
                    DeepLinkHandler.shared.handle(notificationUserInfo: userInfo)
                }

            case "MUTE_BRANCH_ACTION":
                // Custom action: mute notifications for this branch.
                if let branch = userInfo["branch"] as? String {
                    muteBranch(branch)
                }

            case UNNotificationDismissActionIdentifier:
                // User dismissed -- no action needed.
                break

            default:
                // Unknown action -- fall back to general handling.
                DeepLinkHandler.shared.handle(notificationUserInfo: userInfo)
            }
        }

        completionHandler()
    }

    // MARK: - Notification Categories

    /// Register actionable notification categories.
    /// These provide quick-action buttons on the notification banner/lock screen.
    private func registerNotificationCategories() {
        let viewHUDAction = UNNotificationAction(
            identifier: "VIEW_HUD_ACTION",
            title: "View HUD",
            options: [.foreground]
        )

        let viewCommitAction = UNNotificationAction(
            identifier: "VIEW_COMMIT_ACTION",
            title: "View Commit",
            options: [.foreground]
        )

        let muteAction = UNNotificationAction(
            identifier: "MUTE_BRANCH_ACTION",
            title: "Mute Branch",
            options: [.destructive]
        )

        let hudFailureCategory = UNNotificationCategory(
            identifier: "HUD_FAILURE",
            actions: [viewHUDAction, viewCommitAction, muteAction],
            intentIdentifiers: [],
            hiddenPreviewsBodyPlaceholder: "CI failures detected",
            categorySummaryFormat: "%u branches with failures",
            options: [.customDismissAction]
        )

        let prUpdateCategory = UNNotificationCategory(
            identifier: "PR_UPDATE",
            actions: [
                UNNotificationAction(
                    identifier: "VIEW_PR_ACTION",
                    title: "View PR",
                    options: [.foreground]
                ),
            ],
            intentIdentifiers: [],
            options: []
        )

        let flambeauCategory = UNNotificationCategory(
            identifier: "FLAMBEAU_SHARE",
            actions: [
                UNNotificationAction(
                    identifier: "VIEW_SESSION_ACTION",
                    title: "Open Session",
                    options: [.foreground]
                ),
            ],
            intentIdentifiers: [],
            options: []
        )

        UNUserNotificationCenter.current().setNotificationCategories([
            hudFailureCategory,
            prUpdateCategory,
            flambeauCategory,
        ])
    }

    // MARK: - Background Task Registration

    private func registerBackgroundTasks() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.backgroundFetchTaskID,
            using: nil
        ) { task in
            guard let refreshTask = task as? BGAppRefreshTask else { return }
            self.handleBackgroundFetchTask(refreshTask)
        }
        scheduleNextBackgroundFetch()
    }

    private func handleBackgroundFetchTask(_ task: BGAppRefreshTask) {
        // Schedule the next refresh immediately so we never lose the chain.
        scheduleNextBackgroundFetch()

        let monitor = HUDMonitor()

        task.expirationHandler = {
            monitor.cancel()
        }

        Task {
            let preferences = await MainActor.run { NotificationManager.shared.preferences }
            await monitor.checkForFailures(preferences: preferences) { branch, count, patterns in
                Task { @MainActor in
                    NotificationManager.shared.scheduleHUDFailureNotification(
                        branch: branch,
                        consecutiveFailures: count,
                        failurePatterns: patterns
                    )
                }
            }
            task.setTaskCompleted(success: true)
        }
    }

    private func scheduleNextBackgroundFetch() {
        let request = BGAppRefreshTaskRequest(identifier: Self.backgroundFetchTaskID)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 5 * 60) // 5 minutes
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            print("[TorchCI] Failed to schedule background fetch: \(error.localizedDescription)")
        }
    }

    // MARK: - Device Token Registration

    /// Send the APNs device token to the TorchCI backend so it can target this device
    /// with push notifications for CI failure alerts.
    private func registerDeviceToken(_ token: String) async {
        let endpoint = APIEndpoint(
            path: "/api/notifications/register",
            method: .POST,
            body: try? JSONSerialization.data(withJSONObject: [
                "token": token,
                "platform": "ios",
                "bundleId": Bundle.main.bundleIdentifier ?? "com.pytorch.torchci",
            ])
        )

        do {
            let _: Data = try await APIClient.shared.fetchRaw(endpoint)
        } catch {
            // Non-fatal. The device will rely on local notifications and background fetch.
            print("[TorchCI] Failed to register device token: \(error.localizedDescription)")
        }
    }

    // MARK: - Branch Muting

    /// Remove a branch from the monitored list so future notifications for it are suppressed.
    private func muteBranch(_ branch: String) {
        Task { @MainActor in
            var prefs = NotificationManager.shared.preferences
            prefs.monitoredBranches.removeAll { $0 == branch }
            NotificationManager.shared.updatePreferences(prefs)
        }
    }

    // MARK: - Background HUD Check (via silent push)

    /// Perform a background check triggered by a silent push notification.
    private func performBackgroundHUDCheck() async {
        let preferences = await MainActor.run { NotificationManager.shared.preferences }
        let monitor = HUDMonitor()

        await monitor.checkForFailures(preferences: preferences) { branch, count, patterns in
            Task { @MainActor in
                NotificationManager.shared.scheduleHUDFailureNotification(
                    branch: branch,
                    consecutiveFailures: count,
                    failurePatterns: patterns
                )
            }
        }
    }
}

// MARK: - Push Notification Registration Helper

extension AppDelegate {
    /// Request push notification permission and register with APNs.
    /// Call this after the user has granted local notification authorization.
    @MainActor
    static func registerForPushNotifications() {
        UIApplication.shared.registerForRemoteNotifications()
    }
}
