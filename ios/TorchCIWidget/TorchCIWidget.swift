import AppIntents
import SwiftUI
import WidgetKit

// MARK: - Timeline Entry

struct HUDStatusEntry: TimelineEntry {
    let date: Date
    let configuration: HUDWidgetIntent
    let commits: [WidgetCommit]
    let repoDisplay: String
    let branchDisplay: String
    let isPlaceholder: Bool

    static var placeholder: HUDStatusEntry {
        HUDStatusEntry(
            date: .now,
            configuration: HUDWidgetIntent(),
            commits: WidgetCommit.samples,
            repoDisplay: "pytorch/pytorch",
            branchDisplay: "main",
            isPlaceholder: true
        )
    }

    static func error(configuration: HUDWidgetIntent) -> HUDStatusEntry {
        HUDStatusEntry(
            date: .now,
            configuration: configuration,
            commits: [],
            repoDisplay: configuration.repositoryName,
            branchDisplay: configuration.branchName,
            isPlaceholder: false
        )
    }
}

// MARK: - Widget Commit Model

struct WidgetCommit: Identifiable {
    let id: String
    let sha: String
    let shortSha: String
    let title: String
    let author: String
    let relativeTime: String
    let overallStatus: CommitStatus
    let passCount: Int
    let failCount: Int
    let pendingCount: Int
    let totalJobs: Int
    let isForcedMerge: Bool

    enum CommitStatus {
        case success
        case failure
        case mixed
        case pending
        case unknown

        var color: Color {
            switch self {
            case .success: return WidgetColors.success
            case .failure: return WidgetColors.failure
            case .mixed: return WidgetColors.unstable
            case .pending: return WidgetColors.pending
            case .unknown: return WidgetColors.neutral
            }
        }

        var iconName: String {
            switch self {
            case .success: return "checkmark.circle.fill"
            case .failure: return "xmark.circle.fill"
            case .mixed: return "exclamationmark.triangle.fill"
            case .pending: return "clock.fill"
            case .unknown: return "questionmark.circle"
            }
        }

        var label: String {
            switch self {
            case .success: return "Passing"
            case .failure: return "Failing"
            case .mixed: return "Mixed"
            case .pending: return "Pending"
            case .unknown: return "Unknown"
            }
        }
    }

    static var samples: [WidgetCommit] {
        [
            WidgetCommit(
                id: "abc1234", sha: "abc1234567890", shortSha: "abc1234",
                title: "Update CUDA runtime version to 12.4",
                author: "pytorchbot", relativeTime: "12m ago",
                overallStatus: .success,
                passCount: 142, failCount: 0, pendingCount: 3, totalJobs: 145,
                isForcedMerge: false
            ),
            WidgetCommit(
                id: "def5678", sha: "def5678901234", shortSha: "def5678",
                title: "Fix flaky test in distributed training",
                author: "contributor", relativeTime: "47m ago",
                overallStatus: .mixed,
                passCount: 130, failCount: 2, pendingCount: 10, totalJobs: 142,
                isForcedMerge: false
            ),
            WidgetCommit(
                id: "ghi9012", sha: "ghi9012345678", shortSha: "ghi9012",
                title: "Implement new autograd function for sparse ops",
                author: "coredev", relativeTime: "1h ago",
                overallStatus: .failure,
                passCount: 120, failCount: 8, pendingCount: 0, totalJobs: 128,
                isForcedMerge: true
            ),
            WidgetCommit(
                id: "jkl3456", sha: "jkl3456789012", shortSha: "jkl3456",
                title: "Refactor memory allocator for improved throughput",
                author: "engineer", relativeTime: "2h ago",
                overallStatus: .success,
                passCount: 145, failCount: 0, pendingCount: 0, totalJobs: 145,
                isForcedMerge: false
            ),
            WidgetCommit(
                id: "mno7890", sha: "mno7890123456", shortSha: "mno7890",
                title: "Add support for bfloat16 in custom kernels",
                author: "researcher", relativeTime: "3h ago",
                overallStatus: .success,
                passCount: 144, failCount: 0, pendingCount: 1, totalJobs: 145,
                isForcedMerge: false
            ),
        ]
    }
}

