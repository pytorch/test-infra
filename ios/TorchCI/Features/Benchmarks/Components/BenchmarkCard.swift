import SwiftUI

struct BenchmarkCard: View {
    let benchmark: BenchmarkMetadata
    var showChevron: Bool = true

    nonisolated(unsafe) private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let isoFallbackFormatter = ISO8601DateFormatter()
    nonisolated(unsafe) private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    private var suitesText: String? {
        guard let suites = benchmark.suites, !suites.isEmpty else { return nil }
        if suites.count <= 3 {
            return suites.joined(separator: ", ")
        }
        return suites.prefix(3).joined(separator: ", ") + " +\(suites.count - 3) more"
    }

    private var lastUpdatedRelative: String? {
        guard let lastUpdated = benchmark.lastUpdated else { return nil }
        guard let date = Self.isoFormatter.date(from: lastUpdated)
                ?? Self.isoFallbackFormatter.date(from: lastUpdated) else {
            return lastUpdated
        }
        return Self.relativeFormatter.localizedString(for: date, relativeTo: Date())
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(benchmark.name)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                if let description = benchmark.description {
                    Text(description)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                HStack(spacing: 12) {
                    if let suitesText {
                        Label(suitesText, systemImage: "folder")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    if let lastUpdatedRelative {
                        Label(lastUpdatedRelative, systemImage: "clock")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Spacer(minLength: 0)

            if showChevron {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }
}

#Preview {
    VStack(spacing: 12) {
        BenchmarkCard(
            benchmark: BenchmarkMetadata(
                id: "1",
                name: "TorchInductor Benchmarks",
                description: "Compiler performance benchmarks for TorchInductor",
                suites: ["huggingface", "timm_models", "torchbench"],
                lastUpdated: nil
            )
        )

        BenchmarkCard(
            benchmark: BenchmarkMetadata(
                id: "2",
                name: "LLM Benchmarks",
                description: nil,
                suites: nil,
                lastUpdated: nil
            )
        )
    }
    .padding()
    .background(Color(.systemGroupedBackground))
}
