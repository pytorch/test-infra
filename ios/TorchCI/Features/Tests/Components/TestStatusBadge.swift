import SwiftUI

struct TestStatusBadge: View {
    let status: TestStatus

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: status.icon)
                .font(.caption2.weight(.semibold))
            Text(status.label)
                .font(.caption2.weight(.medium))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .foregroundStyle(status.color)
        .background(status.color.opacity(0.12))
        .clipShape(Capsule())
    }
}

enum TestStatus: String, CaseIterable {
    case passing
    case flaky
    case failing
    case disabled

    var label: String {
        rawValue.capitalized
    }

    var icon: String {
        switch self {
        case .passing: return "checkmark.circle.fill"
        case .flaky: return "exclamationmark.triangle.fill"
        case .failing: return "xmark.circle.fill"
        case .disabled: return "minus.circle.fill"
        }
    }

    var color: Color {
        switch self {
        case .passing: return AppColors.success
        case .flaky: return AppColors.unstable
        case .failing: return AppColors.failure
        case .disabled: return AppColors.skipped
        }
    }

    init(from statusString: String?) {
        switch statusString?.lowercased() {
        case "passing", "success":
            self = .passing
        case "flaky":
            self = .flaky
        case "failing", "failure":
            self = .failing
        case "disabled":
            self = .disabled
        default:
            self = .passing
        }
    }

    init(flakyRate: Double?) {
        guard let rate = flakyRate else {
            self = .passing
            return
        }
        if rate >= 0.5 {
            self = .failing
        } else if rate > 0.0 {
            self = .flaky
        } else {
            self = .passing
        }
    }
}

#Preview {
    VStack(spacing: 12) {
        TestStatusBadge(status: .passing)
        TestStatusBadge(status: .flaky)
        TestStatusBadge(status: .failing)
        TestStatusBadge(status: .disabled)
    }
    .padding()
}
