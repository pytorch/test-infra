import SwiftUI
import UIKit

struct JobCellView: View {
    let job: HUDJob
    let jobName: String
    var onTap: (() -> Void)?

    @State private var showingSafari = false
    @State private var isPressed = false

    private let cellSize: CGFloat = 28

    var body: some View {
        Button {
            let impact = UIImpactFeedbackGenerator(style: .light)
            impact.impactOccurred()
            onTap?()
        } label: {
            RoundedRectangle(cornerRadius: 5)
                .fill(cellColor)
                .frame(width: cellSize, height: cellSize)
                .overlay {
                    if job.isUnstable {
                        Image(systemName: "exclamationmark")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(.white)
                    } else if job.isFailure {
                        Image(systemName: "xmark")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.white)
                    } else if job.isSuccess {
                        Image(systemName: "checkmark")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.white)
                    } else if job.isPending {
                        Circle()
                            .fill(.white)
                            .frame(width: 6, height: 6)
                    }
                }
                .shadow(color: cellColor.opacity(0.3), radius: isPressed ? 1 : 2, x: 0, y: 1)
                .scaleEffect(isPressed ? 0.95 : 1.0)
                .animation(.easeInOut(duration: 0.1), value: isPressed)
        }
        .buttonStyle(JobCellButtonStyle(isPressed: $isPressed))
        .contextMenu {
            if let htmlUrl = job.htmlUrl, let url = URL(string: htmlUrl) {
                Button {
                    showingSafari = true
                } label: {
                    Label("View on GitHub", systemImage: "safari")
                }

                Button {
                    UIPasteboard.general.string = htmlUrl
                } label: {
                    Label("Copy Link", systemImage: "doc.on.doc")
                }
            }

            if let logUrl = job.logUrl, URL(string: logUrl) != nil {
                Button {
                    if let url = URL(string: logUrl) {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    Label("View Logs", systemImage: "doc.text")
                }
            }

            Divider()

            Text(jobName)
                .font(.caption)
        } preview: {
            JobCellPreview(job: job, jobName: jobName)
        }
        .sheet(isPresented: $showingSafari) {
            if let htmlUrl = job.htmlUrl, let url = URL(string: htmlUrl) {
                SafariView(url: url)
                    .ignoresSafeArea()
            }
        }
    }

    private var cellColor: Color {
        if job.isUnstable {
            return AppColors.unstable
        }
        return AppColors.forConclusion(job.conclusion)
    }
}

// MARK: - Custom Button Style
private struct JobCellButtonStyle: ButtonStyle {
    @Binding var isPressed: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .onChange(of: configuration.isPressed) { _, newValue in
                isPressed = newValue
            }
    }
}

private struct JobCellPreview: View {
    let job: HUDJob
    let jobName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            VStack(alignment: .leading, spacing: 4) {
                Text(jobName)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(3)

                if let name = job.name {
                    Text(name)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            Divider()

            // Status and Duration
            HStack(spacing: 12) {
                JobStatusBadge(
                    conclusion: job.conclusion,
                    isUnstable: job.isUnstable,
                    showLabel: true
                )

                if let duration = job.durationFormatted {
                    HStack(spacing: 4) {
                        Image(systemName: "clock")
                            .font(.caption2)
                        Text(duration)
                            .font(.caption)
                    }
                    .foregroundStyle(.secondary)
                }
            }

            // Failure Details
            if let failureLines = job.failureLines, !failureLines.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 4) {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.caption2)
                        Text("Failure Details")
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(AppColors.failure)

                    Text(failureLines.prefix(3).joined(separator: "\n"))
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(6)
                        .padding(8)
                        .background(AppColors.failure.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
            }

            // Runner Info
            if let runner = job.runnerName {
                HStack(spacing: 4) {
                    Image(systemName: "server.rack")
                        .font(.caption2)
                    Text(runner)
                        .font(.caption2)
                }
                .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(width: 300, alignment: .leading)
        .background(Color(.systemBackground))
    }
}

#Preview {
    HStack(spacing: 4) {
        JobCellView(
            job: HUDJob(
                id: 1, name: "test-build", conclusion: "success",
                htmlUrl: "https://github.com", logUrl: nil,
                durationS: 300, failureLines: nil, failureCaptures: nil,
                runnerName: nil, unstable: nil, previousRun: nil, authorEmail: nil
            ),
            jobName: "linux-build / test-build"
        )
        JobCellView(
            job: HUDJob(
                id: 2, name: "test-run", conclusion: "failure",
                htmlUrl: nil, logUrl: nil, durationS: 120,
                failureLines: ["AssertionError: expected True"], failureCaptures: nil,
                runnerName: "runner-1", unstable: nil, previousRun: nil, authorEmail: nil
            ),
            jobName: "linux-test / test-run"
        )
        JobCellView(
            job: HUDJob(
                id: 3, name: "pending-job", conclusion: nil,
                htmlUrl: nil, logUrl: nil, durationS: nil,
                failureLines: nil, failureCaptures: nil,
                runnerName: nil, unstable: nil, previousRun: nil, authorEmail: nil
            ),
            jobName: "pending-workflow / pending-job"
        )
        JobCellView(
            job: HUDJob(
                id: 4, name: "unstable-job", conclusion: "failure",
                htmlUrl: nil, logUrl: nil, durationS: 450,
                failureLines: nil, failureCaptures: nil,
                runnerName: nil, unstable: true, previousRun: nil, authorEmail: nil
            ),
            jobName: "linux-test / unstable-job"
        )
    }
    .padding()
}
