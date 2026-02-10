import SwiftUI
import Charts

struct NightliesView: View {
    @StateObject private var viewModel = NightliesViewModel()

    var body: some View {
        contentBody
            .navigationTitle("Nightly Builds")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    timeRangeMenu
                }
            }
            .task { await viewModel.loadData() }
    }

    // MARK: - Time Range Menu

    private var timeRangeMenu: some View {
        Menu {
            ForEach(NightliesViewModel.TimeRangeOption.allCases) { option in
                Button {
                    Task {
                        viewModel.selectedTimeRange = option
                        await viewModel.refresh()
                    }
                } label: {
                    if viewModel.selectedTimeRange == option {
                        Label(option.label, systemImage: "checkmark")
                    } else {
                        Text(option.label)
                    }
                }
            }
        } label: {
            Label(viewModel.selectedTimeRange.shortLabel, systemImage: "calendar")
                .font(.subheadline.weight(.medium))
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var contentBody: some View {
        switch viewModel.state {
        case .idle:
            EmptyStateView(
                icon: "moon.stars",
                title: "Nightly Builds",
                message: "Loading nightly build status..."
            )

        case .loading:
            LoadingView(message: "Fetching nightly status...")

        case .loaded:
            nightliesContent

        case .error(let message):
            ErrorView(error: NSError(domain: "", code: 0, userInfo: [NSLocalizedDescriptionKey: message])) {
                Task { await viewModel.refresh() }
            }
        }
    }

    // MARK: - Main Content

    private var nightliesContent: some View {
        List {
            // Overall Health Summary
            Section {
                overallHealthCard
            }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)

            // PyTorch Section
            if !viewModel.pytorchTrend.isEmpty || !viewModel.pytorchFailedJobs.isEmpty {
                repositorySection(
                    title: "PyTorch",
                    icon: "flame.fill",
                    trend: viewModel.pytorchTrend,
                    failedJobs: viewModel.pytorchFailedJobs,
                    color: .orange
                )
            }

            // Vision Section
            if !viewModel.visionTrend.isEmpty || !viewModel.visionFailedJobs.isEmpty {
                repositorySection(
                    title: "TorchVision",
                    icon: "eye.fill",
                    trend: viewModel.visionTrend,
                    failedJobs: viewModel.visionFailedJobs,
                    color: .blue
                )
            }

            // Audio Section
            if !viewModel.audioTrend.isEmpty || !viewModel.audioFailedJobs.isEmpty {
                repositorySection(
                    title: "TorchAudio",
                    icon: "waveform",
                    trend: viewModel.audioTrend,
                    failedJobs: viewModel.audioFailedJobs,
                    color: .purple
                )
            }

            // Platform Breakdown
            if !viewModel.platformBreakdown.isEmpty {
                Section {
                    ForEach(viewModel.platformBreakdown) { platform in
                        PlatformBreakdownRow(
                            platform: platform,
                            maxCount: viewModel.maxPlatformCount
                        )
                    }
                } header: {
                    Label("Failed Jobs by Platform", systemImage: "cpu")
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .textCase(nil)
                }
            }

            // Validation Jobs
            if !viewModel.releaseValidationJobs.isEmpty || !viewModel.nightlyValidationJobs.isEmpty {
                Section {
                    if !viewModel.releaseValidationJobs.isEmpty {
                        ValidationJobsSubsection(
                            title: "Release Validation Failures (24h)",
                            jobs: viewModel.releaseValidationJobs
                        )
                    }
                    if !viewModel.nightlyValidationJobs.isEmpty {
                        ValidationJobsSubsection(
                            title: "Nightly Validation Failures (24h)",
                            jobs: viewModel.nightlyValidationJobs
                        )
                    }
                } header: {
                    Label("Binary Validation", systemImage: "checkmark.seal.fill")
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .textCase(nil)
                }
            }

            // Failed Jobs by Name
            if !viewModel.failedJobsByName.isEmpty {
                Section {
                    ForEach(viewModel.failedJobsByName.prefix(20)) { job in
                        FailedJobRow(job: job)
                    }
                } header: {
                    HStack {
                        Label("Top Failed Jobs", systemImage: "exclamationmark.triangle.fill")
                            .font(.headline)
                            .foregroundStyle(.primary)
                        Spacer()
                        Text(viewModel.selectedTimeRange.label)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .textCase(nil)
                }
            }

            // Last Updated Footer
            if let lastUpdated = viewModel.lastUpdated {
                Section {
                    HStack {
                        Spacer()
                        Text("Updated \(lastUpdated, style: .relative) ago")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        Spacer()
                    }
                }
                .listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await viewModel.refresh() }
    }

    // MARK: - Overall Health Card

    private var overallHealthCard: some View {
        VStack(spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Overall Nightly Health")
                        .font(.headline)
                        .foregroundStyle(.secondary)

                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(viewModel.overallHealthPercentage)
                            .font(.system(size: 42, weight: .bold, design: .rounded))
                            .foregroundStyle(viewModel.overallHealthColor)
                            .contentTransition(.numericText())
                        Text("%")
                            .font(.title2.weight(.semibold))
                            .foregroundStyle(viewModel.overallHealthColor)
                    }

                    Text(viewModel.overallHealthStatus)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(viewModel.overallHealthColor)
                }

                Spacer()

                Image(systemName: viewModel.overallHealthIcon)
                    .font(.system(size: 50))
                    .foregroundStyle(viewModel.overallHealthColor.opacity(0.3))
                    .symbolEffect(.pulse, options: .repeating, isActive: viewModel.overallHealthIcon == "xmark.circle.fill")
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Overall nightly health: \(viewModel.overallHealthPercentage) percent. \(viewModel.overallHealthStatus)")

            Divider()

            HStack(spacing: 20) {
                HealthMetric(
                    label: "PyTorch",
                    value: viewModel.pytorchHealthPercentage,
                    color: viewModel.pytorchHealthColor
                )
                HealthMetric(
                    label: "Vision",
                    value: viewModel.visionHealthPercentage,
                    color: viewModel.visionHealthColor
                )
                HealthMetric(
                    label: "Audio",
                    value: viewModel.audioHealthPercentage,
                    color: viewModel.audioHealthColor
                )
            }

            // Total failures summary
            if viewModel.totalFailedJobCount > 0 {
                Divider()
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(Color.accentColor)
                    Text("\(viewModel.totalFailedJobCount) failed jobs across all repos in past 24h")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .cornerRadius(12)
        .shadow(color: Color.black.opacity(0.1), radius: 5, x: 0, y: 2)
        .padding(.horizontal)
        .padding(.vertical, 8)
    }

    // MARK: - Repository Section

    private func repositorySection(
        title: String,
        icon: String,
        trend: [NightlyTrendPoint],
        failedJobs: [FailedJob],
        color: Color
    ) -> some View {
        Section {
            if !trend.isEmpty {
                TrendChart(trend: trend, color: color)
                    .frame(height: 200)
                    .padding(.vertical, 8)
            }

            if !failedJobs.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Failed Jobs (Past 24h)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal)
                        .padding(.top, 8)

                    ForEach(failedJobs.prefix(5)) { job in
                        FailedJobRow(job: job)
                    }

                    if failedJobs.count > 5 {
                        ExpandableJobsList(
                            jobs: Array(failedJobs.dropFirst(5).prefix(15)),
                            totalCount: failedJobs.count
                        )
                    }
                }
            } else {
                HStack {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Text("No failed jobs in the past 24 hours")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 8)
            }
        } header: {
            HStack {
                Label(title, systemImage: icon)
                    .font(.headline)
                    .foregroundStyle(.primary)
                if !failedJobs.isEmpty {
                    Spacer()
                    Text("\(failedJobs.count) failures")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.red)
                }
            }
            .textCase(nil)
        }
    }
}

