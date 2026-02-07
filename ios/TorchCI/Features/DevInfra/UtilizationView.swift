import SwiftUI
import Charts

struct UtilizationView: View {
    @StateObject private var viewModel = UtilizationViewModel()
    @State private var selectedReport: UtilizationReport?

    var body: some View {
        VStack(spacing: 0) {
            headerSection
                .padding(.horizontal)
                .padding(.top, 8)

            Divider()
                .padding(.top, 12)

            contentBody
        }
        .navigationTitle("Utilization")
        .navigationBarTitleDisplayMode(.large)
        .task { await viewModel.loadData() }
        .sheet(item: $selectedReport) { report in
            NavigationStack {
                WorkflowUtilizationDetailView(report: report)
            }
        }
        .sheet(isPresented: $viewModel.showingDatePicker) {
            datePickerSheet
        }
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(spacing: 10) {
            HStack {
                Text("Group by")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                Spacer()
            }

            SegmentedPicker(
                options: UtilizationViewModel.GroupBy.allCases,
                selection: Binding(
                    get: { viewModel.selectedGroupBy },
                    set: { viewModel.selectGroupBy($0) }
                )
            )

            HStack {
                Text("Time Range")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                Spacer()

                Menu {
                    ForEach(UtilizationViewModel.TimeRange.allCases, id: \.self) { range in
                        Button {
                            viewModel.selectTimeRange(range)
                        } label: {
                            HStack {
                                Text(range.description)
                                if viewModel.selectedTimeRange == range {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(viewModel.selectedTimeRange.description)
                            .font(.subheadline)
                        Image(systemName: "chevron.down")
                            .font(.caption)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color(.secondarySystemBackground))
                    .foregroundStyle(.primary)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
    }

    // MARK: - Date Picker Sheet

    private var datePickerSheet: some View {
        NavigationStack {
            Form {
                DatePicker("Start Date", selection: $viewModel.customStartDate, displayedComponents: .date)
                DatePicker("End Date", selection: $viewModel.customEndDate, displayedComponents: .date)
            }
            .navigationTitle("Custom Date Range")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        viewModel.showingDatePicker = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        viewModel.applyCustomDateRange()
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: - Content

    @ViewBuilder
    private var contentBody: some View {
        switch viewModel.state {
        case .idle:
            EmptyStateView(
                icon: "cpu",
                title: "Utilization Reports",
                message: "Loading utilization data..."
            )

        case .loading:
            LoadingView(message: "Fetching utilization reports...")

        case .loaded:
            if viewModel.sortedReports.isEmpty {
                EmptyStateView(
                    icon: "chart.bar",
                    title: "No Data",
                    message: "No utilization data available for the selected grouping."
                )
            } else {
                utilizationList
            }

        case .error(let message):
            ErrorView(error: NSError(domain: "", code: 0, userInfo: [NSLocalizedDescriptionKey: message])) {
                Task { await viewModel.refresh() }
            }
        }
    }

    // MARK: - Utilization List

    private var utilizationList: some View {
        List {
            // Summary gauges
            Section {
                summaryGauges
                    .padding(.vertical, 8)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowBackground(Color.clear)
            }

            // Distribution chart
            if !viewModel.reports.isEmpty {
                Section {
                    utilizationDistributionChart
                        .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
                        .listRowBackground(Color.clear)
                }
            }

            // Sortable table
            Section {
                sortableHeader
                    .listRowBackground(Color(.secondarySystemBackground))

                ForEach(viewModel.sortedReports) { report in
                    utilizationRow(report)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            if viewModel.selectedGroupBy == .workflow {
                                selectedReport = report
                            }
                        }
                }
            } header: {
                Text("Reports (\(viewModel.sortedReports.count))")
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await viewModel.refresh() }
    }

    // MARK: - Summary Gauges

    private var summaryGauges: some View {
        HStack(spacing: 0) {
            CircularGaugeView(
                title: "Avg CPU",
                value: viewModel.averageCPU,
                color: Self.gaugeColor(viewModel.averageCPU, warningAt: 60, criticalAt: 80)
            )
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Average CPU \(String(format: "%.0f", viewModel.averageCPU)) percent")

            CircularGaugeView(
                title: "Avg Memory",
                value: viewModel.averageMemory,
                color: Self.gaugeColor(viewModel.averageMemory, warningAt: 65, criticalAt: 85)
            )
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Average Memory \(String(format: "%.0f", viewModel.averageMemory)) percent")

            CircularGaugeView(
                title: "Total Jobs",
                value: Double(viewModel.totalJobsCount),
                maxValue: Double(max(viewModel.totalJobsCount, 1)),
                suffix: "",
                color: .blue
            )
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Total Jobs \(viewModel.totalJobsCount)")
        }
    }

    // MARK: - Circular Gauge

    private struct CircularGaugeView: View {
        let title: String
        let value: Double
        var maxValue: Double = 100
        var suffix: String = "%"
        let color: Color

        private var progress: Double {
            guard maxValue > 0 else { return 0 }
            return min(value / maxValue, 1.0)
        }

        var body: some View {
            VStack(spacing: 4) {
                ZStack {
                    Circle()
                        .stroke(Color(.systemGray5), lineWidth: 7)

                    Circle()
                        .trim(from: 0, to: progress)
                        .stroke(color, style: StrokeStyle(lineWidth: 7, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .animation(.easeInOut(duration: 0.4), value: progress)

                    VStack(spacing: 0) {
                        Text(suffix.isEmpty ? Self.formatCount(Int(value)) : String(format: "%.0f", value))
                            .font(.system(size: 15, weight: .bold, design: .rounded))
                            .minimumScaleFactor(0.6)
                            .lineLimit(1)
                        if !suffix.isEmpty {
                            Text(suffix)
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(4)
                }
                .frame(width: 64, height: 64)

                Text(title)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }

        private static func formatCount(_ count: Int) -> String {
            if count >= 1_000_000 { return String(format: "%.1fM", Double(count) / 1_000_000) }
            if count >= 1_000 { return String(format: "%.1fK", Double(count) / 1_000) }
            return "\(count)"
        }
    }

    // MARK: - Distribution Chart

    private var utilizationDistributionChart: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Utilization Distribution")
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal)

            Chart {
                ForEach(viewModel.utilizationDistribution, id: \.category) { item in
                    BarMark(
                        x: .value("Count", item.count),
                        y: .value("Category", item.category)
                    )
                    .foregroundStyle(item.color)
                    .annotation(position: .trailing) {
                        if item.count > 0 {
                            Text("\(item.count)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .frame(height: 100)
            .chartXAxis(.hidden)
            .padding(.horizontal)
        }
    }

    // MARK: - Sortable Header

    private var sortableHeader: some View {
        HStack(spacing: 0) {
            sortableColumn(.name, flex: 3)
            sortableColumn(.cpu, flex: 1)
            sortableColumn(.memory, flex: 1)
            sortableColumn(.totalJobs, flex: 1)
        }
        .padding(.vertical, 4)
    }

    private func sortableColumn(_ field: UtilizationViewModel.SortField, flex: CGFloat) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                viewModel.toggleSort(field)
            }
        } label: {
            HStack(spacing: 3) {
                Text(field.label)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(viewModel.sortField == field ? .primary : .secondary)

                if let icon = viewModel.sortIcon(for: field) {
                    Image(systemName: icon)
                        .font(.caption2)
                        .foregroundStyle(.primary)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .layoutPriority(flex)
    }

    // MARK: - Utilization Row

    private func utilizationRow(_ report: UtilizationReport) -> some View {
        VStack(spacing: 6) {
            HStack(spacing: 0) {
                // Name column
                VStack(alignment: .leading, spacing: 2) {
                    Text(report.name)
                        .font(.caption)
                        .lineLimit(2)

                    if viewModel.selectedGroupBy == .workflow {
                        let level = viewModel.utilizationLevel(cpu: report.avgCpu, memory: report.avgMemory)
                        HStack(spacing: 4) {
                            Circle()
                                .fill(level.color)
                                .frame(width: 6, height: 6)
                            Text(level.text)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(3)

                // CPU column
                metricCell(
                    formatted: report.cpuFormatted,
                    rawValue: report.avgCpu,
                    color: Self.cpuColor(report.avgCpu)
                )
                .layoutPriority(1)

                // Memory column
                metricCell(
                    formatted: report.memoryFormatted,
                    rawValue: report.avgMemory,
                    color: Self.memoryColor(report.avgMemory)
                )
                .layoutPriority(1)

                // Jobs column
                Text(report.totalJobs.map { Self.formatJobCount($0) } ?? "N/A")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .layoutPriority(1)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(report.name), CPU \(report.cpuFormatted), Memory \(report.memoryFormatted), \(report.totalJobs.map { "\($0) jobs" } ?? "no job data")")
    }

    /// Reusable metric cell with value and mini progress bar.
    private func metricCell(formatted: String, rawValue: Double?, color: Color) -> some View {
        VStack(spacing: 2) {
            Text(formatted)
                .font(.caption.monospacedDigit())
                .foregroundStyle(color)

            if let value = rawValue {
                ProgressView(value: value, total: 100)
                    .tint(color)
                    .frame(width: 36)
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Color Helpers (static for nested struct access)

    static func gaugeColor(_ value: Double, warningAt: Double, criticalAt: Double) -> Color {
        if value >= criticalAt { return AppColors.failure }
        if value >= warningAt { return AppColors.unstable }
        return AppColors.success
    }

    static func cpuColor(_ value: Double?) -> Color {
        guard let value else { return .secondary }
        if value >= 80 { return AppColors.failure }
        if value >= 60 { return AppColors.unstable }
        return AppColors.success
    }

    static func memoryColor(_ value: Double?) -> Color {
        guard let value else { return .secondary }
        if value >= 85 { return AppColors.failure }
        if value >= 65 { return AppColors.unstable }
        return AppColors.success
    }

    static func formatJobCount(_ count: Int) -> String {
        if count >= 1_000_000 {
            return String(format: "%.1fM", Double(count) / 1_000_000)
        } else if count >= 1_000 {
            return String(format: "%.1fK", Double(count) / 1_000)
        }
        return "\(count)"
    }
}

// MARK: - Workflow Detail View

struct WorkflowUtilizationDetailView: View {
    let report: UtilizationReport
    @Environment(\.dismiss) private var dismiss
    @StateObject private var viewModel = WorkflowDetailViewModel()

    var body: some View {
        List {
            // Summary section
            Section {
                VStack(spacing: 12) {
                    HStack(spacing: 20) {
                        metricSummary(
                            label: "Avg CPU",
                            value: report.cpuFormatted,
                            color: UtilizationView.cpuColor(report.avgCpu)
                        )
                        Spacer()
                        metricSummary(
                            label: "Avg Memory",
                            value: report.memoryFormatted,
                            color: UtilizationView.memoryColor(report.avgMemory)
                        )
                        Spacer()
                        metricSummary(
                            label: "Total Jobs",
                            value: report.totalJobs.map { UtilizationView.formatJobCount($0) } ?? "N/A",
                            color: .primary
                        )
                    }

                    if let cpu = report.avgCpu, let mem = report.avgMemory {
                        VStack(spacing: 8) {
                            progressRow(label: "CPU Utilization", value: cpu, color: UtilizationView.cpuColor(report.avgCpu))
                            progressRow(label: "Memory Utilization", value: mem, color: UtilizationView.memoryColor(report.avgMemory))
                        }
                        .padding(.top, 8)
                    }
                }
                .padding(.vertical, 8)
            }

            // Job breakdown section
            Section {
                switch viewModel.state {
                case .idle:
                    Text("Loading job details...")
                        .foregroundStyle(.secondary)
                case .loading:
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                case .loaded:
                    if viewModel.jobs.isEmpty {
                        Text("No job details available")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(viewModel.jobs) { job in
                            jobRow(job)
                        }
                    }
                case .error(let message):
                    Text("Error: \(message)")
                        .foregroundStyle(.red)
                }
            } header: {
                Text("Job Breakdown")
            }
        }
        .navigationTitle(report.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") {
                    dismiss()
                }
            }
        }
        .task {
            await viewModel.loadJobs(workflowName: report.name)
        }
    }

    private func metricSummary(label: String, value: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title2.bold())
                .foregroundStyle(color)
        }
    }

    private func progressRow(label: String, value: Double, color: Color) -> some View {
        VStack(spacing: 4) {
            HStack {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(String(format: "%.1f%%", value))
                    .font(.caption.monospacedDigit())
            }
            ProgressView(value: value, total: 100)
                .tint(color)
        }
    }

    private func jobRow(_ job: UtilizationMetadataInfo) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(job.jobName ?? "Unknown Job")
                .font(.subheadline)

            HStack {
                Label("Job ID: \(job.jobId)", systemImage: "number")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                Spacer()

                if let time = job.time {
                    Text(time)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Workflow Detail ViewModel

@MainActor
final class WorkflowDetailViewModel: ObservableObject {
    enum ViewState: Equatable {
        case idle
        case loading
        case loaded
        case error(String)
    }

    @Published var state: ViewState = .idle
    @Published var jobs: [UtilizationMetadataInfo] = []

    private let apiClient: APIClientProtocol

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    func loadJobs(workflowName: String) async {
        state = .loading
        do {
            let endpoint = APIEndpoint.utilizationMetadata(workflowId: workflowName)
            let response: ListUtilizationMetadataInfoResponse = try await apiClient.fetch(endpoint)
            jobs = response.metadataList ?? []
            state = .loaded
        } catch {
            state = .error(error.localizedDescription)
        }
    }
}

// MARK: - API Models

struct ListUtilizationMetadataInfoResponse: Decodable {
    let metadataList: [UtilizationMetadataInfo]?

    enum CodingKeys: String, CodingKey {
        case metadataList = "metadata_list"
    }
}

#Preview {
    NavigationStack {
        UtilizationView()
    }
}
