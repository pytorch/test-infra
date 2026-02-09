import SwiftUI

struct HUDGridView: View {
    let rows: [HUDRow]
    let allJobs: [[HUDJob]]
    let jobNames: [String]
    let repoOwner: String
    let repoName: String
    var isLoadingMore: Bool = false
    var onJobTap: ((HUDJob, String) -> Void)?
    var onCommitTap: ((HUDRow) -> Void)?
    var onCommitRowTap: ((HUDRow) -> Void)?
    var onPRTap: ((Int) -> Void)?
    var onLoadMore: (() -> Void)?

    var body: some View {
        if rows.isEmpty {
            emptyGridState
        } else {
            gridContent
        }
    }

    // MARK: - Empty State
    private var emptyGridState: some View {
        VStack(spacing: 16) {
            Image(systemName: "tray")
                .font(.system(size: 48))
                .foregroundStyle(.tertiary)

            Text("No commits to display")
                .font(.headline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    // MARK: - Grid Content
    private var gridContent: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    commitRow(row: row, index: index)
                        .onAppear {
                            if index >= rows.count - 5 {
                                onLoadMore?()
                            }
                        }
                    if index < rows.count - 1 {
                        Divider()
                    }
                }

                if isLoadingMore {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Loading more commits...")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                }
            }
        }
    }

    // MARK: - Job Stats for a Row

    private struct RowJobStats {
        let successCount: Int
        let flakyCount: Int
        let newFailureCount: Int
        let repeatFailureCount: Int
        let unstableFailureCount: Int
        let blockingFailureCount: Int
        let pendingCount: Int
        let totalRealJobs: Int
        let maxDurationS: Int?
        let maxQueueTimeS: Int?

        var totalFailures: Int { newFailureCount + repeatFailureCount + unstableFailureCount }
    }

    private func computeStats(for jobs: [HUDJob]) -> RowJobStats {
        var success = 0, flaky = 0, newFail = 0, repeatFail = 0, unstableFail = 0, blocking = 0, pending = 0, real = 0
        var maxDur: Int?
        var maxQueue: Int?
        for (jobIndex, job) in jobs.enumerated() {
            if job.isEmpty { continue }
            real += 1
            let jobName = jobIndex < jobNames.count ? jobNames[jobIndex] : ""
            if let d = job.durationS {
                maxDur = max(maxDur ?? 0, d)
            }
            if let q = job.queueTimeS {
                maxQueue = max(maxQueue ?? 0, q)
            }
            if job.isFlaky {
                flaky += 1
            } else if job.isSuccess {
                success += 1
            } else if job.isFailure {
                if job.isUnstable {
                    unstableFail += 1
                } else if job.isRepeatFailure {
                    repeatFail += 1
                } else {
                    newFail += 1
                }
                if HUDJob.isBlockingName(jobName) && !job.isUnstable {
                    blocking += 1
                }
            } else if job.isPending {
                pending += 1
            }
        }
        return RowJobStats(
            successCount: success,
            flakyCount: flaky,
            newFailureCount: newFail,
            repeatFailureCount: repeatFail,
            unstableFailureCount: unstableFail,
            blockingFailureCount: blocking,
            pendingCount: pending,
            totalRealJobs: real,
            maxDurationS: maxDur,
            maxQueueTimeS: maxQueue
        )
    }

    // MARK: - Commit Row
    private func commitRow(row: HUDRow, index: Int) -> some View {
        let jobsForRow = index < allJobs.count ? allJobs[index] : row.jobs
        let stats = computeStats(for: jobsForRow)

        return Button {
            onCommitRowTap?(row)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    avatarView(for: row)

                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) {
                            Text(row.shortSha)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(Color.accentColor)

                            if row.isAutoreverted == true {
                                HStack(spacing: 2) {
                                    Image(systemName: "arrow.uturn.backward")
                                        .font(.system(size: 7, weight: .bold))
                                    Text("reverted")
                                        .font(.system(size: 8, weight: .bold))
                                }
                                .foregroundStyle(.white)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 2)
                                .background(Color.orange)
                                .clipShape(RoundedRectangle(cornerRadius: 3))
                            }

                            if row.isForcedMerge == true {
                                Text("FM")
                                    .font(.system(size: 8, weight: .bold))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 2)
                                    .background(row.isForcedMergeWithFailures == true ? Color.orange : AppColors.unstable)
                                    .clipShape(RoundedRectangle(cornerRadius: 3))
                            }