// MARK: - Health Metric

private struct HealthMetric: View {
    let label: String
    let value: String
    let color: Color

    var body: some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.title3.weight(.bold))
                .foregroundStyle(color)
                .contentTransition(.numericText())
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }
}

// MARK: - Trend Chart

private struct TrendChart: View {
    let trend: [NightlyTrendPoint]
    let color: Color

    private var averageRate: Double {
        guard !trend.isEmpty else { return 0 }
        return trend.reduce(0) { $0 + $1.failureRate } / Double(trend.count)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Failure Rate")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Text("avg \(Int(averageRate * 100))%")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color(.systemGray5))
                    .cornerRadius(4)
            }
            .padding(.horizontal)

            Chart {
                ForEach(trend) { point in
                    BarMark(
                        x: .value("Date", point.date),
                        y: .value("Failure Rate", point.failureRate)
                    )
                    .foregroundStyle(color.gradient)
                }

                RuleMark(y: .value("Average", averageRate))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [5, 3]))
                    .foregroundStyle(.secondary.opacity(0.5))
            }
            .chartYAxis {
                AxisMarks { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let percentage = value.as(Double.self) {
                            Text("\(Int(percentage * 100))%")
                                .font(.caption2)
                        }
                    }
                }
            }
            .chartXAxis {
                AxisMarks(values: .stride(by: .day)) { _ in
                    AxisGridLine()
                    AxisValueLabel(format: .dateTime.month(.abbreviated).day())
                        .font(.caption2)
                }
            }
            .padding(.horizontal)
        }
    }
}

