import SwiftUI

@MainActor
final class ThemeManager: ObservableObject {
    static let shared = ThemeManager()

    @Published var themeMode: ThemeMode {
        didSet {
            UserDefaults.standard.set(themeMode.rawValue, forKey: "theme_mode")
        }
    }

    var colorScheme: ColorScheme? {
        switch themeMode {
        case .light: return .light
        case .dark: return .dark
        case .system: return nil
        }
    }

    private init() {
        let stored = UserDefaults.standard.string(forKey: "theme_mode") ?? "system"
        self.themeMode = ThemeMode(rawValue: stored) ?? .system
    }
}

enum ThemeMode: String, CaseIterable {
    case light, dark, system

    var displayName: String {
        switch self {
        case .light: return "Light"
        case .dark: return "Dark"
        case .system: return "System"
        }
    }

    var icon: String {
        switch self {
        case .light: return "sun.max"
        case .dark: return "moon"
        case .system: return "circle.lefthalf.filled"
        }
    }
}

// MARK: - App Colors
enum AppColors {
    static let success = Color(red: 45/255, green: 164/255, blue: 78/255)
    static let failure = Color(red: 207/255, green: 34/255, blue: 46/255)
    static let pending = Color(red: 191/255, green: 135/255, blue: 0)
    static let unstable = Color(red: 225/255, green: 111/255, blue: 36/255)
    static let skipped = Color(red: 139/255, green: 148/255, blue: 158/255)
    static let cancelled = Color(red: 170/255, green: 125/255, blue: 60/255)
    static let neutral = Color(red: 106/255, green: 115/255, blue: 125/255)
    static let classified = Color.purple.opacity(0.7)
    static let flaky = Color.green.opacity(0.5)

    static func forConclusion(_ conclusion: String?) -> Color {
        switch conclusion?.lowercased() {
        case "success": return success
        case "failure": return failure
        case "pending", "queued", "in_progress": return pending
        case "unstable": return unstable
        case "skipped": return skipped
        case "cancelled", "canceled", "time_out", "timed_out": return cancelled
        case "classified": return classified
        case "flaky": return flaky
        default: return neutral
        }
    }
}

// MARK: - Duration Formatting
enum DurationFormatter {
    /// Format seconds into a human-readable duration string.
    /// - Parameter seconds: The duration in seconds.
    /// - Parameter compact: If true, omits seconds for durations over 1 minute (e.g. "2h 15m").
    static func format(_ seconds: Int, compact: Bool = false) -> String {
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        let secs = seconds % 60
        if hours > 0 {
            if compact {
                return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h"
            }
            return "\(hours)h \(minutes)m"
        } else if minutes > 0 {
            if compact {
                return "\(minutes)m"
            }
            return "\(minutes)m \(secs)s"
        } else {
            return "\(secs)s"
        }
    }
}

// MARK: - App Typography
enum AppTypography {
    static let largeTitle = Font.largeTitle.weight(.bold)
    static let title = Font.title2.weight(.semibold)
    static let headline = Font.headline
    static let body = Font.body
    static let caption = Font.caption
    static let monospaced = Font.system(.body, design: .monospaced)
    static let monospacedSmall = Font.system(.caption, design: .monospaced)
}
