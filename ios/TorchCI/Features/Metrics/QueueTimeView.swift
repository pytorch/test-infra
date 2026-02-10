import SwiftUI
import Charts

struct QueueTimeView: View {
    @StateObject private var viewModel = QueueTimeViewModel()

    var body: some View {
        Group {
            switch viewModel.state {
            case .loading:
                LoadingView(message: "Loading queue time data...")

            case .error(let message):
                ErrorView(error: NSError(domain: "", code: 0, userInfo: [
                    NSLocalizedDescriptionKey: message,
                ])) {
                    Task { await viewModel.loadData() }
                }

            case .loaded:
                queueTimeContent
            }
        }
        .navigationTitle("Queue Time")
        .navigationBarTitleDisplayMode(.large)
        .task {
            await viewModel.loadData()
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var queueTimeContent: some View {
        ScrollView {
            VStack(spacing: 16) {
                controlsSection

                summaryCards

                categoryBreakdownSection

                trendChart

                machineTypeBreakdownChart

                topWaitTimesSection

                machineTypeDetailList
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

            GranularityPicker(selection: $viewModel.granularity)
        }
        .onChange(of: viewModel.selectedTimeRange) {
            viewModel.onParametersChanged()
        }
        .onChange(of: viewModel.granularity) {
            viewModel.onParametersChanged()
        }
    }

    // MARK: - Summary Cards

    @ViewBuilder
    private var summaryCards: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                ScalarPanel(
                    label: "Avg Queue Time",
                    value: formatDuration(viewModel.avgQueueMinutes),
                    icon: "clock.arrow.circlepath",
                    valueColor: queueColor(viewModel.avgQueueMinutes)
                )

                ScalarPanel(
                    label: "P90 Queue Time",
                    value: formatDuration(viewModel.p90QueueMinutes),
                    icon: "gauge.with.needle",
                    valueColor: queueColor(viewModel.p90QueueMinutes)
                )
            }

            HStack(spacing: 10) {
                ScalarPanel(
                    label: "Max Wait",
                    value: formatDuration(viewModel.maxQueueMinutes),
                    icon: "exclamationmark.circle",
                    valueColor: AppColors.failure
                )

                ScalarPanel(
                    label: "Machine Types",
                    value: "\(viewModel.machineTypeBreakdown.count)",
                    icon: "server.rack",
                    valueColor: .primary
                )
            }

            if let worstMachine = viewModel.worstMachineType {
                problematicMachineAlert(worstMachine)
            }
        }
    }

    @ViewBuilder
    private func problematicMachineAlert(_ machine: QueueTimeViewModel.MachineTypeData) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(AppColors.failure)
                .font(.title3)

            VStack(alignment: .leading, spacing: 4) {
                Text("Longest Queue")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(machine.machineType)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
            }

            Spacer()