// MARK: - App Intent for Configuration

struct HUDWidgetIntent: WidgetConfigurationIntent {
    nonisolated static let title: LocalizedStringResource = "HUD Configuration"
    nonisolated static let description: IntentDescription = "Choose which repository and branch to monitor."

    @Parameter(title: "Repository", default: .pytorchPytorch)
    var repository: WidgetRepository

    @Parameter(title: "Branch", default: .main)
    var branch: WidgetBranch

    var repositoryName: String {
        repository.displayName
    }

    var branchName: String {
        branch.rawValue
    }

    var repoOwner: String {
        repository.owner
    }

    var repoName: String {
        repository.name
    }
}

enum WidgetRepository: String, AppEnum, CaseIterable {
    case pytorchPytorch = "pytorch/pytorch"
    case pytorchVision = "pytorch/vision"
    case pytorchAudio = "pytorch/audio"
    case pytorchExecutorch = "pytorch/executorch"
    case pytorchHelion = "pytorch/helion"

    static var typeDisplayRepresentation: TypeDisplayRepresentation {
        "Repository"
    }

    static var caseDisplayRepresentations: [WidgetRepository: DisplayRepresentation] {
        [
            .pytorchPytorch: "pytorch/pytorch",
            .pytorchVision: "pytorch/vision",
            .pytorchAudio: "pytorch/audio",
            .pytorchExecutorch: "pytorch/executorch",
            .pytorchHelion: "pytorch/helion",
        ]
    }

    var displayName: String { rawValue }

    var owner: String {
        String(rawValue.split(separator: "/").first ?? "pytorch")
    }

    var name: String {
        String(rawValue.split(separator: "/").last ?? "pytorch")
    }
}

enum WidgetBranch: String, AppEnum, CaseIterable {
    case main = "main"
    case viableStrict = "viable/strict"
    case nightly = "nightly"

    static var typeDisplayRepresentation: TypeDisplayRepresentation {
        "Branch"
    }

    static var caseDisplayRepresentations: [WidgetBranch: DisplayRepresentation] {
        [
            .main: "main",
            .viableStrict: "viable/strict",
            .nightly: "nightly",
        ]
    }
}

// MARK: - Widget Definition

struct TorchCIWidget: Widget {
    let kind: String = "TorchCIWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: kind,
            intent: HUDWidgetIntent.self,
            provider: HUDStatusProvider()
        ) { entry in
            TorchCIWidgetEntryView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("CI HUD Status")
        .description("Monitor PyTorch CI commit status at a glance.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
        .contentMarginsDisabled()
    }
}

// MARK: - Entry View (routes to size-specific views)

struct TorchCIWidgetEntryView: View {
    @Environment(\.widgetFamily) var family
    let entry: HUDStatusEntry

    var body: some View {
        switch family {
        case .systemSmall:
            SmallWidgetView(entry: entry)
                .padding(16)
        case .systemMedium:
            MediumWidgetView(entry: entry)
                .padding(16)
        case .systemLarge:
            LargeWidgetView(entry: entry)
                .padding(16)
        default:
            SmallWidgetView(entry: entry)
                .padding(16)
        }
    }
}

// MARK: - Previews

#Preview("Small", as: .systemSmall) {
    TorchCIWidget()
} timeline: {
    HUDStatusEntry.placeholder
}

#Preview("Medium", as: .systemMedium) {
    TorchCIWidget()
} timeline: {
    HUDStatusEntry.placeholder
}

#Preview("Large", as: .systemLarge) {
    TorchCIWidget()
} timeline: {
    HUDStatusEntry.placeholder
}
