import SwiftUI
import Charts

struct TTSView: View {
    @StateObject private var viewModel = TTSViewModel()

    var body: some View {
        Group {
            switch viewModel.state {
            case .loading:
                LoadingView(message: "Loading time-to-signal data...")

            case .error(let message):
                ErrorView(error: NSError(domain: "", code: 0, userInfo: [
                    NSLocalizedDescriptionKey: message,
                ])) {
                    Task { await viewModel.loadData() }
                }

            case .loaded:
                ttsContent
            }
        }
        .navigationTitle("Time-to-Signal")
        .navigationBarTitleDisplayMode(.large)
        .task {
            await viewModel.loadData()
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var ttsContent: some View {
        ScrollView {
            VStack(spacing: 16) {
                controlsSection

                summaryRow

                ttsChart

                durationChart

                distributionChart

                percentileIndicators

                slowestJobsChart

                slowestJobsSection
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

            HStack(spacing: 12) {
                Picker("Percentile", selection: $viewModel.selectedPercentile) {
                    ForEach(TTSViewModel.Percentile.allCases, id: \.self) { percentile in
                        Text(percentile.displayName).tag(percentile)
                    }
                }
                .pickerStyle(.segmented)
            }

            if !viewModel.availableJobs.isEmpty {
                Picker("Job Filter", selection: $viewModel.selectedJobFilter) {
                    Text("All Jobs (\(viewModel.availableJobs.count))").tag(String?.none)
                    ForEach(viewModel.topJobsByTTS.prefix(20), id: \.self) { job in
                        Text(job).tag(Optional(job))
                    }
                }
                .pickerStyle(.menu)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            GranularityPicker(selection: $viewModel.granularity)
        }
        .onChange(of: viewModel.selectedTimeRange) {
            viewModel.onParametersChanged()
        }
        .onChange(of: viewModel.selectedPercentile) {
            viewModel.onParametersChanged()
        }
        .onChange(of: viewModel.selectedJobFilter) {
            viewModel.applyJobFilter()
        }
        .onChange(of: viewModel.granularity) {
            viewModel.onParametersChanged()
        }
    }

    // MARK: - Summary

    @ViewBuilder
    private var summaryRow: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                ScalarPanel(
                    label: "\(viewModel.selectedPercentile.displayName) TTS",
                    value: TTSFormatting.formatDuration(viewModel.currentTTSSeconds),
                    icon: "clock",
                    valueColor: TTSFormatting.ttsColor(viewModel.currentTTSSeconds)
                )

                ScalarPanel(
                    label: "Median",
                    value: TTSFormatting.formatDuration(viewModel.medianTTS),
                    icon: "chart.bar",
                    valueColor: TTSFormatting.ttsColor(viewModel.medianTTS)
                )

                ScalarPanel(
                    label: "P90",
                    value: TTSFormatting.formatDuration(viewModel.p90TTS),
                    icon: "exclamationmark.triangle",
                    valueColor: TTSFormatting.ttsColor(viewModel.p90TTS)
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
                    label: "Range",
                    value: viewModel.ttsRangeDescription,
                    icon: "arrow.left.and.right",
                    caption: "min-max"
                )

                ScalarPanel(
                    label: "Data Points",
                    value: "\(viewModel.ttsSeries.count)",
                    icon: "chart.xyaxis.line",
                    caption: "\(viewModel.availableJobs.count) jobs"
                )
            }
        }
    }

    // MARK: - TTS Chart

    @ViewBuilder
    private var ttsChart: some View {
        TimeSeriesChart(
            title: "Time-to-Signal (\(viewModel.selectedPercentile.displayName))",
            data: viewModel.ttsSeries,
            color: .orange,
            valueFormat: .duration,
            chartHeight: 280
        )
    }

    // MARK: - Duration Chart

    @ViewBuilder
    private var durationChart: some View {
        TimeSeriesChart(
            title: "Job Duration (\(viewModel.selectedPercentile.displayName))",
            data: viewModel.durationSeries,
            color: .blue,
            valueFormat: .duration,
            chartHeight: 280
        )
    }

    // MARK: - Distribution Chart with Area Bands

    @ViewBuilder
    private var distributionChart: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("TTS Distribution Bands")
                    .font(.headline)
                Spacer()
                Text("P50 / P75 / P90")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if !viewModel.distributionBands.isEmpty {
                Chart {
                    // P75-P90 area band (wider, lighter red)
                    ForEach(viewModel.distributionBands, id: \.bucket) { band in
                        AreaMark(
                            x: .value("Date", band.bucket),
                            yStart: .value("P75", band.p75),
                            yEnd: .value("P90", band.p90)
                        )
                        .foregroundStyle(Color.red.opacity(0.15))
                        .interpolationMethod(.catmullRom)
                    }

                    // P50-P75 area band (narrower, lighter orange)
                    ForEach(viewModel.distributionBands, id: \.bucket) { band in
                        AreaMark(
                            x: .value("Date", band.bucket),
                            yStart: .value("P50", band.p50),
                            yEnd: .value("P75", band.p75)
                        )
                        .foregroundStyle(Color.orange.opacity(0.15))
                        .interpolationMethod(.catmullRom)
                    }

                    // P50 line
                    ForEach(viewModel.p50Series, id: \.granularity_bucket) { point in
                        if let value = point.value {
                            LineMark(
                                x: .value("Date", point.granularity_bucket),
                                y: .value("Seconds", value),
                                series: .value("Percentile", "P50")
                            )
                            .foregroundStyle(Color.green)
                            .lineStyle(StrokeStyle(lineWidth: 2))
                        }
                    }

                    // P75 line
                    ForEach(viewModel.p75Series, id: \.granularity_bucket) { point in
                        if let value = point.value {
                            LineMark(
                                x: .value("Date", point.granularity_bucket),
                                y: .value("Seconds", value),
                                series: .value("Percentile", "P75")
                            )
                            .foregroundStyle(Color.orange)
                            .lineStyle(StrokeStyle(lineWidth: 2))
                        }
                    }

                    // P90 line
                    ForEach(viewModel.p90Series, id: \.granularity_bucket) { point in
                        if let value = point.value {
                            LineMark(
                                x: .value("Date", point.granularity_bucket),
                                y: .value("Seconds", value),
                                series: .value("Percentile", "P90")
                            )
                            .foregroundStyle(Color.red)
                            .lineStyle(StrokeStyle(lineWidth: 2))
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
                                Text(TTSFormatting.formatDuration(v))
                            }
                        }
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 5)) { value in
                        AxisValueLabel(format: .dateTime.month(.abbreviated).day())
                        AxisGridLine()
                    }
                }
                .frame(height: 260)
            } else {
                emptyChartPlaceholder
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }

    // MARK: - Percentile Indicators

    @ViewBuilder
    private var percentileIndicators: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Current Percentile Snapshot")
                .font(.headline)

            HStack(spacing: 0) {
                ForEach(viewModel.percentileSnapshot, id: \.label) { indicator in
                    VStack(spacing: 6) {
                        Text(indicator.label)
                            .font(.caption2.bold())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(indicator.color)
                            .clipShape(Capsule())

                        Text(TTSFormatting.formatDuration(indicator.value))
                            .font(.title3.bold())
                            .foregroundStyle(TTSFormatting.ttsColor(indicator.value))
                            .minimumScaleFactor(0.6)
                            .lineLimit(1)

                        Text(indicator.trend)
                            .font(.caption2)
                            .foregroundStyle(indicator.trend.hasPrefix("-") ? AppColors.success : (indicator.trend == "--" ? Color.secondary : AppColors.failure))
                    }
                    .frame(maxWidth: .infinity)
                }
            }

            // Visual gauge bar showing relative positions
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    // Background track
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color(.systemGray5))
                        .frame(height: 8)

                    // P50 fill
                    let maxVal = viewModel.percentileSnapshot.last?.value ?? 1.0
                    let p50Width = maxVal > 0 ? CGFloat((viewModel.percentileSnapshot.first?.value ?? 0) / maxVal) * geometry.size.width : 0
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.green.opacity(0.6))
                        .frame(width: max(p50Width, 4), height: 8)

                    // P75 marker
                    let p75Width = maxVal > 0 ? CGFloat((viewModel.percentileSnapshot.dropFirst().first?.value ?? 0) / maxVal) * geometry.size.width : 0
                    Circle()
                        .fill(Color.orange)
                        .frame(width: 12, height: 12)
                        .offset(x: max(p75Width - 6, 0))

                    // P90 marker
                    Circle()
                        .fill(Color.red)
                        .frame(width: 12, height: 12)
                        .offset(x: max(geometry.size.width - 12, 0))
                }
            }
            .frame(height: 16)
            .padding(.top, 4)
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }

    // MARK: - Slowest Jobs Bar Chart

    @ViewBuilder
    private var slowestJobsChart: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Top Bottlenecks")
                .font(.headline)

            if viewModel.slowestJobs.count >= 2 {
                let topJobs = Array(viewModel.slowestJobs.prefix(5))
                Chart {
                    ForEach(topJobs, id: \.name) { job in
                        BarMark(
                            x: .value("TTS", job.tts),
                            y: .value("Job", TTSFormatting.truncateJobName(job.name))
                        )
                        .foregroundStyle(TTSFormatting.ttsColor(job.tts))
                        .annotation(position: .trailing, alignment: .leading, spacing: 4) {
                            Text(TTSFormatting.formatDuration(job.tts))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 4)) { value in
                        AxisValueLabel {
                            if let v = value.as(Double.self) {
                                Text(TTSFormatting.formatDuration(v))
                            }
                        }
                    }
                }
                .chartYAxis {
                    AxisMarks { _ in
                        AxisValueLabel()
                            .font(.caption2)
                    }
                }
                .frame(height: CGFloat(topJobs.count) * 44)
            } else {
                emptyChartPlaceholder
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }

    // MARK: - Slowest Jobs Section (detailed list)

    @ViewBuilder
    private var slowestJobsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Slowest Signal Paths")
                    .font(.headline)
                Spacer()
                Text("\(viewModel.selectedPercentile.displayName)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color(.tertiarySystemBackground))
                    .clipShape(Capsule())
            }

            if viewModel.slowestJobs.isEmpty {
                Text("No data available")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding()
                    .background(Color(.secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            } else {
                ForEach(Array(viewModel.slowestJobs.enumerated()), id: \.offset) { index, job in
                    HStack(spacing: 12) {
                        Text("\(index + 1)")
                            .font(.caption.bold())
                            .foregroundStyle(.white)
                            .frame(width: 24, height: 24)
                            .background(rankColor(index))
                            .clipShape(Circle())

                        VStack(alignment: .leading, spacing: 3) {
                            Text(job.name)
                                .font(.subheadline)
                                .lineLimit(2)

                            // Inline bar showing relative TTS
                            GeometryReader { geometry in
                                let maxTTS = viewModel.slowestJobs.first?.tts ?? 1
                                let fraction = maxTTS > 0 ? CGFloat(job.tts / maxTTS) : 0
                                RoundedRectangle(cornerRadius: 2)
                                    .fill(TTSFormatting.ttsColor(job.tts).opacity(0.3))
                                    .frame(width: geometry.size.width * fraction, height: 4)
                            }
                            .frame(height: 4)
                        }

                        Spacer()

                        Text(TTSFormatting.formatDuration(job.tts))
                            .font(.subheadline.bold())
                            .foregroundStyle(TTSFormatting.ttsColor(job.tts))
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(Color(.secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
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

    private func rankColor(_ index: Int) -> Color {
        switch index {
        case 0: return .red
        case 1: return .orange
        case 2: return .yellow
        default: return .gray
        }
    }
}

// MARK: - Formatting Helpers (internal for testability)

enum TTSFormatting {
    static func formatDuration(_ seconds: Double?) -> String {
        guard let seconds else { return "--" }
        let totalSeconds = Int(seconds)
        let hours = totalSeconds / 3600
        let minutes = (totalSeconds % 3600) / 60
        if hours > 0 {
            return "\(hours)h \(minutes)m"
        }
        if minutes > 0 {
            return "\(minutes)m"
        }
        return "\(totalSeconds)s"
    }

    static func ttsColor(_ seconds: Double?) -> Color {
        guard let seconds else { return .secondary }
        if seconds > 7200 { return AppColors.failure }       // > 2 hours
        if seconds > 3600 { return AppColors.unstable }       // > 1 hour
        return AppColors.success
    }

    static func truncateJobName(_ name: String, maxLength: Int = 30) -> String {
        if name.count <= maxLength { return name }
        // Try to find a meaningful segment after the last "/"
        let components = name.split(separator: "/")
        if let last = components.last, last.count <= maxLength {
            return String(last)
        }
        return String(name.suffix(maxLength))
    }
}

// MARK: - Distribution Band Data

struct TTSDistributionBand: Identifiable {
    let bucket: String
    let p50: Double
    let p75: Double
    let p90: Double

    var id: String { bucket }
}

// MARK: - Percentile Indicator Data

struct TTSPercentileIndicator: Identifiable {
    let label: String
    let value: Double
    let color: Color
    let trend: String

    var id: String { label }
}

// MARK: - ViewModel

@MainActor
final class TTSViewModel: ObservableObject {
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

    enum Percentile: String, CaseIterable {
        case p50
        case p75
        case p90
        case p99

        var displayName: String { rawValue.uppercased() }

        var percentileValue: Double {
            switch self {
            case .p50: return 0.5
            case .p75: return 0.75
            case .p90: return 0.9
            case .p99: return 0.99
            }
        }
    }

    struct JobTTSData: Hashable {
        let name: String
        let tts: Double
    }

    @Published var state: ViewState = .loading
    @Published var selectedTimeRange: String = "7d"
    @Published var selectedPercentile: Percentile = .p75
    @Published var selectedJobFilter: String?
    @Published var granularity: TimeGranularity = .day
    @Published var availableJobs: [String] = []
    @Published var topJobsByTTS: [String] = []

    @Published var ttsSeries: [TimeSeriesDataPoint] = []
    @Published var durationSeries: [TimeSeriesDataPoint] = []
    @Published var p50Series: [TimeSeriesDataPoint] = []
    @Published var p75Series: [TimeSeriesDataPoint] = []
    @Published var p90Series: [TimeSeriesDataPoint] = []
    @Published var slowestJobs: [JobTTSData] = []
    @Published var distributionBands: [TTSDistributionBand] = []

    private var allTTSData: [TTSJobDataPoint] = []
    private var allDurationData: [TTSJobDataPoint] = []
    let apiClient: APIClientProtocol
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

    var currentTTSSeconds: Double? {
        ttsSeries.last?.value
    }

    var medianTTS: Double? {
        let allValues = ttsSeries.compactMap(\.value)
        guard !allValues.isEmpty else { return nil }
        let sorted = allValues.sorted()
        return sorted[sorted.count / 2]
    }

    var p90TTS: Double? {
        let allValues = ttsSeries.compactMap(\.value)
        guard !allValues.isEmpty else { return nil }
        let sorted = allValues.sorted()
        let index = Int(Double(sorted.count) * 0.9)
        return sorted[min(index, sorted.count - 1)]
    }

    var minTTS: Double? {
        ttsSeries.compactMap(\.value).min()
    }

    var maxTTS: Double? {
        ttsSeries.compactMap(\.value).max()
    }

    var ttsRangeDescription: String {
        guard let minVal = minTTS, let maxVal = maxTTS else { return "--" }
        return "\(TTSFormatting.formatDuration(minVal))-\(TTSFormatting.formatDuration(maxVal))"
    }

    var isImproving: Bool {
        guard ttsSeries.count >= 2 else { return true }
        let recent = ttsSeries.suffix(3).compactMap(\.value)
        let earlier = ttsSeries.prefix(3).compactMap(\.value)
        guard let recentAvg = recent.isEmpty ? nil : recent.reduce(0, +) / Double(recent.count),
              let earlierAvg = earlier.isEmpty ? nil : earlier.reduce(0, +) / Double(earlier.count) else {
            return true
        }
        return recentAvg <= earlierAvg
    }

    var trendDescription: String {
        guard ttsSeries.count >= 2,
              let first = ttsSeries.first?.value, first > 0,
              let last = ttsSeries.last?.value else {
            return "--"
        }
        let change = ((last - first) / first) * 100
        return String(format: "%+.1f%%", change)
    }

    /// Snapshot of current percentile values with trends for the indicator panel
    var percentileSnapshot: [TTSPercentileIndicator] {
        let p50Val = p50Series.last?.value
        let p75Val = p75Series.last?.value
        let p90Val = p90Series.last?.value

        return [
            TTSPercentileIndicator(
                label: "P50",
                value: p50Val ?? 0,
                color: .green,
                trend: computeSeriesTrend(p50Series)
            ),
            TTSPercentileIndicator(
                label: "P75",
                value: p75Val ?? 0,
                color: .orange,
                trend: computeSeriesTrend(p75Series)
            ),
            TTSPercentileIndicator(
                label: "P90",
                value: p90Val ?? 0,
                color: .red,
                trend: computeSeriesTrend(p90Series)
            ),
        ]
    }

    func computeSeriesTrend(_ series: [TimeSeriesDataPoint]) -> String {
        guard series.count >= 2,
              let first = series.first?.value, first > 0,
              let last = series.last?.value else {
            return "--"
        }
        let change = ((last - first) / first) * 100
        return String(format: "%+.1f%%", change)
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

    func applyJobFilter() {
        aggregateData()
    }

    private func fetchAllData() async {
        do {
            let range = timeRangeTuple
            let ignoredWorkflows = [
                "Upload test stats",
                "Upload torch dynamo performance stats",
                "Validate and merge PR",
                "Revert merged PR",
            ]
            let params: [String: Any] = [
                "branch": "main",
                "granularity": granularity.rawValue,
                "percentile": selectedPercentile.percentileValue,
                "repo": "pytorch/pytorch",
                "startTime": range.startTime,
                "stopTime": range.stopTime,
                "ignoredWorkflows": ignoredWorkflows,
            ]

            let client = apiClient
            let rawData: [TTSJobDataPoint] = try await client.fetch(
                .clickhouseQuery(
                    name: "tts_duration_historical_percentile",
                    parameters: params
                )
            )

            allTTSData = rawData
            allDurationData = rawData

            // Extract unique job names
            let jobNames = Set(rawData.map(\.full_name)).sorted()
            availableJobs = jobNames

            // Calculate slowest jobs based on latest TTS values
            calculateSlowestJobs(from: rawData)

            // Aggregate percentile data
            let client2 = apiClient
            async let p50 = fetchPercentileData(.p50, client: client2)
            async let p75 = fetchPercentileData(.p75, client: client2)
            async let p90 = fetchPercentileData(.p90, client: client2)

            let (p50Result, p75Result, p90Result) = try await (p50, p75, p90)
            guard !Task.isCancelled else { return }
            p50Series = p50Result
            p75Series = p75Result
            p90Series = p90Result

            // Build distribution bands from the percentile data
            buildDistributionBands()

            aggregateData()

            state = .loaded
        } catch is CancellationError {
            // Task was cancelled — don't update state
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    private func fetchPercentileData(_ percentile: Percentile, client: APIClientProtocol) async throws -> [TimeSeriesDataPoint] {
        let range = timeRangeTuple
        let ignoredWorkflows = [
            "Upload test stats",
            "Upload torch dynamo performance stats",
            "Validate and merge PR",
            "Revert merged PR",
        ]
        let params: [String: Any] = [
            "branch": "main",
            "granularity": granularity.rawValue,
            "percentile": percentile.percentileValue,
            "repo": "pytorch/pytorch",
            "startTime": range.startTime,
            "stopTime": range.stopTime,
            "ignoredWorkflows": ignoredWorkflows,
        ]

        let rawData: [TTSJobDataPoint] = try await client.fetch(
            .clickhouseQuery(
                name: "tts_duration_historical_percentile",
                parameters: params
            )
        )

        // Aggregate across all jobs per time bucket
        let grouped = Dictionary(grouping: rawData, by: \.granularity_bucket)
        return grouped.map { bucket, points in
            let avgTTS = points.compactMap(\.tts_percentile_sec).reduce(0, +) / Double(max(points.count, 1))
            return TimeSeriesDataPoint(granularity_bucket: bucket, value: avgTTS)
        }
        .sorted { $0.granularity_bucket < $1.granularity_bucket }
    }

    private func buildDistributionBands() {
        // Create a lookup from bucket -> value for each percentile
        let p50Map = Dictionary(uniqueKeysWithValues: p50Series.compactMap { point -> (String, Double)? in
            guard let val = point.value else { return nil }
            return (point.granularity_bucket, val)
        })
        let p75Map = Dictionary(uniqueKeysWithValues: p75Series.compactMap { point -> (String, Double)? in
            guard let val = point.value else { return nil }
            return (point.granularity_bucket, val)
        })
        let p90Map = Dictionary(uniqueKeysWithValues: p90Series.compactMap { point -> (String, Double)? in
            guard let val = point.value else { return nil }
            return (point.granularity_bucket, val)
        })

        // Use all buckets from any percentile series
        let allBuckets = Set(p50Map.keys).union(p75Map.keys).union(p90Map.keys).sorted()

        distributionBands = allBuckets.compactMap { bucket in
            guard let p50 = p50Map[bucket],
                  let p75 = p75Map[bucket],
                  let p90 = p90Map[bucket] else {
                return nil
            }
            return TTSDistributionBand(bucket: bucket, p50: p50, p75: p75, p90: p90)
        }
    }

    private func aggregateData() {
        let filteredTTS: [TTSJobDataPoint]
        let filteredDuration: [TTSJobDataPoint]

        if let filter = selectedJobFilter {
            filteredTTS = allTTSData.filter { $0.full_name == filter }
            filteredDuration = allDurationData.filter { $0.full_name == filter }
        } else {
            filteredTTS = allTTSData
            filteredDuration = allDurationData
        }

        // Aggregate TTS data across all jobs per time bucket
        let ttsGrouped = Dictionary(grouping: filteredTTS, by: \.granularity_bucket)
        ttsSeries = ttsGrouped.map { bucket, points in
            let avgTTS = points.compactMap(\.tts_percentile_sec).reduce(0, +) / Double(max(points.count, 1))
            return TimeSeriesDataPoint(granularity_bucket: bucket, value: avgTTS)
        }
        .sorted { $0.granularity_bucket < $1.granularity_bucket }

        // Aggregate Duration data across all jobs per time bucket
        let durationGrouped = Dictionary(grouping: filteredDuration, by: \.granularity_bucket)
        durationSeries = durationGrouped.map { bucket, points in
            let avgDuration = points.compactMap(\.duration_percentile_sec).reduce(0, +) / Double(max(points.count, 1))
            return TimeSeriesDataPoint(granularity_bucket: bucket, value: avgDuration)
        }
        .sorted { $0.granularity_bucket < $1.granularity_bucket }
    }

    private func calculateSlowestJobs(from data: [TTSJobDataPoint]) {
        // Group by job name and get the latest average TTS
        let jobGroups = Dictionary(grouping: data, by: \.full_name)
        var jobAverages: [(name: String, tts: Double)] = []

        for (jobName, points) in jobGroups {
            let avgTTS = points.compactMap(\.tts_percentile_sec).reduce(0, +) / Double(max(points.count, 1))
            jobAverages.append((name: jobName, tts: avgTTS))
        }

        // Sort by TTS descending and take top 10
        let sorted = jobAverages.sorted { $0.tts > $1.tts }
        slowestJobs = sorted.prefix(10).map { JobTTSData(name: $0.name, tts: $0.tts) }
        topJobsByTTS = sorted.map(\.name)
    }
}

// MARK: - Data Models

struct TTSJobDataPoint: Decodable {
    let granularity_bucket: String
    let tts_percentile_sec: Double?
    let duration_percentile_sec: Double?
    let full_name: String
}

#Preview {
    NavigationStack {
        TTSView()
    }
}
