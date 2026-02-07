import SwiftUI

struct SegmentedPicker<T: Hashable & CustomStringConvertible>: View {
    let options: [T]
    @Binding var selection: T
    var compact: Bool = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: compact ? 4 : 8) {
                ForEach(options, id: \.self) { option in
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            selection = option
                        }
                    } label: {
                        Text(option.description)
                            .font(compact ? .caption : .subheadline)
                            .fontWeight(selection == option ? .semibold : .regular)
                            .padding(.horizontal, compact ? 10 : 14)
                            .padding(.vertical, compact ? 6 : 8)
                            .background(
                                selection == option
                                    ? Color.accentColor
                                    : Color(.systemGray5)
                            )
                            .foregroundStyle(
                                selection == option ? .white : .primary
                            )
                            .clipShape(Capsule())
                    }
                }
            }
            .padding(.horizontal, 1)
        }
    }
}
