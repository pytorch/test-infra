import SwiftUI

struct GranularityPicker: View {
    @Binding var selection: TimeGranularity

    var body: some View {
        Picker("Granularity", selection: $selection) {
            ForEach(TimeGranularity.allCases, id: \.self) { granularity in
                Text(granularity.displayName).tag(granularity)
            }
        }
        .pickerStyle(.segmented)
    }
}

#Preview {
    GranularityPicker(selection: .constant(.day))
        .padding()
}