// MARK: - Expandable Jobs List

private struct ExpandableJobsList: View {
    let jobs: [FailedJob]
    let totalCount: Int
    @State private var isExpanded = false

    var body: some View {
        if isExpanded {
            ForEach(jobs) { job in
                FailedJobRow(job: job)
            }

            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded = false
                }
            } label: {
                HStack {
                    Spacer()
                    Text("Show Less")
                        .font(.caption.weight(.medium))
                    Image(systemName: "chevron.up")
                        .font(.caption)
                    Spacer()
                }
                .foregroundStyle(Color.accentColor)
                .padding(.vertical, 4)
            }
        } else {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded = true
                }
            } label: {
                HStack {
                    Spacer()
                    Text("Show \(min(jobs.count, totalCount - 5)) More")
                        .font(.caption.weight(.medium))
                    Image(systemName: "chevron.down")
                        .font(.caption)
                    Spacer()
                }
                .foregroundStyle(Color.accentColor)
                .padding(.vertical, 4)
            }
        }
    }
}

// MARK: - Failed Job Row

private struct FailedJobRow: View {
    let job: FailedJob

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "xmark.circle.fill")
                .font(.caption)
                .foregroundStyle(.red.opacity(0.7))

            Text(job.name)
                .font(.subheadline)
                .lineLimit(2)
                .textSelection(.enabled)

            Spacer(minLength: 8)

            Text("\(job.count)")
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .foregroundStyle(countColor)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(countColor.opacity(0.12))
                .cornerRadius(6)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(job.name), failed \(job.count) times")
    }

    private var countColor: Color {
        if job.count >= 10 {
            return .red
        } else if job.count >= 5 {
            return .orange
        }
        return .secondary
    }
}

// MARK: - Platform Breakdown Row

private struct PlatformBreakdownRow: View {
    let platform: PlatformBreakdown
    let maxCount: Int

    private var fillRatio: Double {
        guard maxCount > 0 else { return 0 }
        return Double(platform.count) / Double(maxCount)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: platformIcon(platform.platform))
                    .foregroundStyle(.secondary)
                    .frame(width: 24)

                Text(platform.platform)
                    .font(.subheadline)

                Spacer()