                            if let pr = row.prNumber {
                                Text("#\(pr)")
                                    .font(.caption.weight(.medium))
                                    .foregroundStyle(Color.accentColor)
                            }

                            Spacer()

                            Text(row.relativeTime)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }

                        Text(row.commitTitle ?? "No title")
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                            .lineLimit(2)
                    }

                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }

                // Job status bar (proportional segments, only real jobs)
                if stats.totalRealJobs > 0 {
                    statusBar(stats: stats)

                    HStack(spacing: 4) {
                        jobBadges(stats: stats)
                        Spacer()
                        timingBadges(stats: stats)
                        Text("\(stats.totalRealJobs) jobs")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            row.isAutoreverted == true
                ? Color(.systemGray4).opacity(0.3)
                : (index % 2 == 0 ? Color(.systemBackground) : Color(.systemGray6).opacity(0.3))
        )
    }

    // MARK: - Status Bar

    private func statusBar(stats: RowJobStats) -> some View {
        let nonBlockingFails = max(0, stats.newFailureCount + stats.repeatFailureCount - stats.blockingFailureCount)
        let segments: [(Color, Int)] = [
            (AppColors.success, stats.successCount),
            (Color.green.opacity(0.5), stats.flakyCount),
            (AppColors.failure, stats.blockingFailureCount),
            (Color.red.opacity(0.5), nonBlockingFails),
            (AppColors.unstable, stats.unstableFailureCount),
            (AppColors.pending, stats.pendingCount),
        ].filter { $0.1 > 0 }
        let segmentTotal = segments.reduce(0) { $0 + $1.1 }

        return GeometryReader { geometry in
            let totalWidth = geometry.size.width
            let spacing: CGFloat = CGFloat(max(0, segments.count - 1)) * 0.5
            let available = totalWidth - spacing

            HStack(spacing: 0.5) {
                ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                    Rectangle()
                        .fill(segment.0)
                        .frame(width: max(2, available * CGFloat(segment.1) / CGFloat(segmentTotal)))
                }
            }
        }
        .frame(height: 5)
        .clipShape(RoundedRectangle(cornerRadius: 2))
    }

    // MARK: - Job Badges

    private func jobBadges(stats: RowJobStats) -> some View {
        HStack(spacing: 3) {
            if stats.blockingFailureCount > 0 {
                miniCountBadge(count: stats.blockingFailureCount, color: AppColors.failure, label: "blocking")
            }
            if stats.newFailureCount - stats.blockingFailureCount > 0 {
                miniCountBadge(count: stats.newFailureCount - stats.blockingFailureCount, color: AppColors.failure.opacity(0.7), label: "new")
            }
            if stats.repeatFailureCount > 0 {
                miniCountBadge(count: stats.repeatFailureCount, color: Color(.systemGray2), label: "known")
            }
            if stats.unstableFailureCount > 0 {
                miniCountBadge(count: stats.unstableFailureCount, color: AppColors.unstable, label: "unstable")
            }
            if stats.flakyCount > 0 {
                miniCountBadge(count: stats.flakyCount, color: Color.green.opacity(0.7), label: "flaky")
            }
            if stats.pendingCount > 0 {
                miniCountBadge(count: stats.pendingCount, color: AppColors.pending, label: nil)
            }
            if stats.totalFailures == 0 && stats.pendingCount == 0 && stats.successCount > 0 {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(AppColors.success)
            }
        }
    }

    private func miniCountBadge(count: Int, color: Color, label: String?) -> some View {
        HStack(spacing: 2) {
            Text("\(count)")
                .font(.system(size: 9, weight: .bold))
            if let label {
                Text(label)
                    .font(.system(size: 8))
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .background(color)
        .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    // MARK: - Timing Badges

    private func timingBadges(stats: RowJobStats) -> some View {
        HStack(spacing: 3) {
            if let dur = stats.maxDurationS {
                timingLabel(icon: "clock", text: formatDuration(dur))
            }
            if let queue = stats.maxQueueTimeS, queue > 60 {
                timingLabel(icon: "hourglass", text: formatDuration(queue))
            }
        }
    }

    private func timingLabel(icon: String, text: String) -> some View {
        HStack(spacing: 2) {
            Image(systemName: icon)
                .font(.system(size: 7))
            Text(text)
                .font(.system(size: 8))
        }
        .foregroundStyle(.secondary)
    }

    private func formatDuration(_ seconds: Int) -> String {
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        if hours > 0 {
            return "\(hours)h\(minutes > 0 ? " \(minutes)m" : "")"
        }
        return "\(minutes)m"
    }

    // MARK: - Avatar Views

    private func avatarView(for row: HUDRow) -> some View {
        Group {
            if let authorUrl = row.authorUrl,
               let url = URL(string: authorUrl + ".png?size=32") {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().aspectRatio(contentMode: .fill)
                    default:
                        authorPlaceholder(for: row)
                    }
                }
                .frame(width: 24, height: 24)
                .clipShape(Circle())
            } else {
                authorPlaceholder(for: row)
            }
        }
    }

    private func authorPlaceholder(for row: HUDRow) -> some View {
        Circle()
            .fill(Color(.systemGray4))
            .frame(width: 24, height: 24)
            .overlay {
                Text(String((row.author ?? "?").prefix(1)).uppercased())
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white)
            }
    }

    // MARK: - Helpers

    /// Computes summary statistics for a row of jobs.
    static func jobSummary(for jobs: [HUDJob]) -> (failures: Int, pending: Int, successes: Int) {
        var failures = 0
        var pending = 0
        var successes = 0
        for job in jobs {
            if job.isFailure {
                failures += 1
            } else if job.isPending {
                pending += 1
            } else if job.isSuccess {
                successes += 1
            }
        }
        return (failures, pending, successes)
    }
}

