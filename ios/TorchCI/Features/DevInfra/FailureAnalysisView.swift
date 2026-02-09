import SwiftUI
import UIKit
import Charts

struct FailureAnalysisView: View {
    @StateObject private var viewModel = FailureAnalysisViewModel()

    var body: some View {
        VStack(spacing: 0) {
            searchSection
                .padding(.horizontal)
                .padding(.top, 8)

            if viewModel.showDatePicker {
                dateRangeSection
                    .padding(.horizontal)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }

            Divider()
                .padding(.top, 12)

            contentBody
        }
        .navigationTitle("Failure Analysis")
        .navigationBarTitleDisplayMode(.large)
        .sheet(item: $viewModel.selectedJob) { job in
            FailureDetailSheet(job: job)
        }
    }

    // MARK: - Search Section

    private var searchSection: some View {
        VStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Search for Log Classifier Results")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                SearchBar(
                    text: $viewModel.searchQuery,
                    placeholder: "Enter failure pattern or test name...",
                    onSubmit: { Task { await viewModel.search() } }
                )
            }

            HStack {
                Button {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        viewModel.showDatePicker.toggle()
                    }
                } label: {
                    Label(
                        viewModel.showDatePicker ? "Hide Dates" : "Date Range",
                        systemImage: "calendar"
                    )
                    .font(.subheadline)
                }

                Spacer()

                if viewModel.hasResults {
                    Button("Clear") {
                        viewModel.clearResults()
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                }

                Button {
                    Task { await viewModel.search() }
                } label: {
                    if viewModel.isLoading {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Label("Search", systemImage: "magnifyingglass")
                            .font(.subheadline.weight(.medium))
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(viewModel.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || viewModel.isLoading)
            }
        }
    }

    // MARK: - Date Range

    private var dateRangeSection: some View {
        VStack(spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Start Date")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                    DatePicker(
                        "",
                        selection: $viewModel.startDate,
                        in: ...viewModel.endDate,
                        displayedComponents: .date
                    )
                    .labelsHidden()
                    .datePickerStyle(.compact)
                }

                Spacer()

                VStack(alignment: .leading, spacing: 4) {
                    Text("End Date")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                    DatePicker(
                        "",
                        selection: $viewModel.endDate,
                        in: viewModel.startDate...Date(),
                        displayedComponents: .date
                    )
                    .labelsHidden()
                    .datePickerStyle(.compact)
                }
            }

            HStack {
                Text("Showing last 14 days by default")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                Spacer()

                Button {
                    viewModel.resetDateRange()
                } label: {
                    Label("Reset", systemImage: "arrow.counterclockwise")
                        .font(.caption)
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Content

    @ViewBuilder
    private var contentBody: some View {
        switch viewModel.state {
        case .idle:
            ScrollView {
                VStack(spacing: 16) {
                    EmptyStateView(
                        icon: "magnifyingglass.circle",
                        title: "Search CI Failures",
                        message: "Search for log classifier results to analyze failure patterns across jobs and over time."
                    )

                    InfoCard(title: "How to Use", icon: "info.circle") {
                        VStack(alignment: .leading, spacing: 12) {
                            helpRow(
                                icon: "1.circle.fill",
                                text: "Enter a failure pattern or test name"
                            )
                            helpRow(
                                icon: "2.circle.fill",
                                text: "Optionally adjust the date range (defaults to last 14 days)"
                            )
                            helpRow(
                                icon: "3.circle.fill",
                                text: "View histogram, distribution by job, and individual failures"
                            )
                            helpRow(
                                icon: "4.circle.fill",
                                text: "Tap jobs to filter and failures to view full logs"
                            )
                        }
                    }
                }
                .padding()
            }

        case .loading:
            LoadingView(message: "Searching failures...")

        case .loaded:
            if viewModel.hasResults {
                resultsView
            } else {
                EmptyStateView(
                    icon: "tray",
                    title: "No Results",
                    message: "No failures matched your query. Try a different search term or broader date range.",
                    actionTitle: "Clear Search"
                ) {
                    viewModel.clearResults()
                }
            }

        case .error(let message):
            ErrorView(error: NSError(domain: "", code: 0, userInfo: [NSLocalizedDescriptionKey: message])) {
                Task { await viewModel.search() }
            }
        }
    }

    private func helpRow(icon: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(.blue)
                .font(.subheadline)
                .frame(width: 24)

            Text(text)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Results

    private var resultsView: some View {
        List {
            summarySection

            if !viewModel.histogramData.isEmpty {
                histogramSection
            }

            if !viewModel.jobDistribution.isEmpty {
                distributionSection
            }

            failuresSection
        }
        .listStyle(.insetGrouped)
        .refreshable {
            await viewModel.search()
        }
    }

    private var summarySection: some View {
        Section {
            VStack(spacing: 12) {
                HStack(spacing: 12) {
                    MetricCard(
                        title: "Total Failures",
                        value: viewModel.totalCount.formatted(),
                        valueColor: AppColors.failure
                    )

                    MetricCard(
                        title: "Unique Jobs",
                        value: viewModel.jobDistribution.count.formatted()
                    )
                }

                if let avgPerDay = viewModel.averageFailuresPerDay {
                    HStack(spacing: 12) {
                        MetricCard(
                            title: "Avg / Day",
                            value: avgPerDay,
                            subtitle: "over search range"
                        )

                        if viewModel.mainBranchFailureCount > 0 {
                            MetricCard(
                                title: "Main Branch",
                                value: viewModel.mainBranchFailureCount.formatted(),
                                valueColor: Color(red: 228/255, green: 26/255, blue: 28/255)
                            )
                        } else {
                            Spacer()
                                .frame(maxWidth: .infinity)
                        }
                    }
                }
            }
            .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
            .listRowBackground(Color.clear)
        }
    }

    private var histogramSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text("Last 14 Days")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Chart {
                    ForEach(viewModel.histogramData, id: \.date) { point in
                        BarMark(
                            x: .value("Date", point.date),
                            y: .value("Count", point.other)
                        )
                        .foregroundStyle(Color(red: 136/255, green: 132/255, blue: 216/255))
                        .position(by: .value("Branch", "Other"))

                        BarMark(
                            x: .value("Date", point.date),
                            y: .value("Count", point.main)
                        )
                        .foregroundStyle(Color(red: 228/255, green: 26/255, blue: 28/255))
                        .position(by: .value("Branch", "Main"))
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 7)) { _ in
                        AxisValueLabel()
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { _ in
                        AxisValueLabel()
                        AxisGridLine()
                    }
                }
                .chartLegend(.hidden)
                .frame(height: 180)
            }
            .padding(.vertical, 8)
        } header: {
            Text("Failure Count Histogram")
        } footer: {
            HStack(spacing: 16) {
                HStack(spacing: 4) {
                    Circle()
                        .fill(Color(red: 228/255, green: 26/255, blue: 28/255))
                        .frame(width: 8, height: 8)
                    Text("main/master")
                        .font(.caption2)
                }
                HStack(spacing: 4) {
                    Circle()
                        .fill(Color(red: 136/255, green: 132/255, blue: 216/255))
                        .frame(width: 8, height: 8)
                    Text("other branches")
                        .font(.caption2)
                }
            }
            .foregroundStyle(.secondary)
        }
    }

    private var distributionSection: some View {
        Section {
            ForEach(Array(viewModel.jobDistribution.prefix(10).enumerated()), id: \.offset) { _, entry in
                Button {
                    viewModel.toggleJobFilter(entry.name)
                } label: {
                    distributionRow(entry: entry)
                }
                .buttonStyle(.plain)
            }
        } header: {
            HStack {
                Text("Failures by Job")
                Spacer()
                if !viewModel.selectedJobFilters.isEmpty {
                    Button("Clear Filters") {
                        viewModel.selectedJobFilters.removeAll()
                    }
                    .font(.caption)
                    .textCase(nil)
                }
            }
        } footer: {
            Text("Tap job names to filter the failure list below")
                .font(.caption2)
        }
    }

    private func distributionRow(entry: (name: String, count: Int)) -> some View {
        let isSelected = viewModel.selectedJobFilters.contains(entry.name)
        let maxCount = viewModel.jobDistribution.first?.count ?? 1
        let fraction = CGFloat(entry.count) / CGFloat(max(maxCount, 1))

        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: isSelected ? "checkmark.square.fill" : "square")
                    .foregroundStyle(isSelected ? Color.accentColor : .secondary)
                    .font(.body)

                Text(entry.name)
                    .font(.caption)
                    .foregroundStyle(.primary)
                    .lineLimit(3)

                Spacer(minLength: 4)

                Text("\(entry.count)")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            GeometryReader { geometry in
                RoundedRectangle(cornerRadius: 3)
                    .fill(isSelected ? Color.accentColor.opacity(0.7) : AppColors.failure.opacity(0.5))
                    .frame(width: geometry.size.width * fraction, height: 6)
            }
            .frame(height: 6)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var failuresSection: some View {
        if let similarError = viewModel.similarFailuresError {
            Section {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .font(.caption)
                    Text(similarError)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }

        Section {
            ForEach(viewModel.filteredResults) { job in
                FailureResultRow(job: job)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        viewModel.selectedJob = job
                    }
            }
        } header: {
            let count = viewModel.filteredResults.count
            let total = (viewModel.similarFailuresResult?.samples ?? viewModel.results).count
            if viewModel.selectedJobFilters.isEmpty {
                Text("Matching Failures (\(total) total)")
            } else {
                Text("Filtered Failures (\(count) of \(total))")
            }
        }
    }
}