            Text(formatDuration(machine.avgMinutes))
                .font(.headline)
                .foregroundStyle(AppColors.failure)
        }
        .padding(12)
        .background(AppColors.failure.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Category Breakdown

    @ViewBuilder
    private var categoryBreakdownSection: some View {
        if !viewModel.categoryBreakdown.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(
                    title: "By Platform",
                    subtitle: "\(viewModel.categoryBreakdown.count) categories"
                )

                ForEach(viewModel.categoryBreakdown) { category in
                    categoryRow(category)
                }
            }
        }
    }

    @ViewBuilder
    private func categoryRow(_ category: QueueTimeViewModel.CategorySummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                HStack(spacing: 8) {
                    Image(systemName: categoryIcon(category.category))
                        .font(.subheadline)
                        .foregroundStyle(categoryColor(category.category))
                        .frame(width: 24)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(category.category)
                            .font(.subheadline.weight(.semibold))
                        Text("\(category.machineCount) machine type\(category.machineCount == 1 ? "" : "s")")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                Text(formatDuration(category.avgMinutes))
                    .font(.headline)
                    .foregroundStyle(queueColor(category.avgMinutes))
            }

            HStack(spacing: 12) {
                statLabel("Avg", value: formatDuration(category.avgMinutes))
                statLabel("P90", value: formatDuration(category.p90Minutes))
                statLabel("Max", value: formatDuration(category.maxMinutes))
            }

            GeometryReader { geometry in
                let avgRatio = min(category.avgMinutes / max(viewModel.maxOverallTime, 1), 1.0)
                let maxRatio = min(category.maxMinutes / max(viewModel.maxOverallTime, 1), 1.0)

                ZStack(alignment: .leading) {
                    Rectangle()
                        .fill(Color(.tertiarySystemBackground))

                    Rectangle()
                        .fill(categoryColor(category.category).opacity(0.3))
                        .frame(width: geometry.size.width * maxRatio)

                    Rectangle()
                        .fill(categoryColor(category.category))
                        .frame(width: geometry.size.width * avgRatio)
                }
                .clipShape(RoundedRectangle(cornerRadius: 3))
            }
            .frame(height: 6)
        }
        .padding(12)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func categoryIcon(_ category: String) -> String {
        switch category {
        case "GPU": return "cpu"
        case "Linux": return "terminal"
        case "macOS": return "desktopcomputer"
        case "Windows": return "pc"
        default: return "server.rack"
        }
    }

    // MARK: - Trend Chart

    @ViewBuilder
    private var trendChart: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Queue Time Trend")
                    .font(.headline)
                Spacer()
                if let trend = viewModel.trendPercentage {
                    HStack(spacing: 4) {
                        Image(systemName: trend > 0 ? "arrow.up.right" : "arrow.down.right")
                        Text(String(format: "%.1f%%", abs(trend)))
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(trend > 0 ? AppColors.failure : AppColors.success)
                }
            }

            if !viewModel.queueTimeSeries.isEmpty {
                Chart(viewModel.queueTimeSeries) { point in
                    LineMark(
                        x: .value("Time", point.date ?? Date()),
                        y: .value("Queue Time", (point.value ?? 0) / 60)
                    )
                    .foregroundStyle(.teal)
                    .interpolationMethod(.catmullRom)

                    AreaMark(
                        x: .value("Time", point.date ?? Date()),
                        y: .value("Queue Time", (point.value ?? 0) / 60)
                    )
                    .foregroundStyle(.teal.opacity(0.2))
                    .interpolationMethod(.catmullRom)

                    if let value = point.value, value / 60 > 30 {
                        PointMark(
                            x: .value("Time", point.date ?? Date()),
                            y: .value("Queue Time", value / 60)
                        )
                        .foregroundStyle(AppColors.failure)
                        .symbolSize(40)
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { value in
                        AxisValueLabel {
                            if let v = value.as(Double.self) {
                                Text("\(Int(v))m")
                            }
                        }
                        AxisGridLine()
                    }
                }
                .chartXAxis {
                    AxisMarks(position: .bottom) { _ in
                        AxisValueLabel(format: .dateTime.month().day())
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

    // MARK: - Machine Type Breakdown Chart

    @ViewBuilder
    private var machineTypeBreakdownChart: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Queue Time by Machine Type")
                    .font(.headline)
                Spacer()
                Menu {
                    Button {
                        viewModel.sortBy = .avgTime
                    } label: {
                        Label("Avg Time", systemImage: viewModel.sortBy == .avgTime ? "checkmark" : "")
                    }
                    Button {
                        viewModel.sortBy = .maxTime
                    } label: {
                        Label("Max Time", systemImage: viewModel.sortBy == .maxTime ? "checkmark" : "")
                    }
                    Button {
                        viewModel.sortBy = .name
                    } label: {
                        Label("Name", systemImage: viewModel.sortBy == .name ? "checkmark" : "")
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text("Sort")
                        Image(systemName: "arrow.up.arrow.down")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }

            if !viewModel.sortedMachineTypes.isEmpty {
                Chart(viewModel.sortedMachineTypes.prefix(8)) { item in
                    BarMark(
                        x: .value("Minutes", item.avgMinutes),
                        y: .value("Machine", item.shortName)
                    )
                    .foregroundStyle(
                        item.avgMinutes > 30 ? AppColors.failure :
                        item.avgMinutes > 15 ? AppColors.unstable :
                        .teal
                    )
                    .cornerRadius(4)
                    .annotation(position: .trailing, alignment: .leading) {
                        Text(formatDuration(item.avgMinutes))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .chartXAxis {
                    AxisMarks(position: .bottom, values: .automatic(desiredCount: 4)) { value in
                        AxisValueLabel {
                            if let v = value.as(Double.self) {
                                Text("\(Int(v))m")
                            }
                        }
                        AxisGridLine()
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { _ in
                        AxisValueLabel()
                    }
                }
                .frame(height: CGFloat(min(viewModel.sortedMachineTypes.count, 8)) * 45 + 20)
            } else {
                emptyChartPlaceholder
            }

            if viewModel.sortedMachineTypes.count > 8 {
                Text("Showing top 8 of \(viewModel.sortedMachineTypes.count) machine types")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }

    // MARK: - Top Wait Times

    @ViewBuilder
    private var topWaitTimesSection: some View {
        if !viewModel.topWaitTimes.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(
                    title: "Slowest Machines",
                    subtitle: "Top queue times"
                )

                LazyVStack(spacing: 8) {
                    ForEach(Array(viewModel.topWaitTimes.enumerated()), id: \.element.id) { index, machine in
                        topWaitTimeRow(machine, rank: index + 1)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func topWaitTimeRow(_ machine: QueueTimeViewModel.MachineTypeData, rank: Int) -> some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(rankColor(rank).opacity(0.2))
                    .frame(width: 32, height: 32)
                Text("\(rank)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(rankColor(rank))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(machine.machineType)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                HStack(spacing: 8) {
                    statBadge("Avg", value: formatDuration(machine.avgMinutes), color: queueColor(machine.avgMinutes))
                    statBadge("Max", value: formatDuration(machine.maxMinutes), color: AppColors.failure)
                }
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 2) {
                Text(formatDuration(machine.avgMinutes))
                    .font(.headline)
                    .foregroundStyle(queueColor(machine.avgMinutes))
                Image(systemName: "clock.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Machine Type Detail List

    @ViewBuilder
    private var machineTypeDetailList: some View {
        if !viewModel.sortedMachineTypes.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(
                    title: "All Machine Types",
                    subtitle: "\(viewModel.sortedMachineTypes.count) types"
                )

                LazyVStack(spacing: 8) {
                    ForEach(viewModel.sortedMachineTypes) { machine in
                        machineTypeDetailRow(machine)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func machineTypeDetailRow(_ machine: QueueTimeViewModel.MachineTypeData) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(machine.machineType)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(2)

                    if let category = machineCategory(machine.machineType) {
                        categoryBadge(category)
                    }
                }

                Spacer()

                Text(formatDuration(machine.avgMinutes))
                    .font(.headline)
                    .foregroundStyle(queueColor(machine.avgMinutes))
            }

            HStack(spacing: 12) {
                statLabel("Avg", value: formatDuration(machine.avgMinutes))
                statLabel("P50", value: formatDuration(machine.p50Minutes))
                statLabel("P90", value: formatDuration(machine.p90Minutes))
                statLabel("Max", value: formatDuration(machine.maxMinutes))
            }

            GeometryReader { geometry in
                let avgRatio = min(machine.avgMinutes / max(viewModel.maxOverallTime, 1), 1.0)
                let maxRatio = min(machine.maxMinutes / max(viewModel.maxOverallTime, 1), 1.0)

                ZStack(alignment: .leading) {
                    Rectangle()
                        .fill(Color(.tertiarySystemBackground))

                    Rectangle()
                        .fill(queueColor(machine.maxMinutes).opacity(0.3))
                        .frame(width: geometry.size.width * maxRatio)

                    Rectangle()
                        .fill(queueColor(machine.avgMinutes))
                        .frame(width: geometry.size.width * avgRatio)
                }
                .clipShape(RoundedRectangle(cornerRadius: 3))
            }
            .frame(height: 6)
        }
        .padding(12)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Helpers

    @ViewBuilder
    private var emptyChartPlaceholder: some View {
        RoundedRectangle(cornerRadius: 8)
            .fill(Color(.secondarySystemBackground))
            .frame(height: 160)
            .overlay {
                VStack(spacing: 8) {
                    Image(systemName: "clock.badge.questionmark")
                        .font(.system(size: 32))
                        .foregroundStyle(.secondary)
                    Text("No data available")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
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

    @ViewBuilder
    private func statBadge(_ title: String, value: String, color: Color = .secondary) -> some View {
        HStack(spacing: 4) {
            Text(title)
                .foregroundStyle(.secondary)
            Text(value)
                .foregroundStyle(color)
        }
        .font(.caption2)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color(.tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    @ViewBuilder
    private func categoryBadge(_ category: String) -> some View {
        Text(category)
            .font(.caption2.weight(.medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(categoryColor(category))
            .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private func formatDuration(_ minutes: Double?) -> String {
        guard let minutes else { return "--" }
        let totalMinutes = Int(minutes)
        if totalMinutes >= 1440 {
            let days = totalMinutes / 1440
            let hours = (totalMinutes % 1440) / 60
            if hours > 0 {
                return "\(days)d \(hours)h"
            }
            return "\(days)d"
        }
        if totalMinutes >= 60 {
            let hours = totalMinutes / 60
            let mins = totalMinutes % 60
            if mins > 0 {
                return "\(hours)h \(mins)m"
            }
            return "\(hours)h"
        }
        if totalMinutes < 1 {
            return "< 1m"
        }
        return "\(totalMinutes)m"
    }

    private func queueColor(_ minutes: Double?) -> Color {
        guard let minutes else { return .secondary }
        if minutes > 30 { return AppColors.failure }
        if minutes > 15 { return AppColors.unstable }
        if minutes > 5 { return .orange }
        return AppColors.success
    }

    private func rankColor(_ rank: Int) -> Color {
        switch rank {
        case 1: return AppColors.failure
        case 2: return AppColors.unstable
        case 3: return .orange
        default: return .secondary
        }
    }

    private func machineCategory(_ machineType: String) -> String? {
        let lower = machineType.lowercased()
        if lower.contains("gpu") || lower.contains("cuda") || lower.contains("h100") || lower.contains("a100") || lower.contains("rocm") {
            return "GPU"
        }
        if lower.contains("linux") {
            return "Linux"
        }
        if lower.contains("macos") || lower.contains("darwin") {
            return "macOS"
        }
        if lower.contains("windows") {
            return "Windows"
        }
        return nil
    }

    private func categoryColor(_ category: String) -> Color {
        switch category {
        case "GPU": return .purple
        case "Linux": return .blue
        case "macOS": return .teal
        case "Windows": return .cyan
        default: return .gray
        }
    }
}

// MARK: - ViewModel

@MainActor
final class QueueTimeViewModel: ObservableObject {
    enum ViewState: Equatable {
        case loading
        case loaded
        case error(String)

        static func == (lhs: ViewState, rhs: ViewState) -> Bool {
            switch (lhs, rhs) {
            case (.loading, .loading): return true
            case (.loaded, .loaded): return true
            case (.error(let a), .error(let b)): return a == b
            default: return false
            }
        }
    }

    enum SortOption {
        case avgTime
        case maxTime
        case name
    }

    struct MachineTypeData: Identifiable {
        let id = UUID()
        let machineType: String
        let avgMinutes: Double
        let p50Minutes: Double
        let p90Minutes: Double
        let maxMinutes: Double
        let dataPoints: Int

        var shortName: String {
            if machineType.count > 25 {
                let parts = machineType.split(separator: ".")
                if parts.count > 2 {
                    return String(parts.suffix(2).joined(separator: "."))
                }
            }
            return machineType
        }
    }

    struct CategorySummary: Identifiable {
        let id: String
        let category: String
        let avgMinutes: Double
        let p90Minutes: Double
        let maxMinutes: Double
        let machineCount: Int
        let totalDataPoints: Int
    }

    struct QueueTimeResponse: Decodable {
        let granularity_bucket: String
        let avg_queue_s: Double
        let machine_type: String
    }

    @Published var state: ViewState = .loading
    @Published var selectedTimeRange: String = "7d"
    @Published var granularity: TimeGranularity = .day
    @Published var sortBy: SortOption = .avgTime

    @Published var queueTimeSeries: [TimeSeriesDataPoint] = []
    @Published var machineTypeBreakdown: [MachineTypeData] = []
    @Published var avgQueueMinutes: Double?
    @Published var p90QueueMinutes: Double?
    @Published var maxQueueMinutes: Double?

    private let apiClient: APIClientProtocol
    private var loadTask: Task<Void, Never>?

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    var selectedRange: TimeRange? {
        TimeRange.presets.first { $0.id == selectedTimeRange }
    }

    private var timeRangeTuple: (startTime: String, stopTime: String) {
        let days = selectedRange?.days ?? 7
        return APIEndpoint.timeRange(days: days)
    }

    var sortedMachineTypes: [MachineTypeData] {
        switch sortBy {
        case .avgTime:
            return machineTypeBreakdown.sorted { $0.avgMinutes > $1.avgMinutes }
        case .maxTime:
            return machineTypeBreakdown.sorted { $0.maxMinutes > $1.maxMinutes }
        case .name:
            return machineTypeBreakdown.sorted { $0.machineType < $1.machineType }
        }
    }

    var topWaitTimes: [MachineTypeData] {
        Array(sortedMachineTypes.prefix(5))
    }

    var worstMachineType: MachineTypeData? {
        machineTypeBreakdown.max(by: { $0.avgMinutes < $1.avgMinutes })
    }

    var maxOverallTime: Double {
        machineTypeBreakdown.map(\.maxMinutes).max() ?? 1.0
    }

    var categoryBreakdown: [CategorySummary] {
        var groups: [String: [MachineTypeData]] = [:]
        for machine in machineTypeBreakdown {
            let cat = Self.categorize(machine.machineType)
            groups[cat, default: []].append(machine)
        }
        return groups.map { category, machines in
            let totalPoints = machines.reduce(0) { $0 + $1.dataPoints }
            let weightedAvg = machines.reduce(0.0) { $0 + $1.avgMinutes * Double($1.dataPoints) }
                / Double(max(totalPoints, 1))
            let allP90 = machines.map(\.p90Minutes).sorted()
            let p90Index = min(Int(Double(allP90.count) * 0.9), allP90.count - 1)
            let p90Val = allP90.isEmpty ? 0.0 : allP90[max(p90Index, 0)]
            let maxVal = machines.map(\.maxMinutes).max() ?? 0
            return CategorySummary(
                id: category,
                category: category,
                avgMinutes: weightedAvg,
                p90Minutes: p90Val,
                maxMinutes: maxVal,
                machineCount: machines.count,
                totalDataPoints: totalPoints
            )
        }.sorted { $0.avgMinutes > $1.avgMinutes }
    }

    static func categorize(_ machineType: String) -> String {
        let lower = machineType.lowercased()
        if lower.contains("gpu") || lower.contains("cuda") || lower.contains("h100")
            || lower.contains("a100") || lower.contains("rocm") {
            return "GPU"
        }
        if lower.contains("macos") || lower.contains("darwin") {
            return "macOS"
        }
        if lower.contains("windows") {
            return "Windows"
        }
        if lower.contains("linux") {
            return "Linux"
        }
        return "Other"
    }

    var trendPercentage: Double? {
        guard queueTimeSeries.count >= 2 else { return nil }
        let recent = queueTimeSeries.suffix(queueTimeSeries.count / 3)
        let older = queueTimeSeries.prefix(queueTimeSeries.count / 3)

        let recentAvg = recent.compactMap(\.value).reduce(0, +) / Double(max(recent.count, 1))
        let olderAvg = older.compactMap(\.value).reduce(0, +) / Double(max(older.count, 1))

        guard olderAvg > 0 else { return nil }
        return ((recentAvg - olderAvg) / olderAvg) * 100
    }

    func loadData() async {
        state = .loading
        await fetchAllData()
    }

    func refresh() async {
        await fetchAllData()
    }

    func onParametersChanged() {
        loadTask?.cancel()
        loadTask = Task { await fetchAllData() }
    }

    private func fetchAllData() async {
        do {
            let rawData = try await fetchQueueTimeData()
            guard !Task.isCancelled else { return }

            queueTimeSeries = computeOverallTimeSeries(from: rawData)
            machineTypeBreakdown = computeMachineTypeBreakdown(from: rawData)
            computeSummary(from: rawData)

            state = .loaded
        } catch is CancellationError {
            // Task was cancelled — don't update state
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    private func fetchQueueTimeData() async throws -> [QueueTimeResponse] {
        let range = timeRangeTuple
        return try await apiClient.fetch(
            .clickhouseQuery(
                name: "queue_times_historical",
                parameters: [
                    "startTime": range.startTime,
                    "stopTime": range.stopTime,
                    "granularity": granularity.rawValue,
                ] as [String: Any]
            )
        )
    }

    private func computeOverallTimeSeries(from data: [QueueTimeResponse]) -> [TimeSeriesDataPoint] {
        var bucketMap: [String: [Double]] = [:]

        for item in data {
            bucketMap[item.granularity_bucket, default: []].append(item.avg_queue_s)
        }

        return bucketMap.map { bucket, values in
            let avgValue = values.reduce(0, +) / Double(values.count)
            return TimeSeriesDataPoint(granularity_bucket: bucket, value: avgValue)
        }.sorted { $0.granularity_bucket < $1.granularity_bucket }
    }

    private func computeMachineTypeBreakdown(from data: [QueueTimeResponse]) -> [MachineTypeData] {
        var machineMap: [String: [Double]] = [:]

        for item in data {
            machineMap[item.machine_type, default: []].append(item.avg_queue_s)
        }

        return machineMap.map { machineType, values in
            let sorted = values.sorted()
            let avg = values.reduce(0, +) / Double(values.count)
            let p50 = Self.percentile(sorted, p: 0.5)
            let p90 = Self.percentile(sorted, p: 0.9)
            let maxVal = sorted.last ?? 0

            return MachineTypeData(
                machineType: machineType,
                avgMinutes: avg / 60,
                p50Minutes: p50 / 60,
                p90Minutes: p90 / 60,
                maxMinutes: maxVal / 60,
                dataPoints: values.count
            )
        }
    }

    /// Linear interpolation percentile on a pre-sorted array of values.
    private static func percentile(_ sorted: [Double], p: Double) -> Double {
        guard !sorted.isEmpty else { return 0 }
        if sorted.count == 1 { return sorted[0] }
        let rank = p * Double(sorted.count - 1)
        let lower = Int(rank)
        let upper = min(lower + 1, sorted.count - 1)
        let fraction = rank - Double(lower)
        return sorted[lower] + fraction * (sorted[upper] - sorted[lower])
    }

    private func computeSummary(from data: [QueueTimeResponse]) {
        let values = data.map(\.avg_queue_s)
        guard !values.isEmpty else {
            avgQueueMinutes = nil
            p90QueueMinutes = nil
            maxQueueMinutes = nil
            return
        }

        let avg = values.reduce(0, +) / Double(values.count)
        let sorted = values.sorted()
        let p90Index = min(Int(Double(sorted.count) * 0.9), sorted.count - 1)
        let p90 = sorted[p90Index]
        let maxVal = sorted.last ?? 0

        avgQueueMinutes = avg / 60
        p90QueueMinutes = p90 / 60
        maxQueueMinutes = maxVal / 60
    }
}

#Preview {
    NavigationStack {
        QueueTimeView()
    }
}
