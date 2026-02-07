import SwiftUI

struct StatusBadge: View {
    let conclusion: String?
    var size: BadgeSize = .medium
    var showLabel: Bool = false

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(AppColors.forConclusion(conclusion))
                .frame(width: size.dotSize, height: size.dotSize)

            if showLabel {
                Text(conclusion?.capitalized ?? "Unknown")
                    .font(size.font)
                    .foregroundStyle(AppColors.forConclusion(conclusion))
            }
        }
        .padding(.horizontal, showLabel ? 8 : 0)
        .padding(.vertical, showLabel ? 4 : 0)
        .background {
            if showLabel {
                Capsule()
                    .fill(AppColors.forConclusion(conclusion).opacity(0.15))
            }
        }
    }

    enum BadgeSize {
        case small, medium, large

        var dotSize: CGFloat {
            switch self {
            case .small: return 8
            case .medium: return 12
            case .large: return 16
            }
        }

        var font: Font {
            switch self {
            case .small: return .caption2
            case .medium: return .caption
            case .large: return .subheadline
            }
        }
    }
}

struct JobStatusIcon: View {
    let conclusion: String?

    var body: some View {
        Image(systemName: iconName)
            .foregroundStyle(AppColors.forConclusion(conclusion))
            .font(.system(size: 14, weight: .semibold))
    }

    private var iconName: String {
        switch conclusion?.lowercased() {
        case "success": return "checkmark.circle.fill"
        case "failure": return "xmark.circle.fill"
        case "pending", "queued", "in_progress": return "clock.fill"
        case "cancelled", "canceled": return "slash.circle.fill"
        case "skipped": return "minus.circle.fill"
        case "unstable": return "exclamationmark.triangle.fill"
        default: return "questionmark.circle"
        }
    }
}

#Preview {
    VStack(spacing: 20) {
        StatusBadge(conclusion: "success", showLabel: true)
        StatusBadge(conclusion: "failure", showLabel: true)
        StatusBadge(conclusion: "pending", showLabel: true)
        StatusBadge(conclusion: nil, size: .small)
    }
}
