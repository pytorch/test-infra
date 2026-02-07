import SwiftUI

struct ScalarPanel: View {
    let label: String
    let value: String
    var icon: String?
    var valueColor: Color = .primary
    var caption: String?

    var body: some View {
        VStack(spacing: 6) {
            if let icon {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }

            Text(value)
                .font(.title.bold())
                .foregroundStyle(valueColor)
                .minimumScaleFactor(0.6)
                .lineLimit(1)

            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            if let caption {
                Text(caption)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .padding(.horizontal, 8)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

#Preview {
    HStack {
        ScalarPanel(
            label: "Red Rate",
            value: "12.3%",
            icon: "exclamationmark.triangle",
            valueColor: .red
        )
        ScalarPanel(
            label: "Force Merges",
            value: "42",
            icon: "arrow.triangle.merge",
            valueColor: .orange
        )
        ScalarPanel(
            label: "TTS (p50)",
            value: "45m",
            icon: "clock",
            valueColor: .blue
        )
    }
    .padding()
}
