import SwiftUI

struct WorkflowSection: View {
    let workflowName: String
    let jobs: [(name: String, job: HUDJob)]
    var onJobTap: ((HUDJob, String) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerView
            jobsList
        }
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .shadow(color: .black.opacity(0.04), radius: 2, y: 1)
    }

    private var headerView: some View {
        HStack(spacing: 8) {
            Image(systemName: "gearshape.2")
                .font(.caption)
                .foregroundStyle(.secondary)

            Text(workflowName)
                .font(.subheadline.weight(.semibold))

            Spacer()

            statusSummary
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(.secondarySystemBackground))
    }

    private var statusSummary: some View {
        HStack(spacing: 6) {
            let successCount = jobs.filter { $0.job.isSuccess }.count
            let failCount = jobs.filter { $0.job.isFailure }.count
            let pendingCount = jobs.filter { $0.job.isPending }.count

            if successCount > 0 {
                HStack(spacing: 2) {
                    Circle()
                        .fill(AppColors.success)
                        .frame(width: 8, height: 8)
                    Text("\(successCount)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            if failCount > 0 {
                HStack(spacing: 2) {
                    Circle()
                        .fill(AppColors.failure)
                        .frame(width: 8, height: 8)
                    Text("\(failCount)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            if pendingCount > 0 {
                HStack(spacing: 2) {
                    Circle()
                        .fill(AppColors.pending)
                        .frame(width: 8, height: 8)
                    Text("\(pendingCount)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var jobsList: some View {
        VStack(spacing: 0) {
            ForEach(Array(jobs.enumerated()), id: \.offset) { index, entry in
                Button {
                    onJobTap?(entry.job, entry.name)
                } label: {
                    HStack(spacing: 8) {
                        JobStatusIcon(conclusion: entry.job.isUnstable ? "unstable" : entry.job.conclusion)

                        Text(entry.name)
                            .font(.caption)
                            .lineLimit(1)
                            .foregroundStyle(.primary)

                        Spacer()

                        if let duration = entry.job.durationFormatted {
                            Text(duration)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if index < jobs.count - 1 {
                    Divider()
                        .padding(.leading, 36)
                }
            }
        }
    }

    static func groupJobsByWorkflow(
        jobs: [HUDJob],
        jobNames: [String]
    ) -> [(workflow: String, jobs: [(name: String, job: HUDJob)])] {
        var groups: [String: [(name: String, job: HUDJob)]] = [:]
        var groupOrder: [String] = []

        for (index, job) in jobs.enumerated() {
            let name = index < jobNames.count ? jobNames[index] : (job.name ?? "Unknown")
            let workflowName = Self.extractWorkflowName(from: name)

            if groups[workflowName] == nil {
                groupOrder.append(workflowName)
            }
            groups[workflowName, default: []].append((name: name, job: job))
        }

        return groupOrder.compactMap { workflow in
            guard let jobList = groups[workflow] else { return nil }
            return (workflow: workflow, jobs: jobList)
        }
    }

    private static func extractWorkflowName(from jobName: String) -> String {
        // Job names are typically formatted as "workflow / job_name"
        if let slashIndex = jobName.firstIndex(of: "/") {
            let prefix = jobName[jobName.startIndex..<slashIndex].trimmingCharacters(in: .whitespaces)
            if !prefix.isEmpty {
                return prefix
            }
        }
        return "Other"
    }
}

#Preview {
    WorkflowSection(
        workflowName: "linux-build",
        jobs: [
            (name: "linux-build / build-x86", job: HUDJob(
                id: 1, name: "build-x86", conclusion: "success",
                htmlUrl: nil, logUrl: nil, durationS: 1200,
                failureLines: nil, failureCaptures: nil,
                runnerName: nil, unstable: nil, previousRun: nil, authorEmail: nil
            )),
            (name: "linux-build / test-x86", job: HUDJob(
                id: 2, name: "test-x86", conclusion: "failure",
                htmlUrl: nil, logUrl: nil, durationS: 600,
                failureLines: ["Error: test failed"], failureCaptures: nil,
                runnerName: nil, unstable: nil, previousRun: nil, authorEmail: nil
            )),
        ]
    )
    .padding()
}
