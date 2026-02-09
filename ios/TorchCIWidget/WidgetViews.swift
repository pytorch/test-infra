import SwiftUI
import WidgetKit

// MARK: - Widget Colors (inline equivalents of AppColors for the extension target)

enum WidgetColors {
    static let success = Color(red: 45 / 255, green: 164 / 255, blue: 78 / 255)
    static let failure = Color(red: 207 / 255, green: 34 / 255, blue: 46 / 255)
    static let pending = Color(red: 191 / 255, green: 135 / 255, blue: 0)
    static let unstable = Color(red: 225 / 255, green: 111 / 255, blue: 36 / 255)
    static let neutral = Color(red: 106 / 255, green: 115 / 255, blue: 125 / 255)
    static let skipped = Color(red: 139 / 255, green: 148 / 255, blue: 158 / 255)
}

// MARK: - Small Widget View

struct SmallWidgetView: View {
    let entry: HUDStatusEntry

    private var commit: WidgetCommit? {
        entry.commits.first
    }

    private var hudURL: URL {
        URL(string: "torchci://hud/\(entry.configuration.repoOwner)/\(entry.configuration.repoName)/\(entry.configuration.branchName)")!
    }

    var body: some View {
        Group {
            if let commit {
                VStack(alignment: .leading, spacing: 8) {
                    headerRow

                    Spacer(minLength: 0)

                    commitStatusSection(commit)

                    Spacer(minLength: 0)

                    footerRow(commit)
                }
            } else if entry.isPlaceholder {
                placeholderContent
            } else {
                errorContent
            }
        }
        .widgetURL(hudURL)
    }

    private var headerRow: some View {
        HStack(spacing: 4) {
            Image(systemName: "server.rack")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
            Text(entry.branchDisplay)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer()
        }
    }

    private func commitStatusSection(_ commit: WidgetCommit) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle()
                    .fill(commit.overallStatus.color)
                    .frame(width: 28, height: 28)
                    .overlay {
                        Image(systemName: commit.overallStatus.iconName)
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(.white)
                    }

                VStack(alignment: .leading, spacing: 1) {
                    Text(commit.overallStatus.label)
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(commit.overallStatus.color)

                    Text(commit.shortSha)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }

            Text(commit.title)
                .font(.system(size: 11))
                .foregroundStyle(.primary)
                .lineLimit(2)
                .truncationMode(.tail)
        }
    }

    private func footerRow(_ commit: WidgetCommit) -> some View {
        HStack(spacing: 0) {
            Text(commit.relativeTime)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
            Spacer()
            if commit.totalJobs > 0 {
                jobCountPill(count: commit.passCount, color: WidgetColors.success)
                if commit.failCount > 0 {
                    jobCountPill(count: commit.failCount, color: WidgetColors.failure)
                }
            }
        }
    }

    private func jobCountPill(count: Int, color: Color) -> some View {
        HStack(spacing: 2) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text("\(count)")
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundStyle(color)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .background(color.opacity(0.12))
        .clipShape(Capsule())
    }

    private var placeholderContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            headerRow
            Spacer()
            HStack(spacing: 8) {
                Circle()
                    .fill(Color.gray.opacity(0.3))
                    .frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 4) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.gray.opacity(0.3))
                        .frame(width: 60, height: 12)
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.gray.opacity(0.2))
                        .frame(width: 50, height: 10)
                }
            }
            Spacer()
            RoundedRectangle(cornerRadius: 3)
                .fill(Color.gray.opacity(0.2))
                .frame(height: 10)
        }
        .redacted(reason: .placeholder)
    }

    private var errorContent: some View {
        VStack(spacing: 8) {
            headerRow
            Spacer()
            Image(systemName: "exclamationmark.icloud")
                .font(.system(size: 24))
                .foregroundStyle(.secondary)
            Text("Unable to load")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
            Spacer()
        }
    }
}

