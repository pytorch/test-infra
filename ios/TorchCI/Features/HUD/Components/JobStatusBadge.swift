import SwiftUI

struct JobStatusBadge: View {
    let conclusion: String?
    let isUnstable: Bool
    var showLabel: Bool = true

    init(conclusion: String?, isUnstable: Bool = false, showLabel: Bool = true) {
        self.conclusion = isUnstable ? "unstable" : conclusion
        self.isUnstable = isUnstable
        self.showLabel = showLabel
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: iconName)
                .font(.system(size: showLabel ? 14 : 12, weight: .semibold))
                .foregroundStyle(statusColor)

            if showLabel {
                Text(displayLabel)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(statusColor)
            }
        }
        .padding(.horizontal, showLabel ? 10 : 4)
        .padding(.vertical, showLabel ? 6 : 4)
        .background(statusColor.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private var statusColor: Color {
        AppColors.forConclusion(conclusion)
    }

    private var displayLabel: String {
        switch conclusion?.lowercased() {
        case "success": return "Success"
        case "failure": return "Failed"
        case "pending", "queued", "in_progress": return "Pending"
        case "unstable": return "Unstable"
        case "skipped": return "Skipped"
        case "cancelled", "canceled": return "Cancelled"
        default: return "Unknown"
        }
    }

    private var iconName: String {
        switch conclusion?.lowercased() {
        case "success": return "checkmark.circle.fill"
        case "failure": return "xmark.circle.fill"
        case "pending", "queued", "in_progress": return "clock.fill"
        case "unstable": return "exclamationmark.triangle.fill"
        case "skipped": return "minus.circle.fill"
        case "cancelled", "canceled": return "slash.circle.fill"
        default: return "questionmark.circle"
        }
    }
}

#Preview {
    VStack(spacing: 12) {
        JobStatusBadge(conclusion: "success")
        JobStatusBadge(conclusion: "failure")
        JobStatusBadge(conclusion: "pending")
        JobStatusBadge(conclusion: nil, isUnstable: true)
        JobStatusBadge(conclusion: "skipped")
        JobStatusBadge(conclusion: nil, showLabel: false)
    }
    .padding()
}
