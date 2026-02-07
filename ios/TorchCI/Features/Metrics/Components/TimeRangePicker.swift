import SwiftUI

struct TimeRangePicker: View {
    @Binding var selectedRangeID: String
    var ranges: [TimeRange] = TimeRange.presets

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(ranges) { range in
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            selectedRangeID = range.id
                        }
                    } label: {
                        Text(range.label)
                            .font(.subheadline)
                            .fontWeight(selectedRangeID == range.id ? .semibold : .regular)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(
                                selectedRangeID == range.id
                                    ? Color.accentColor
                                    : Color(.systemGray5)
                            )
                            .foregroundStyle(
                                selectedRangeID == range.id ? .white : .primary
                            )
                            .clipShape(Capsule())
                    }
                }
            }
            .padding(.horizontal, 1)
        }
    }
}

#Preview {
    TimeRangePicker(selectedRangeID: .constant("7d"))
        .padding()
}
