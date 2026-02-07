import SwiftUI

struct InfoCard<Content: View>: View {
    let title: String
    var icon: String?
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                if let icon {
                    Image(systemName: icon)
                        .foregroundStyle(.secondary)
                }
                Text(title)
                    .font(.headline)
            }

            content()
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }
}

struct MetricCard: View {
    let title: String
    let value: String
    var subtitle: String?
    var valueColor: Color = .primary
    var trend: Double?
    var trendIsGoodWhenNegative: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)

            Text(value)
                .font(.title2.bold())
                .foregroundStyle(valueColor)

            if let subtitle {
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            if let trend {
                HStack(spacing: 4) {
                    Image(systemName: trend >= 0 ? "arrow.up.right" : "arrow.down.right")
                    Text(String(format: "%.1f%%", abs(trend)))
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(trendColor(trend))
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func trendColor(_ trend: Double) -> Color {
        let isGood = trendIsGoodWhenNegative ? trend < 0 : trend > 0
        return isGood ? AppColors.success : AppColors.failure
    }
}

struct SectionHeader: View {
    let title: String
    var subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.title3.weight(.semibold))
            if let subtitle {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

#Preview {
    VStack(spacing: 16) {
        InfoCard(title: "Build Status", icon: "hammer") {
            Text("All clear")
        }

        MetricCard(
            title: "Red Rate",
            value: "12.3%",
            subtitle: "Last 7 days",
            trend: -2.1
        )
    }
    .padding()
}