// MARK: - Failure Result Row

private struct FailureResultRow: View {
    let job: JobData

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                JobStatusIcon(conclusion: job.conclusion)

                VStack(alignment: .leading, spacing: 2) {
                    Text(job.jobName ?? job.name ?? "Unknown Job")
                        .font(.subheadline.weight(.medium))
                        .lineLimit(2)

                    HStack(spacing: 8) {
                        StatusBadge(conclusion: job.conclusion, size: .small, showLabel: true)

                        if let duration = job.durationFormatted {
                            Label(duration, systemImage: "clock")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Spacer(minLength: 4)

                if let time = job.time {
                    Text(relativeTimeString(from: time))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            if let failurePreview = failurePreviewText {
                Text(failurePreview)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.systemGray6))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityDescription)
        .accessibilityHint("Double-tap to view failure details")
    }

    private var accessibilityDescription: String {
        let name = job.jobName ?? job.name ?? "Unknown Job"
        let status = job.conclusion?.capitalized ?? "Unknown"
        return "\(name), \(status)"
    }

    private var failurePreviewText: String? {
        if let lines = job.failureLines, !lines.isEmpty {
            return lines.prefix(3).joined(separator: "\n")
        }
        if let captures = job.failureCaptures, !captures.isEmpty {
            return captures.prefix(3).joined(separator: "\n")
        }
        if let context = job.failureContext, !context.isEmpty {
            // Truncate long context for the preview
            let truncated = String(context.prefix(200))
            return truncated.count < context.count ? truncated + "..." : truncated
        }
        return nil
    }

    private func relativeTimeString(from isoString: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: isoString) else {
            return isoString
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

// MARK: - Failure Detail Sheet

private struct FailureDetailSheet: View {
    let job: JobData
    @Environment(\.dismiss) private var dismiss
    @State private var expandedLogs: Bool = false
    @State private var copiedText: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    statusCard
                    jobInfoSection
                    failureLinesSection
                    failureCapturesSection
                    failureContextSection
                    stepsSection
                    linksSection
                }
                .padding()
            }
            .navigationTitle("Failure Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if let copyText = copyableFailureText {
                        Button {
                            UIPasteboard.general.string = copyText
                            copiedText = "Copied!"
                            Task {
                                try? await Task.sleep(nanoseconds: 2_000_000_000)
                                copiedText = nil
                            }
                        } label: {
                            if let copiedText {
                                Label(copiedText, systemImage: "checkmark")
                                    .font(.caption)
                            } else {
                                Label("Copy", systemImage: "doc.on.doc")
                            }
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var copyableFailureText: String? {
        var parts: [String] = []
        if let name = job.jobName ?? job.name {
            parts.append("Job: \(name)")
        }
        if let lines = job.failureLines, !lines.isEmpty {
            parts.append("Failure Lines:\n" + lines.joined(separator: "\n"))
        }
        if let captures = job.failureCaptures, !captures.isEmpty {
            parts.append("Failure Captures:\n" + captures.joined(separator: "\n"))
        }
        if let context = job.failureContext, !context.isEmpty {
            parts.append("Context:\n" + context)
        }
        return parts.isEmpty ? nil : parts.joined(separator: "\n\n")
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                JobStatusIcon(conclusion: job.conclusion)
                    .font(.system(size: 24))

                VStack(alignment: .leading, spacing: 4) {
                    Text(job.jobName ?? job.name ?? "Unknown Job")
                        .font(.headline)
                        .lineLimit(3)

                    if let time = job.time, let date = ISO8601DateFormatter().date(from: time) {
                        Text(date, style: .relative)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                StatusBadge(conclusion: job.conclusion, size: .medium, showLabel: true)
            }

            if let workflowName = job.workflowName {
                HStack(spacing: 4) {
                    Image(systemName: "gearshape.2")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(workflowName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var jobInfoSection: some View {
        InfoCard(title: "Job Info", icon: "gearshape") {
            LazyVGrid(columns: [
                GridItem(.flexible(), spacing: 12),
                GridItem(.flexible(), spacing: 12),
            ], alignment: .leading, spacing: 10) {
                if let duration = job.durationFormatted {
                    infoCell(label: "Duration", value: duration, icon: "clock")
                }
                if let queueTime = job.queueTimeS {
                    let formatted = formatDuration(queueTime)
                    infoCell(label: "Queue Time", value: formatted, icon: "hourglass")
                }
                if let runner = job.runnerName {
                    infoCell(label: "Runner", value: runner, icon: "desktopcomputer")
                }
                if let runnerGroup = job.runnerGroup {
                    infoCell(label: "Runner Group", value: runnerGroup, icon: "server.rack")
                }
                if let attempt = job.runAttempt {
                    infoCell(label: "Attempt", value: "\(attempt)", icon: "arrow.counterclockwise")
                }
            }
        }
    }

    private func infoCell(label: String, value: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Text(value)
                .font(.caption.weight(.medium))
                .lineLimit(2)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.systemGray6))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    @ViewBuilder
    private var failureLinesSection: some View {
        if let lines = job.failureLines, !lines.isEmpty {
            InfoCard(title: "Failure Lines", icon: "exclamationmark.triangle") {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.prefix(expandedLogs ? lines.count : 5).enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                            .padding(.vertical, 2)
                    }

                    if lines.count > 5 {
                        Button {
                            withAnimation { expandedLogs.toggle() }
                        } label: {
                            HStack {
                                Text(expandedLogs ? "Show Less" : "Show All (\(lines.count) lines)")
                                    .font(.caption.weight(.medium))
                                Image(systemName: expandedLogs ? "chevron.up" : "chevron.down")
                                    .font(.caption)
                            }
                            .foregroundStyle(.blue)
                            .padding(.top, 8)
                        }
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.systemGray6))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    @ViewBuilder
    private var failureCapturesSection: some View {
        if let captures = job.failureCaptures, !captures.isEmpty {
            InfoCard(title: "Failure Captures", icon: "text.magnifyingglass") {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(captures.enumerated()), id: \.offset) { index, capture in
                        VStack(alignment: .leading, spacing: 4) {
                            if captures.count > 1 {
                                Text("Capture \(index + 1)")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.secondary)
                            }
                            Text(capture)
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                        }
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.systemGray6))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var failureContextSection: some View {
        if let context = job.failureContext, !context.isEmpty {
            InfoCard(title: "Failure Context (Full Log)", icon: "doc.text") {
                ScrollView(.horizontal, showsIndicators: true) {
                    Text(context)
                        .font(.system(.caption2, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(12)
                }
                .frame(maxHeight: 400)
                .background(Color(.systemGray6))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    @ViewBuilder
    private var stepsSection: some View {
        if let steps = job.steps, !steps.isEmpty {
            InfoCard(title: "Steps (\(steps.count))", icon: "list.number") {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(steps) { step in
                        HStack(spacing: 10) {
                            Text("\(step.number)")
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(.secondary)
                                .frame(width: 24, alignment: .trailing)

                            JobStatusIcon(conclusion: step.conclusion)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(step.name)
                                    .font(.caption)
                                    .lineLimit(2)

                                if let started = step.startedAt, let completed = step.completedAt {
                                    let duration = calculateStepDuration(started: started, completed: completed)
                                    Text(duration)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }

                            Spacer()
                        }
                        .padding(.vertical, 2)

                        if step.number < steps.count {
                            Divider()
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var linksSection: some View {
        if job.htmlUrl != nil || job.logUrl != nil {
            InfoCard(title: "Links", icon: "link") {
                VStack(alignment: .leading, spacing: 8) {
                    if let htmlUrl = job.htmlUrl {
                        LinkButton(title: "View on GitHub", url: htmlUrl, icon: "safari")
                    }
                    if let logUrl = job.logUrl {
                        LinkButton(title: "View Full Logs", url: logUrl, icon: "doc.text")
                    }
                }
            }
        }
    }

    private func formatDuration(_ seconds: Int) -> String {
        DurationFormatter.format(seconds)
    }

    private func calculateStepDuration(started: String, completed: String) -> String {
        let formatter = ISO8601DateFormatter()
        guard let startDate = formatter.date(from: started),
              let endDate = formatter.date(from: completed) else {
            return "Unknown"
        }
        let duration = Int(endDate.timeIntervalSince(startDate))
        return formatDuration(duration)
    }
}

#Preview {
    FailureAnalysisView()
}
