import SwiftUI

struct ModelPicker: View {
    let title: String
    let models: [String]
    @Binding var selectedModels: Set<String>
    var maxVisible: Int = 200

    @State private var searchText: String = ""
    @State private var isExpanded: Bool = false

    private var filteredModels: [String] {
        let sorted = models.sorted()
        if searchText.isEmpty {
            return Array(sorted.prefix(maxVisible))
        }
        let lowered = searchText.lowercased()
        return sorted.filter { $0.lowercased().contains(lowered) }
    }

    private var selectionSummary: String {
        if selectedModels.isEmpty || selectedModels.count == models.count {
            return "All (\(models.count))"
        }
        if selectedModels.count == 1, let first = selectedModels.first {
            return first
        }
        return "\(selectedModels.count) selected"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerButton
            if isExpanded {
                expandedContent
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: isExpanded)
    }

    // MARK: - Header

    private var headerButton: some View {
        Button {
            isExpanded.toggle()
        } label: {
            HStack {
                Label(title, systemImage: "cpu")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)

                Spacer()

                Text(selectionSummary)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Expanded Content

    private var expandedContent: some View {
        VStack(spacing: 8) {
            // Search
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                    .font(.caption)
                TextField("Search models...", text: $searchText)
                    .textFieldStyle(.plain)
                    .font(.subheadline)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                            .font(.caption)
                    }
                }
            }
            .padding(8)
            .background(Color(.systemGray6))
            .clipShape(RoundedRectangle(cornerRadius: 8))

            // Bulk actions
            HStack(spacing: 12) {
                Button("Select All") {
                    selectedModels = Set(models)
                }
                .font(.caption.weight(.medium))

                Button("Clear") {
                    selectedModels.removeAll()
                }
                .font(.caption.weight(.medium))

                Spacer()

                Text("\(filteredModels.count) models")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Model list
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(filteredModels, id: \.self) { model in
                        modelRow(model)
                    }
                }
            }
            .frame(maxHeight: 240)
        }
        .padding(12)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Model Row

    private func modelRow(_ model: String) -> some View {
        Button {
            if selectedModels.contains(model) {
                selectedModels.remove(model)
            } else {
                selectedModels.insert(model)
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: selectedModels.contains(model) ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selectedModels.contains(model) ? Color.accentColor : .secondary)
                    .font(.subheadline)

                Text(model)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                Spacer()
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
            .background(
                selectedModels.contains(model)
                    ? Color.accentColor.opacity(0.08)
                    : Color.clear
            )
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    ModelPicker(
        title: "Models",
        models: ["resnet50", "bert-base", "gpt2", "llama-7b", "vit-base"],
        selectedModels: .constant(Set(["resnet50", "bert-base"]))
    )
    .padding()
}