                Text("\(platform.count)")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .foregroundStyle(.red)
            }

            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(.systemGray5))
                        .frame(height: 4)

                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.red.opacity(0.6))
                        .frame(width: max(4, geometry.size.width * fillRatio), height: 4)
                }
            }
            .frame(height: 4)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(platform.platform), \(platform.count) failures")
    }

    private func platformIcon(_ platform: String) -> String {
        let lowered = platform.lowercased()
        if lowered.contains("wheel") {
            return "gearshape.2.fill"
        } else if lowered.contains("libtorch") {
            return "books.vertical.fill"
        } else if lowered.contains("conda") {
            return "shippingbox.fill"
        } else if lowered.contains("linux") {
            return "terminal.fill"
        } else if lowered.contains("win") {
            return "pc"
        } else if lowered.contains("mac") {
            return "desktopcomputer"
        }
        return "cube.fill"
    }
}

// MARK: - Validation Jobs Subsection

private struct ValidationJobsSubsection: View {
    let title: String
    let jobs: [FailedJob]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Text("\(jobs.count)")
                    .font(.caption.weight(.medium).monospacedDigit())
                    .foregroundStyle(.red)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.red.opacity(0.1))
                    .cornerRadius(4)
            }
            .padding(.horizontal)
            .padding(.top, 8)

            ForEach(jobs.prefix(10)) { job in
                FailedJobRow(job: job)
            }
        }
    }
}

// MARK: - View Model

@MainActor
final class NightliesViewModel: ObservableObject {
    enum ViewState: Equatable {
        case idle
        case loading
        case loaded
        case error(String)

        static func == (lhs: ViewState, rhs: ViewState) -> Bool {
            switch (lhs, rhs) {
            case (.idle, .idle), (.loading, .loading), (.loaded, .loaded):
                return true
            case let (.error(a), .error(b)):
                return a == b
            default:
                return false
            }
        }
    }

    enum TimeRangeOption: Int, CaseIterable, Identifiable, Equatable {
        case oneDay = 1
        case threeDays = 3
        case oneWeek = 7
        case twoWeeks = 14
        case oneMonth = 30

        var id: Int { rawValue }

        var label: String {
            switch self {
            case .oneDay: return "1 Day"
            case .threeDays: return "3 Days"
            case .oneWeek: return "1 Week"
            case .twoWeeks: return "2 Weeks"
            case .oneMonth: return "1 Month"
            }
        }

        var shortLabel: String {
            switch self {
            case .oneDay: return "1d"
            case .threeDays: return "3d"
            case .oneWeek: return "7d"
            case .twoWeeks: return "14d"
            case .oneMonth: return "30d"
            }
        }

        var days: Int { rawValue }
    }

    @Published var state: ViewState = .idle
    @Published var selectedTimeRange: TimeRangeOption = .oneWeek

    // Trend data
    @Published var pytorchTrend: [NightlyTrendPoint] = []
    @Published var visionTrend: [NightlyTrendPoint] = []
    @Published var audioTrend: [NightlyTrendPoint] = []

    // Failed jobs (past 24h)
    @Published var pytorchFailedJobs: [FailedJob] = []
    @Published var visionFailedJobs: [FailedJob] = []
    @Published var audioFailedJobs: [FailedJob] = []

    // Platform breakdown
    @Published var platformBreakdown: [PlatformBreakdown] = []

    // Validation jobs
    @Published var releaseValidationJobs: [FailedJob] = []
    @Published var nightlyValidationJobs: [FailedJob] = []

    // Failed jobs by name
    @Published var failedJobsByName: [FailedJob] = []

    // Last updated timestamp
    @Published var lastUpdated: Date?

    private let apiClient: APIClientProtocol

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    // MARK: - Computed Properties

    var totalFailedJobCount: Int {
        pytorchFailedJobs.count + visionFailedJobs.count + audioFailedJobs.count
    }

    var maxPlatformCount: Int {
        platformBreakdown.map(\.count).max() ?? 0
    }

