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
        let newFailureCount: Int
        let repeatFailureCount: Int
        let unstableFailureCount: Int
        let blockingFailureCount: Int
        let pendingCount: Int
        let totalRealJobs: Int

        var totalFailures: Int { newFailureCount + repeatFailureCount + unstableFailureCount }
    }

    private func computeStats(for jobs: [HUDJob]) -> RowJobStats {
        var success = 0, newFail = 0, repeatFail = 0, unstableFail = 0, blocking = 0, pending = 0, real = 0
        for job in jobs {
            if job.isEmpty { continue }
            real += 1
            if job.isSuccess {
                success += 1
            } else if job.isFailure {
                if job.isUnstable {
                    unstableFail += 1
                } else if job.isRepeatFailure {
                    repeatFail += 1
                } else {
                    newFail += 1
                }
                if job.isViableStrictBlocking && !job.isUnstable {
                    blocking += 1
                }
            } else if job.isPending {
                pending += 1
            }
        }
        return RowJobStats(
            successCount: success,
            newFailureCount: newFail,
            repeatFailureCount: repeatFail,
            unstableFailureCount: unstableFail,
            blockingFailureCount: blocking,
            pendingCount: pending,
            totalRealJobs: real
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

                            if row.isForcedMerge == true {
                                Text("FM")
                                    .font(.system(size: 8, weight: .bold))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 2)
                                    .background(AppColors.unstable)
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
        .background(index % 2 == 0 ? Color(.systemBackground) : Color(.systemGray6).opacity(0.3))
    }

    // MARK: - Status Bar

    private func statusBar(stats: RowJobStats) -> some View {
        let segments: [(Color, Int)] = [
            (AppColors.success, stats.successCount),
            (AppColors.failure, stats.blockingFailureCount),
            (AppColors.failure.opacity(0.5), stats.newFailureCount + stats.repeatFailureCount - stats.blockingFailureCount),
            (AppColors.unstable, stats.unstableFailureCount),
            (AppColors.pending, stats.pendingCount),
        ].filter { $0.1 > 0 }

        return HStack(spacing: 0.5) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                Rectangle()
                    .fill(segment.0)
                    .frame(height: 5)
                    .frame(maxWidth: .infinity)
                    .layoutPriority(Double(segment.1))
            }
        }
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
                miniCountBadge(count: stats.unstableFailureCount, color: AppColors.unstable, label: "flaky")
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
        HUDJob(id: 1, name: "build", conclusion: "success", htmlUrl: nil, logUrl: nil, durationS: 300, failureLines: nil, failureCaptures: nil, runnerName: nil, unstable: nil, previousRun: nil, authorEmail: nil),
        HUDJob(id: 2, name: "test", conclusion: "failure", htmlUrl: nil, logUrl: nil, durationS: 120, failureLines: nil, failureCaptures: nil, runnerName: nil, unstable: nil, previousRun: nil, authorEmail: nil),
        HUDJob(id: 3, name: "lint", conclusion: nil, htmlUrl: nil, logUrl: nil, durationS: nil, failureLines: nil, failureCaptures: nil, runnerName: nil, unstable: nil, previousRun: nil, authorEmail: nil),
        HUDJob(id: 4, name: "docs", conclusion: "success", htmlUrl: nil, logUrl: nil, durationS: 60, failureLines: nil, failureCaptures: nil, runnerName: nil, unstable: nil, previousRun: nil, authorEmail: nil),
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
            isForcedMerge: i == 2
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
