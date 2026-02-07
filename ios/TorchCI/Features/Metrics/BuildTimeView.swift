import SwiftUI
import Charts

struct BuildTimeView: View {
    @StateObject private var viewModel = BuildTimeViewModel()
    @State private var showJobSelector = false

    var body: some View {
        Group {
            switch viewModel.state {
            case .loading:
                LoadingView(message: "Loading build time data...")

            case .error(let message):
                ErrorView(error: NSError(domain: "", code: 0, userInfo: [
                    NSLocalizedDescriptionKey: message,
                ])) {
                    Task { await viewModel.loadData() }
                }

            case .loaded:
                buildTimeContent
            }
        }
        .navigationTitle("Build Time")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showJobSelector.toggle()
                } label: {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                }
            }
        }
        .sheet(isPresented: $showJobSelector) {
            jobSelectorSheet
        }
        .task {
            await viewModel.loadData()
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var buildTimeContent: some View {
        ScrollView {
            VStack(spacing: 16) {
                controlsSection

                summaryRow

                buildDurationChart

                buildStepsBreakdownChart

                percentileComparisonChart

                regressionSection

                slowestWorkflowsList
            }
            .padding()
        }
        .refreshable {
            await viewModel.refresh()
        }
    }

    // MARK: - Controls

    @ViewBuilder
    private var controlsSection: some View {
        VStack(spacing: 10) {
            TimeRangePicker(selectedRangeID: $viewModel.selectedTimeRange)

            HStack(spacing: 8) {
                Text("\(viewModel.selectedJobCount) of \(viewModel.allJobNames.count) jobs selected")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Spacer()

                if viewModel.selectedJobCount < viewModel.allJobNames.count {
                    Button("Select All") {
                        viewModel.selectAllJobs()
                    }
                    .font(.caption.weight(.medium))
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }

            GranularityPicker(selection: $viewModel.granularity)
        }
        .onChange(of: viewModel.selectedTimeRange) {
            Task { await viewModel.onParametersChanged() }
        }
        .onChange(of: viewModel.granularity) {
            Task { await viewModel.onParametersChanged() }
        }
    }

    // MARK: - Summary

    @ViewBuilder
    private var summaryRow: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                ScalarPanel(
                    label: "Avg Build Time",
                    value: BuildTimeViewModel.formatDuration(viewModel.avgDurationMinutes),
                    icon: "hammer",
                    valueColor: BuildTimeViewModel.durationColor(viewModel.avgDurationMinutes)
                )

                ScalarPanel(
                    label: "P90 Duration",
                    value: BuildTimeViewModel.formatDuration(viewModel.p90DurationMinutes),
                    icon: "gauge.with.needle",
                    valueColor: BuildTimeViewModel.durationColor(viewModel.p90DurationMinutes)
                )
            }

            HStack(spacing: 10) {
                ScalarPanel(
                    label: "Trend",
                    value: viewModel.trendDescription,
                    icon: viewModel.isImproving ? "arrow.down.right" : "arrow.up.right",
                    valueColor: viewModel.isImproving ? AppColors.success : AppColors.failure
                )

                ScalarPanel(
                    label: "Total Builds",
                    value: "\(viewModel.totalBuildCount)",
                    icon: "number.circle",
                    valueColor: .primary
                )
            }
        }
    }

    // MARK: - Build Duration Chart

    @ViewBuilder
    private var buildDurationChart: some View {
        TimeSeriesChart(
            title: "Average Build Time Over Time",
            data: viewModel.durationSeries,
            color: .brown,
            valueFormat: .duration,
            chartHeight: 240
        )
    }

    // MARK: - Build Steps Breakdown Chart

    @ViewBuilder
    private var buildStepsBreakdownChart: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(
                title: "Build Steps Breakdown",
                subtitle: "Average time per build step"
            )

            if !viewModel.buildSteps.isEmpty {
                Chart {
                    ForEach(viewModel.selectedBuildSteps, id: \.jobName) { step in
                        BarMark(
                            x: .value("Duration", step.checkoutMinutes),
                            y: .value("Job", step.jobName)
                        )
                        .foregroundStyle(Color.blue)
                        .position(by: .value("Step", "Checkout"))

                        BarMark(
                            x: .value("Duration", step.pullDockerMinutes),
                            y: .value("Job", step.jobName)
                        )
                        .foregroundStyle(Color.purple)
                        .position(by: .value("Step", "Pull Docker"))

                        BarMark(
                            x: .value("Duration", step.buildMinutes),
                            y: .value("Job", step.jobName)
                        )
                        .foregroundStyle(Color.orange)
                        .position(by: .value("Step", "Build"))
                    }
                }
                .chartXAxis {
                    AxisMarks(position: .bottom, values: .automatic(desiredCount: 5)) { value in
                        AxisValueLabel {
                            if let v = value.as(Double.self) {
                                Text("\(Int(v))m")
                            }
                        }
                        AxisGridLine()
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { value in
                        AxisValueLabel {
                            if let jobName = value.as(String.self) {
                                Text(jobName)
                                    .font(.caption2)
                                    .lineLimit(1)
                            }
                        }
                    }
                }
                .chartForegroundStyleScale([
                    "Checkout": Color.blue,
                    "Pull Docker": Color.purple,
                    "Build": Color.orange,
                ])
                .chartLegend(position: .bottom, alignment: .center)
                .frame(height: CGFloat(max(viewModel.selectedBuildSteps.count, 1)) * 35 + 60)
            } else {
                emptyChartPlaceholder
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }

    // MARK: - Percentile Comparison

    @ViewBuilder
    private var percentileComparisonChart: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(
                title: "Duration Percentiles",
                subtitle: "P50, P75, and P90 build durations over time"
            )

            if !viewModel.p50Series.isEmpty {
                Chart {
                    ForEach(viewModel.p50Series, id: \.granularity_bucket) { point in
                        if let value = point.value {
                            LineMark(
                                x: .value("Date", point.granularity_bucket),
                                y: .value("Minutes", value / 60),
                                series: .value("Percentile", "P50")
                            )
                            .foregroundStyle(.green)
                            .lineStyle(StrokeStyle(lineWidth: 1.5))
                        }
                    }

                    ForEach(viewModel.p75Series, id: \.granularity_bucket) { point in
                        if let value = point.value {
                            LineMark(
                                x: .value("Date", point.granularity_bucket),
                                y: .value("Minutes", value / 60),
                                series: .value("Percentile", "P75")
                            )
                            .foregroundStyle(.orange)
                            .lineStyle(StrokeStyle(lineWidth: 1.5))
                        }
                    }

                    ForEach(viewModel.p90Series, id: \.granularity_bucket) { point in
                        if let value = point.value {
                            LineMark(
                                x: .value("Date", point.granularity_bucket),
                                y: .value("Minutes", value / 60),
                                series: .value("Percentile", "P90")
                            )
                            .foregroundStyle(.red)
                            .lineStyle(StrokeStyle(lineWidth: 1.5))
                        }
                    }
                }
                .chartForegroundStyleScale([
                    "P50": Color.green,
                    "P75": Color.orange,
                    "P90": Color.red,
                ])
                .chartLegend(position: .bottom, alignment: .center)
                .chartYAxis {
                    AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                        AxisValueLabel {
                            if let v = value.as(Double.self) {
                                Text("\(Int(v))m")
                            }
                        }
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 5)) {
                        AxisValueLabel()
                        AxisGridLine()
                    }
                }
                .frame(height: 200)
            } else {
                emptyChartPlaceholder
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }

    // MARK: - Regression Section

    @ViewBuilder
    private var regressionSection: some View {
        if !viewModel.regressions.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(
                    title: "Recent Regressions",
                    subtitle: "Builds taking longer than usual"
                )

                LazyVStack(spacing: 8) {
                    ForEach(viewModel.regressions) { regression in
                        HStack(spacing: 12) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(AppColors.unstable)
                                .font(.title3)

                            VStack(alignment: .leading, spacing: 4) {
                                Text(regression.jobName)
                                    .font(.subheadline.weight(.medium))
                                    .lineLimit(2)
                                HStack(spacing: 8) {
                                    statLabel("Current", value: BuildTimeViewModel.formatDuration(regression.currentMinutes))
                                    statLabel("Baseline", value: BuildTimeViewModel.formatDuration(regression.baselineMinutes))
                                }
                            }

                            Spacer()

                            Text(regression.changeDescription)
                                .font(.subheadline.bold())
                                .foregroundStyle(AppColors.failure)
                        }
                        .padding(12)
                        .background(AppColors.unstable.opacity(0.1))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(AppColors.unstable, lineWidth: 1)
                        )
                    }
                }
            }
        }
    }

    // MARK: - Slowest Workflows

    @ViewBuilder
    private var slowestWorkflowsList: some View {
        if !viewModel.slowestWorkflows.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(
                    title: "Slowest Jobs",
                    subtitle: "Top \(viewModel.slowestWorkflows.count) by average duration"
                )

                LazyVStack(spacing: 8) {
                    ForEach(viewModel.slowestWorkflows) { workflow in
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(workflow.name)
                                    .font(.subheadline.weight(.medium))
                                    .lineLimit(2)
                                HStack(spacing: 8) {
                                    statLabel("Avg", value: BuildTimeViewModel.formatDuration(workflow.avgMinutes))
                                    statLabel("P90", value: BuildTimeViewModel.formatDuration(workflow.p90Minutes))
                                    statLabel("Runs", value: "\(workflow.runCount)")
                                }
                            }

                            Spacer()

                            Text(BuildTimeViewModel.formatDuration(workflow.avgMinutes))
                                .font(.subheadline.bold())
                                .foregroundStyle(BuildTimeViewModel.durationColor(workflow.avgMinutes))
                        }
                        .padding(12)
                        .background(Color(.secondarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                }
            }
        }
    }

    // MARK: - Job Selector Sheet

    @ViewBuilder
    private var jobSelectorSheet: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        viewModel.selectAllJobs()
                    } label: {
                        HStack {
                            Text("Select All")
                            Spacer()
                            Text("\(viewModel.allJobNames.count)")
                                .foregroundStyle(.secondary)
                        }
                    }

                    Button {
                        viewModel.deselectAllJobs()
                    } label: {
                        HStack {
                            Text("Deselect All")
                            Spacer()
                        }
                    }
                }

                Section("Jobs (\(viewModel.selectedJobCount)/\(viewModel.allJobNames.count))") {
                    ForEach(viewModel.allJobNames, id: \.self) { jobName in
                        Button {
                            viewModel.toggleJobSelection(jobName)
                        } label: {
                            HStack {
                                Image(systemName: viewModel.isJobSelected(jobName) ? "checkmark.square.fill" : "square")
                                    .foregroundStyle(viewModel.isJobSelected(jobName) ? .blue : .secondary)
                                Text(jobName)
                                    .foregroundStyle(.primary)
                                    .font(.subheadline)
                                Spacer()
                            }
                        }
                    }
                }
            }
            .navigationTitle("Select Jobs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        showJobSelector = false
                        Task { await viewModel.onJobSelectionChanged() }
                    }
                    .fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: - Helpers

    @ViewBuilder
    private var emptyChartPlaceholder: some View {
        RoundedRectangle(cornerRadius: 8)
            .fill(Color(.secondarySystemBackground))
            .frame(height: 180)
            .overlay {
                Text("No data available")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
    }

    @ViewBuilder
    private func statLabel(_ title: String, value: String) -> some View {
        HStack(spacing: 3) {
            Text(title)
                .foregroundStyle(.secondary)
            Text(value)
                .foregroundStyle(.primary)
        }
        .font(.caption2)
    }
}

#Preview {
    NavigationStack {
        BuildTimeView()
    }
}