    // MARK: - Overall Health Computed Properties

    var overallHealthPercentage: String {
        let avg = averageFailureRate
        let passRate = (1.0 - avg) * 100
        return String(format: "%.0f", passRate)
    }

    var overallHealthColor: Color {
        let avg = averageFailureRate
        if avg < 0.05 { return .green }
        if avg < 0.15 { return .yellow }
        return .red
    }

    var overallHealthStatus: String {
        let avg = averageFailureRate
        if avg < 0.05 { return "All systems operational" }
        if avg < 0.15 { return "Some issues detected" }
        return "Multiple failures"
    }

    var overallHealthIcon: String {
        let avg = averageFailureRate
        if avg < 0.05 { return "checkmark.circle.fill" }
        if avg < 0.15 { return "exclamationmark.triangle.fill" }
        return "xmark.circle.fill"
    }

    var averageFailureRate: Double {
        (pytorchHealthValue + visionHealthValue + audioHealthValue) / 3.0
    }

    // MARK: - Individual Repository Health

    var pytorchHealthPercentage: String {
        let passRate = (1.0 - pytorchHealthValue) * 100
        return String(format: "%.0f%%", passRate)
    }

    var pytorchHealthColor: Color {
        healthColor(for: pytorchHealthValue)
    }

    private var pytorchHealthValue: Double {
        guard !pytorchTrend.isEmpty else { return 0 }
        return pytorchTrend.last?.failureRate ?? 0
    }

    var visionHealthPercentage: String {
        let passRate = (1.0 - visionHealthValue) * 100
        return String(format: "%.0f%%", passRate)
    }

    var visionHealthColor: Color {
        healthColor(for: visionHealthValue)
    }

    private var visionHealthValue: Double {
        guard !visionTrend.isEmpty else { return 0 }
        return visionTrend.last?.failureRate ?? 0
    }

    var audioHealthPercentage: String {
        let passRate = (1.0 - audioHealthValue) * 100
        return String(format: "%.0f%%", passRate)
    }

    var audioHealthColor: Color {
        healthColor(for: audioHealthValue)
    }

    private var audioHealthValue: Double {
        guard !audioTrend.isEmpty else { return 0 }
        return audioTrend.last?.failureRate ?? 0
    }

    private func healthColor(for value: Double) -> Color {
        if value < 0.05 { return .green }
        if value < 0.15 { return .yellow }
        return .red
    }

    // MARK: - Data Loading

