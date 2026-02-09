import SwiftUI
import UIKit

struct CommitRowView: View {
    let row: HUDRow
    let jobs: [HUDJob]
    let jobNames: [String]
    let repoOwner: String
    let repoName: String
    var onJobTap: ((HUDJob, String) -> Void)?
    var onCommitTap: ((HUDRow) -> Void)?
    var onPRTap: ((Int) -> Void)?

    var body: some View {
        HStack(spacing: 0) {
            commitInfoColumn
            jobCellsRow
        }
    }

    // MARK: - Commit Info (Frozen Column)

    private var commitInfoColumn: some View {
        Button {
            let impact = UIImpactFeedbackGenerator(style: .light)
            impact.impactOccurred()
            onCommitTap?(row)
        } label: {
            HStack(spacing: 10) {
                avatarView

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 4) {
                        Text(row.shortSha)
                            .font(AppTypography.monospacedSmall)
                            .foregroundStyle(Color.accentColor)

                        if row.isForcedMerge == true {
                            forceMergeBadge
                        }
                    }

                    Text(row.commitTitle ?? "No title")
                        .font(.caption)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .truncationMode(.tail)

                    HStack(spacing: 6) {
                        HStack(spacing: 3) {
                            Image(systemName: "clock")
                                .font(.system(size: 8))
                            Text(row.relativeTime)
                                .font(.caption2)
                        }
                        .foregroundStyle(.secondary)

                        if let prNumber = row.prNumber {
                            Button {
                                onPRTap?(prNumber)
                            } label: {
                                HStack(spacing: 3) {
                                    Image(systemName: "number")
                                        .font(.system(size: 8))
                                    Text("\(prNumber)")
                                        .font(.caption2.weight(.medium))
                                }
                                .foregroundStyle(Color.accentColor)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                Spacer(minLength: 0)
            }
            .frame(width: 180, alignment: .leading)
            .padding(.vertical, 6)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var avatarView: some View {
        Group {
            if let authorUrl = row.authorUrl, let url = URL(string: authorUrl + ".png?size=48") {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    case .failure:
                        authorInitialView
                    default:
                        Circle()
                            .fill(Color(.systemGray5))
                            .overlay {
                                ProgressView()
                                    .controlSize(.mini)
                            }
                    }
                }
                .frame(width: 28, height: 28)
                .clipShape(Circle())
            } else {
                authorInitialView
            }
        }
    }

    private var authorInitialView: some View {
        Circle()
            .fill(Color(.systemGray4))
            .frame(width: 28, height: 28)
            .overlay {
                Text(String((row.author ?? "?").prefix(1)).uppercased())
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
            }
    }

    private var forceMergeBadge: some View {
        HStack(spacing: 2) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 6))
            Text("FM")
                .font(.system(size: 8, weight: .bold))
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .background(AppColors.unstable)
        .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    // MARK: - Job Cells Row

    private var jobCellsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 3) {
                ForEach(Array(jobs.enumerated()), id: \.offset) { index, job in
                    let name = index < jobNames.count ? jobNames[index] : (job.name ?? "Job \(index)")
                    JobCellView(job: job, jobName: name) {
                        onJobTap?(job, name)
                    }
                }

                // Add subtle indicator that there's more content to scroll
                if jobs.count > 5 {
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .padding(.leading, 4)
                }
            }
            .padding(.trailing, 12)
        }
    }
}

#Preview {
    ScrollView(.horizontal) {
        CommitRowView(
            row: HUDRow(
                sha: "abc1234567890",
                commitTitle: "Fix a very long commit title that should truncate properly",
                commitMessageBody: nil,
                prNumber: 12345,
                author: "pytorchbot",
                authorUrl: "https://github.com/pytorchbot",
                time: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3600)),
                jobs: [
                    HUDJob(id: 1, name: "build", conclusion: "success", htmlUrl: nil, logUrl: nil, durationS: 300, failureLines: nil, failureCaptures: nil, runnerName: nil, unstable: nil, authorEmail: nil),
                    HUDJob(id: 2, name: "test", conclusion: "failure", htmlUrl: nil, logUrl: nil, durationS: 120, failureLines: nil, failureCaptures: nil, runnerName: nil, unstable: nil, authorEmail: nil),
                    HUDJob(id: 3, name: "lint", conclusion: nil, htmlUrl: nil, logUrl: nil, durationS: nil, failureLines: nil, failureCaptures: nil, runnerName: nil, unstable: nil, authorEmail: nil),
                ],
                isForcedMerge: true
            ),
            jobs: [
                HUDJob(id: 1, name: "build", conclusion: "success", htmlUrl: nil, logUrl: nil, durationS: 300, failureLines: nil, failureCaptures: nil, runnerName: nil, unstable: nil, authorEmail: nil),
                HUDJob(id: 2, name: "test", conclusion: "failure", htmlUrl: nil, logUrl: nil, durationS: 120, failureLines: nil, failureCaptures: nil, runnerName: nil, unstable: nil, authorEmail: nil),
                HUDJob(id: 3, name: "lint", conclusion: nil, htmlUrl: nil, logUrl: nil, durationS: nil, failureLines: nil, failureCaptures: nil, runnerName: nil, unstable: nil, authorEmail: nil),
            ],
            jobNames: ["linux-build / build", "linux-test / test", "lint / check"],
            repoOwner: "pytorch",
            repoName: "pytorch"
        )
    }
}