// MARK: - Medium Widget View

struct MediumWidgetView: View {
    let entry: HUDStatusEntry

    private var commits: [WidgetCommit] {
        Array(entry.commits.prefix(3))
    }

    private var hudURL: URL {
        URL(string: "torchci://hud/\(entry.configuration.repoOwner)/\(entry.configuration.repoName)/\(entry.configuration.branchName)")!
    }

    var body: some View {
        Group {
            if !commits.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    headerBar
                        .padding(.bottom, 8)

                    ForEach(Array(commits.enumerated()), id: \.element.id) { index, commit in
                        Link(destination: URL(string: "torchci://commit/\(commit.sha)")!) {
                            commitRow(commit)
                        }
                        if index < commits.count - 1 {
                            Divider()
                                .padding(.vertical, 3)
                        }
                    }

                    Spacer(minLength: 0)
                }
            } else if entry.isPlaceholder {
                mediumPlaceholder
            } else {
                mediumError
            }
        }
        .widgetURL(hudURL)
    }

    private var headerBar: some View {
        HStack(spacing: 6) {
            Image(systemName: "server.rack")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)

            Text(entry.repoDisplay)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.primary)

            Text("/")
                .font(.system(size: 11))
                .foregroundStyle(.quaternary)

            Text(entry.branchDisplay)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)

            Spacer()

            if !commits.isEmpty {
                overallHealthIndicator
            }
        }
    }

    private var overallHealthIndicator: some View {
        let failingCount = commits.filter { $0.overallStatus == .failure || $0.overallStatus == .mixed }.count
        let color: Color = failingCount == 0 ? WidgetColors.success : (failingCount == commits.count ? WidgetColors.failure : WidgetColors.unstable)
        let label = failingCount == 0 ? "Healthy" : "\(failingCount) issue\(failingCount == 1 ? "" : "s")"

        return HStack(spacing: 3) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(label)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(color)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(color.opacity(0.12))
        .clipShape(Capsule())
    }

    private func commitRow(_ commit: WidgetCommit) -> some View {
        HStack(spacing: 10) {
            // Status dot
            Circle()
                .fill(commit.overallStatus.color)
                .frame(width: 10, height: 10)

            // SHA
            Text(commit.shortSha)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(.primary)
                .frame(width: 58, alignment: .leading)

            // Commit title
            Text(commit.title)
                .font(.system(size: 11))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 4)

            // Job counts
            jobCountsView(commit)

            // Time
            Text(commit.relativeTime)
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
                .frame(width: 42, alignment: .trailing)
        }
    }

    private func jobCountsView(_ commit: WidgetCommit) -> some View {
        HStack(spacing: 6) {
            if commit.totalJobs > 0 {
                HStack(spacing: 2) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 7, weight: .bold))
                        .foregroundStyle(WidgetColors.success)
                    Text("\(commit.passCount)")
                        .font(.system(size: 9, weight: .semibold, design: .monospaced))
                        .foregroundStyle(WidgetColors.success)
                }

                if commit.failCount > 0 {
                    HStack(spacing: 2) {
                        Image(systemName: "xmark")
                            .font(.system(size: 7, weight: .bold))
                            .foregroundStyle(WidgetColors.failure)
                        Text("\(commit.failCount)")
                            .font(.system(size: 9, weight: .semibold, design: .monospaced))
                            .foregroundStyle(WidgetColors.failure)
                    }
                }

                if commit.pendingCount > 0 {
                    HStack(spacing: 2) {
                        Image(systemName: "clock")
                            .font(.system(size: 7, weight: .medium))
                            .foregroundStyle(WidgetColors.pending)
                        Text("\(commit.pendingCount)")
                            .font(.system(size: 9, weight: .semibold, design: .monospaced))
                            .foregroundStyle(WidgetColors.pending)
                    }
                }
            }
        }
    }

    private var mediumPlaceholder: some View {
        VStack(alignment: .leading, spacing: 8) {
            headerBar
            ForEach(0..<3, id: \.self) { _ in
                HStack(spacing: 10) {
                    Circle()
                        .fill(Color.gray.opacity(0.3))
                        .frame(width: 10, height: 10)
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.gray.opacity(0.25))
                        .frame(width: 58, height: 12)
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.gray.opacity(0.2))
                        .frame(height: 12)
                    Spacer()
                }
            }
            Spacer()
        }
        .redacted(reason: .placeholder)
    }

    private var mediumError: some View {
        VStack(spacing: 8) {
            headerBar
            Spacer()
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.icloud")
                    .font(.system(size: 20))
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Unable to load HUD data")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                    Text("Check your connection and try again")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
        }
    }
}