    func loadData() async {
        state = .loading

        let client = apiClient
        let range = APIEndpoint.timeRange(days: selectedTimeRange.days)

        async let pytorchTrendTask = fetchTrend(client: client, repo: "pytorch", range: range)
        async let visionTrendTask = fetchTrend(client: client, repo: "vision", range: range)
        async let audioTrendTask = fetchTrend(client: client, repo: "audio", range: range)

        async let pytorchFailedTask = fetchFailedJobs(client: client, repo: "pytorch")
        async let visionFailedTask = fetchFailedJobs(client: client, repo: "vision")
        async let audioFailedTask = fetchFailedJobs(client: client, repo: "audio")

        async let platformTask = fetchPlatformBreakdown(client: client, repo: "pytorch", range: range)
        async let failedByNameTask = fetchFailedJobsByName(client: client, range: range)

        async let releaseValidationTask = fetchValidationJobs(client: client, channel: "release")
        async let nightlyValidationTask = fetchValidationJobs(client: client, channel: "nightly")

        do {
            pytorchTrend = try await pytorchTrendTask
            visionTrend = try await visionTrendTask
            audioTrend = try await audioTrendTask

            pytorchFailedJobs = try await pytorchFailedTask
            visionFailedJobs = try await visionFailedTask
            audioFailedJobs = try await audioFailedTask

            platformBreakdown = try await platformTask
            failedJobsByName = try await failedByNameTask

            releaseValidationJobs = try await releaseValidationTask
            nightlyValidationJobs = try await nightlyValidationTask

            lastUpdated = Date()
            state = .loaded
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    func refresh() async {
        await loadData()
    }

    // MARK: - API Fetch Methods

    private func fetchTrend(client: APIClientProtocol, repo: String, range: (startTime: String, stopTime: String)) async throws -> [NightlyTrendPoint] {
        let endpoint = APIEndpoint.clickhouseQuery(
            name: "nightly_jobs_red",
            parameters: [
                "repo": repo,
                "granularity": "day",
                "startTime": range.startTime,
                "stopTime": range.stopTime,
            ] as [String: Any]
        )
        let result: [TrendResponse] = try await client.fetch(endpoint)
        return result.map { response in
            NightlyTrendPoint(
                date: ISO8601DateFormatter().date(from: response.granularityBucket) ?? Date(),
                failureRate: response.red
            )
        }
    }

    private func fetchFailedJobs(client: APIClientProtocol, repo: String) async throws -> [FailedJob] {
        let endpoint = APIEndpoint.clickhouseQuery(
            name: "nightly_jobs_red_past_day",
            parameters: ["repo": repo]
        )
        let result: [FailedJobResponse] = try await client.fetch(endpoint)
        return result.map { FailedJob(name: $0.name, count: $0.count) }
    }

    private func fetchPlatformBreakdown(client: APIClientProtocol, repo: String, range: (startTime: String, stopTime: String)) async throws -> [PlatformBreakdown] {
        let endpoint = APIEndpoint.clickhouseQuery(
            name: "nightly_jobs_red_by_platform",
            parameters: [
                "repo": repo,
                "startTime": range.startTime,
                "stopTime": range.stopTime,
            ] as [String: Any]
        )
        let result: [PlatformResponse] = try await client.fetch(endpoint)
        return result.map { PlatformBreakdown(platform: $0.platform, count: $0.count) }
    }

    private func fetchFailedJobsByName(client: APIClientProtocol, range: (startTime: String, stopTime: String)) async throws -> [FailedJob] {
        let endpoint = APIEndpoint.clickhouseQuery(
            name: "nightly_jobs_red_by_name",
            parameters: [
                "repo": "pytorch",
                "startTime": range.startTime,
                "stopTime": range.stopTime,
            ] as [String: Any]
        )
        let result: [FailedJobResponse] = try await client.fetch(endpoint)
        return result.map { FailedJob(name: $0.name, count: $0.count) }
    }

    private func fetchValidationJobs(client: APIClientProtocol, channel: String) async throws -> [FailedJob] {
        let endpoint = APIEndpoint.clickhouseQuery(
            name: "validation_jobs_red_past_day",
            parameters: ["channel": channel]
        )
        let result: [FailedJobResponse] = try await client.fetch(endpoint)
        return result.map { FailedJob(name: $0.name, count: $0.count) }
    }
}

// MARK: - Models

struct NightlyTrendPoint: Identifiable {
    let id = UUID()
    let date: Date
    let failureRate: Double
}

struct FailedJob: Identifiable, Decodable {
    let id = UUID()
    let name: String
    let count: Int
}

struct PlatformBreakdown: Identifiable {
    let id = UUID()
    let platform: String
    let count: Int
}

// MARK: - API Response Models

private struct TrendResponse: Decodable {
    let granularityBucket: String
    let red: Double

    enum CodingKeys: String, CodingKey {
        case granularityBucket = "granularity_bucket"
        case red
    }
}

private struct FailedJobResponse: Decodable {
    let name: String
    let count: Int

    enum CodingKeys: String, CodingKey {
        case name
        case count = "COUNT"
    }
}

private struct PlatformResponse: Decodable {
    let platform: String
    let count: Int

    enum CodingKeys: String, CodingKey {
        case platform = "Platform"
        case count = "Count"
    }
}

#Preview {
    NavigationStack {
        NightliesView()
    }
}