#Preview {
    let sampleJobs: [HUDJob] = [
        HUDJob(id: 1, name: "build", conclusion: "success", htmlUrl: nil, logUrl: nil, durationS: 300, failureLines: nil, failureCaptures: nil, runnerName: nil, unstable: nil, authorEmail: nil),
        HUDJob(id: 2, name: "test", conclusion: "failure", htmlUrl: nil, logUrl: nil, durationS: 120, failureLines: nil, failureCaptures: nil, runnerName: nil, unstable: nil, authorEmail: nil),
        HUDJob(id: 3, name: "lint", conclusion: nil, htmlUrl: nil, logUrl: nil, durationS: nil, failureLines: nil, failureCaptures: nil, runnerName: nil, unstable: nil, authorEmail: nil),
        HUDJob(id: 4, name: "docs", conclusion: "success", htmlUrl: nil, logUrl: nil, durationS: 60, failureLines: nil, failureCaptures: nil, runnerName: nil, unstable: nil, authorEmail: nil),
    ]

    let sampleRows = (0..<10).map { i in
        HUDRow(
            sha: "abc\(i)234567890",
            commitTitle: "Sample commit \(i)",
            commitMessageBody: nil,
            prNumber: 1000 + i,
            author: "user\(i)",
            authorUrl: nil,
            time: ISO8601DateFormatter().string(from: Date().addingTimeInterval(Double(-i * 3600))),
            jobs: sampleJobs,
            isForcedMerge: i == 2,
            isForcedMergeWithFailures: i == 2,
            isAutoreverted: i == 3
        )
    }

    HUDGridView(
        rows: sampleRows,
        allJobs: sampleRows.map(\.jobs),
        jobNames: ["linux-build / build", "linux-test / test", "lint / check", "docs / build"],
        repoOwner: "pytorch",
        repoName: "pytorch"
    )
    .frame(height: 400)
}