// MARK: - Large Widget View

struct LargeWidgetView: View {
    let entry: HUDStatusEntry

    private var commits: [WidgetCommit] {
        Array(entry.commits.prefix(5))
    }

    private var hudURL: URL {
        URL(string: "torchci://hud/\(entry.configuration.repoOwner)/\(entry.configuration.repoName)/\(entry.configuration.branchName)")!
    }

    var body: some View {
        Group {
            if !commits.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    headerSection
                        .padding(.bottom, 10)

                    summaryBar
                        .padding(.bottom, 10)

                    ForEach(Array(commits.enumerated()), id: \.element.id) { index, commit in
                        Link(destination: URL(string: "torchci://commit/\(commit.sha)")!) {
                            largeCommitRow(commit)
                        }
                        if index < commits.count - 1 {
                            Divider()
                                .padding(.vertical, 4)
                        }
                    }

                    Spacer(minLength: 0)
                }
            } else if entry.isPlaceholder {
                largePlaceholder
            } else {
                largeError
            }
        }
        .widgetURL(hudURL)
    }

    private var headerSection: some View {
        HStack(spacing: 6) {
            Image(systemName: "server.rack")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)

            Text(entry.repoDisplay)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.primary)

            Text(entry.branchDisplay)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.secondary.opacity(0.12))
                .clipShape(Capsule())

            Spacer()

            Text("Updated \(entry.date.formatted(.dateTime.hour().minute()))")
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
        }
    }

    private var summaryBar: some View {
        let totalPass = commits.reduce(0) { $0 + $1.passCount }
        let totalFail = commits.reduce(0) { $0 + $1.failCount }
        let totalPending = commits.reduce(0) { $0 + $1.pendingCount }
        let totalJobs = commits.reduce(0) { $0 + $1.totalJobs }

        let passRate: Double = totalJobs > 0 ? (Double(totalPass) / Double(totalJobs)) * 100 : 0

        return HStack(spacing: 12) {
            summaryPill(icon: "checkmark.circle.fill", label: "\(totalPass) passed", color: WidgetColors.success)
            summaryPill(icon: "xmark.circle.fill", label: "\(totalFail) failed", color: totalFail > 0 ? WidgetColors.failure : WidgetColors.neutral)
            summaryPill(icon: "clock.fill", label: "\(totalPending) pending", color: totalPending > 0 ? WidgetColors.pending : WidgetColors.neutral)
            Spacer()
            Text(String(format: "%.1f%% pass", passRate))
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(passRate >= 95 ? WidgetColors.success : (passRate >= 80 ? WidgetColors.unstable : WidgetColors.failure))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color(.secondarySystemBackground).opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func summaryPill(icon: String, label: String, color: Color) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon)
                .font(.system(size: 8))
                .foregroundStyle(color)
            Text(label)
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(color)
        }
    }

    private func largeCommitRow(_ commit: WidgetCommit) -> some View {
        HStack(spacing: 10) {
            // Status icon
            Image(systemName: commit.overallStatus.iconName)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(commit.overallStatus.color)
                .frame(width: 20)

            // Commit info
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(commit.shortSha)
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Color.accentColor)

                    if commit.isForcedMerge {
                        Text("FM")
                            .font(.system(size: 7, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(WidgetColors.unstable)
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }

                    Text("by \(commit.author)")
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)

                    Spacer()

                    Text(commit.relativeTime)
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                }

                Text(commit.title)
                    .font(.system(size: 11))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)

                // Job status bar
                HStack(spacing: 8) {
                    jobCountLabel(icon: "checkmark", count: commit.passCount, color: WidgetColors.success)

                    if commit.failCount > 0 {
                        jobCountLabel(icon: "xmark", count: commit.failCount, color: WidgetColors.failure)
                    }

                    if commit.pendingCount > 0 {
                        jobCountLabel(icon: "clock", count: commit.pendingCount, color: WidgetColors.pending)
                    }

                    Spacer()

                    // Mini progress bar
                    if commit.totalJobs > 0 {
                        miniProgressBar(commit: commit)
                    }
                }
            }
        }
    }

    private func jobCountLabel(icon: String, count: Int, color: Color) -> some View {
        HStack(spacing: 2) {
            Image(systemName: icon)
                .font(.system(size: 7, weight: .bold))
                .foregroundStyle(color)
            Text("\(count)")
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundStyle(color)
        }
    }

    private func miniProgressBar(commit: WidgetCommit) -> some View {
        GeometryReader { geo in
            let total = CGFloat(commit.totalJobs)
            let width = geo.size.width
            let passWidth = total > 0 ? (CGFloat(commit.passCount) / total) * width : 0
            let failWidth = total > 0 ? (CGFloat(commit.failCount) / total) * width : 0

            HStack(spacing: 0) {
                Rectangle()
                    .fill(WidgetColors.success)
                    .frame(width: passWidth)
                Rectangle()
                    .fill(WidgetColors.failure)
                    .frame(width: failWidth)
                Rectangle()
                    .fill(WidgetColors.pending.opacity(0.4))
            }
            .clipShape(Capsule())
        }
        .frame(width: 60, height: 4)
    }

    private var largePlaceholder: some View {
        VStack(alignment: .leading, spacing: 8) {
            headerSection
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.gray.opacity(0.15))
                .frame(height: 30)
            ForEach(0..<5, id: \.self) { _ in
                HStack(spacing: 10) {
                    Circle()
                        .fill(Color.gray.opacity(0.3))
                        .frame(width: 16, height: 16)
                    VStack(alignment: .leading, spacing: 4) {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(Color.gray.opacity(0.25))
                            .frame(height: 12)
                        RoundedRectangle(cornerRadius: 3)
                            .fill(Color.gray.opacity(0.2))
                            .frame(width: 200, height: 10)
                    }
                    Spacer()
                }
            }
            Spacer()
        }
        .redacted(reason: .placeholder)
    }

    private var largeError: some View {
        VStack(spacing: 12) {
            headerSection
            Spacer()
            VStack(spacing: 8) {
                Image(systemName: "exclamationmark.icloud")
                    .font(.system(size: 32))
                    .foregroundStyle(.secondary)
                Text("Unable to load HUD data")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.secondary)
                Text("Data will refresh automatically.\nCheck your network connection.")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            }
            Spacer()
        }
    }
}

// MARK: - Previews

#Preview("Small - Success") {
    SmallWidgetView(entry: HUDStatusEntry.placeholder)
        .frame(width: 170, height: 170)
        .containerBackground(.fill.tertiary, for: .widget)
}

#Preview("Medium - Commits") {
    MediumWidgetView(entry: HUDStatusEntry.placeholder)
        .frame(width: 364, height: 170)
        .containerBackground(.fill.tertiary, for: .widget)
}

#Preview("Large - Detail") {
    LargeWidgetView(entry: HUDStatusEntry.placeholder)
        .frame(width: 364, height: 382)
        .containerBackground(.fill.tertiary, for: .widget)
}
