import SwiftUI
import UserNotifications

@main
struct TorchCIApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    @StateObject private var authManager = AuthManager.shared
    @StateObject private var themeManager = ThemeManager.shared
    @StateObject private var notificationManager = NotificationManager.shared
    @StateObject private var deepLinkHandler = DeepLinkHandler.shared

    init() {
        configureAppearance()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(authManager)
                .environmentObject(themeManager)
                .environmentObject(notificationManager)
                .environmentObject(deepLinkHandler)
                .preferredColorScheme(themeManager.colorScheme)
                .onAppear {
                    notificationManager.requestAuthorization()
                    UNUserNotificationCenter.current().setBadgeCount(0, withCompletionHandler: nil)
                }
                .onOpenURL { url in
                    // OAuth callbacks are handled by AuthManager directly.
                    if let link = deepLinkHandler.parse(url: url),
                       case .oauthCallback = link {
                        // AuthManager handles this via ASWebAuthenticationSession;
                        // no further action needed here.
                        return
                    }
                    deepLinkHandler.handle(url: url)
                }
        }
    }

    private func configureAppearance() {
        let navAppearance = UINavigationBarAppearance()
        navAppearance.configureWithDefaultBackground()
        UINavigationBar.appearance().standardAppearance = navAppearance
        UINavigationBar.appearance().scrollEdgeAppearance = navAppearance

        let tabAppearance = UITabBarAppearance()
        tabAppearance.configureWithDefaultBackground()
        UITabBar.appearance().standardAppearance = tabAppearance
        UITabBar.appearance().scrollEdgeAppearance = tabAppearance
    }
}
