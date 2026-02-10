import Charts
import SwiftUI

struct CompilerBenchmarkView: View {
    let benchmarkId: String?

    // MARK: - State

    @State private var state: ViewState = .idle
    @State private var performanceData: [CompilerPerformanceRecord] = []
    @State private var selectedSuite: String = "all"
    @State private var selectedCompiler: String = "all"
    @State private var selectedMode: String = "training"
    @State private var selectedDtype: String = "amp"
    @State private var selectedDevice: String = "cuda (h100)"
    @State private var searchText: String = ""
    @State private var lookbackDays: Int = 7
    @State private var expandedCompiler: String?
    @State private var modelSortOrder: ModelSortOrder = .speedupDesc
    @State private var expandedModelId: UUID?
    @State private var selectedGranularity: String = "hour"

    private let apiClient: APIClientProtocol = APIClient.shared

    enum ViewState: Equatable {
        case idle
        case loading
        case loaded
        case error(String)
    }

    enum ModelSortOrder: String, CaseIterable {
        case speedupDesc = "Speedup (High)"
        case speedupAsc = "Speedup (Low)"
        case nameAsc = "Name (A-Z)"
        case compileTimeDesc = "Compile Time"
    }

    // MARK: - Constants

    private let suiteOptions = ["all", "torchbench", "huggingface", "timm_models"]
    private let compilerOptions = ["all", "cudagraphs", "default", "cudagraphs_dynamic", "cpp_wrapper", "aot_inductor", "eager"]
    private let modeOptions = ["training", "inference"]
    private let dtypeOptions = ["amp", "float16", "bfloat16", "float32"]
    private let deviceOptions = ["cuda (h100)", "cuda (a100)", "cuda (b200)", "cpu (x86_64)", "cpu (aarch64)", "rocm (mi325x)"]

    private let granularityOptions = ["hour", "day", "week"]

    private let deviceNameMap: [String: [String]] = [
        "cuda (h100)": ["cuda"],
        "cuda (a100)": ["cuda"],
        "cuda (b200)": ["cuda"],
        "cpu (x86_64)": ["cpu"],
        "cpu (aarch64)": ["cpu"],
        "rocm (mi325x)": ["rocm"],
    ]

    private let archNameMap: [String: [String]] = [
        "cuda (h100)": ["h100"],
        "cuda (a100)": ["a100"],
        "cuda (b200)": ["b200"],
        "cpu (x86_64)": ["Xeon_Platinum_8488C_48c"],
        "cpu (aarch64)": ["aarch64"],
        "rocm (mi325x)": ["AMD Instinct MI325X"],
    ]

    // MARK: - Computed

    private var groupedData: [String: [CompilerPerformanceRecord]] {
        Dictionary(grouping: performanceData) { $0.compiler }
    }

    var filteredRecords: [CompilerPerformanceRecord] {
        performanceData.filter { record in
            let suiteMatch = selectedSuite == "all" || record.suite == selectedSuite
            let compilerMatch = selectedCompiler == "all" || displayNameForCompiler(record.compiler) == selectedCompiler
            let searchMatch = searchText.isEmpty || record.name.lowercased().contains(searchText.lowercased())
            return suiteMatch && compilerMatch && searchMatch
        }
    }

    var modelsByCompiler: [String: [String: CompilerPerformanceRecord]] {
        var result: [String: [String: CompilerPerformanceRecord]] = [:]
        for record in filteredRecords {
            let compiler = displayNameForCompiler(record.compiler)
            if result[compiler] == nil {
                result[compiler] = [:]
            }
            result[compiler]?[record.name] = record
        }
        return result
    }

    var compilerSummary: [CompilerSummaryStats] {
        var summaries: [CompilerSummaryStats] = []
        for (compiler, records) in modelsByCompiler {
            let stats = computeSummaryForCompiler(compiler, records: Array(records.values))
            summaries.append(stats)
        }
        return summaries.sorted { $0.compiler < $1.compiler }
    }

    private var sortedModelRecords: [CompilerPerformanceRecord] {
        let records = filteredRecords
        switch modelSortOrder {
        case .speedupDesc:
            return records.sorted { ($0.speedup ?? -1) > ($1.speedup ?? -1) }
        case .speedupAsc:
            return records.sorted { ($0.speedup ?? Double.infinity) < ($1.speedup ?? Double.infinity) }
        case .nameAsc:
            return records.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        case .compileTimeDesc:
            return records.sorted { ($0.compilationLatency ?? 0) > ($1.compilationLatency ?? 0) }
        }
    }

    private var overallPassrate: Double {
        let total = filteredRecords.count
        guard total > 0 else { return 0 }
        let passing = filteredRecords.filter {
            ($0.accuracy == "pass" || $0.accuracy == "pass_due_to_skip") && ($0.speedup ?? 0) > 0
        }.count
        return (Double(passing) / Double(total)) * 100
    }

    // MARK: - Body

    var body: some View {
        Group {
            switch state {
            case .idle, .loading where performanceData.isEmpty:
                LoadingView(message: "Loading compiler benchmarks...")

            case .error(let message) where performanceData.isEmpty:
                ErrorView(
                    error: NSError(domain: "", code: 0, userInfo: [NSLocalizedDescriptionKey: message]),
                    retryAction: { Task { await loadData() } }
                )

            default:
                compilerContent
            }
        }
        .navigationTitle("TorchInductor Performance")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if state == .idle {
                await loadData()
            }
        }
    }

    // MARK: - Content

    private var compilerContent: some View {
        ScrollView {
            VStack(spacing: 16) {
                filtersSection

                summaryGridSection

                compilerComparisonSection

                speedupDistributionSection

                modelDetailsSection
            }
            .padding()
        }
        .refreshable {
            await loadData()
        }
        .overlay {
            if state == .loading && !performanceData.isEmpty {
                VStack {
                    InlineLoadingView()
                        .padding(8)
                        .background(.ultraThinMaterial)
                        .clipShape(Capsule())
                    Spacer()
                }
                .padding(.top, 8)
            }
        }
    }

    // MARK: - Filters

    private var filtersSection: some View {
        VStack(spacing: 10) {
            SearchBar(text: $searchText, placeholder: "Filter models...")

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    pickerChip(title: "Device", options: deviceOptions, selection: $selectedDevice, reload: true)
                    pickerChip(title: "Suite", options: suiteOptions, selection: $selectedSuite)
                    pickerChip(title: "Compiler", options: compilerOptions, selection: $selectedCompiler)
                    pickerChip(title: "Mode", options: modeOptions, selection: $selectedMode, reload: true)
                    pickerChip(title: "Precision", options: dtypeOptions, selection: $selectedDtype, reload: true)
                    pickerChip(title: "Granularity", options: granularityOptions, selection: $selectedGranularity, reload: true)
                }
            }
        }
    }

    private func pickerChip(title: String, options: [String], selection: Binding<String>, reload: Bool = false) -> some View {
        Menu {
            ForEach(options, id: \.self) { option in
                Button {
                    selection.wrappedValue = option
                    if reload {
                        Task { await loadData() }
                    }
                } label: {
                    HStack {
                        Text(option == "all" ? "All" : formatDisplayName(option))
                        if option == selection.wrappedValue {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(selection.wrappedValue == "all" ? "All" : formatDisplayName(selection.wrappedValue))
                    .font(.caption.weight(.medium))
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color(.systemGray6))
            .clipShape(Capsule())
        }
    }

    // MARK: - Summary Grid

    private var summaryGridSection: some View {
        let total = filteredRecords.count
        let uniqueModels = Set(filteredRecords.map(\.name)).count
        let compilerCount = Set(filteredRecords.map { displayNameForCompiler($0.compiler) }).count

        return LazyVGrid(columns: [
            GridItem(.flexible(), spacing: 10),
            GridItem(.flexible(), spacing: 10),
            GridItem(.flexible(), spacing: 10),
            GridItem(.flexible(), spacing: 10),
        ], spacing: 10) {
            ScalarPanel(
                label: "Pass Rate",
                value: String(format: "%.0f%%", overallPassrate),
                icon: "checkmark.seal",
                valueColor: overallPassrate >= 90 ? AppColors.success : AppColors.unstable
            )

            ScalarPanel(
                label: "Models",
                value: "\(uniqueModels)",
                icon: "cpu",
                valueColor: .blue
            )

            ScalarPanel(
                label: "Compilers",
                value: "\(compilerCount)",
                icon: "gearshape.2",
                valueColor: .orange
            )

            ScalarPanel(
                label: "Records",
                value: "\(total)",
                icon: "doc.text",
                valueColor: .purple
            )
        }
    }

    // MARK: - Compiler Comparison

    private var compilerComparisonSection: some View {
        InfoCard(title: "Compiler Summary", icon: "chart.bar.doc.horizontal") {
            if compilerSummary.isEmpty {
                EmptyStateView(
                    icon: "gearshape.2",
                    title: "No Data",
                    message: "No compiler performance data available for the selected filters."
                )
                .frame(height: 120)
            } else {
                VStack(spacing: 8) {
                    ForEach(compilerSummary) { summary in
                        compilerSummaryCard(summary)
                    }
                }
            }
        }
    }

    private func compilerSummaryCard(_ summary: CompilerSummaryStats) -> some View {
        let isExpanded = expandedCompiler == summary.compiler
        return VStack(spacing: 0) {
            // Always-visible row
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    expandedCompiler = isExpanded ? nil : summary.compiler
                }
            } label: {
                VStack(spacing: 8) {
                    HStack {
                        Text(summary.compiler)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)

                        Spacer()

                        Text(String(format: "%.2fx", summary.geomean))
                            .font(.system(.subheadline, design: .monospaced).weight(.bold))
                            .foregroundStyle(summary.geomean >= 0.95 ? AppColors.success : AppColors.failure)

                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }

                    // Passrate bar
                    passrateBar(passrate: summary.passrate)
                }
                .padding(12)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(.plain)

            // Expanded details
            if isExpanded {
                VStack(spacing: 8) {
                    HStack(spacing: 16) {
                        compilerStatItem(
                            label: "Geomean",
                            value: String(format: "%.3fx", summary.geomean),
                            color: summary.geomean >= 0.95 ? AppColors.success : AppColors.failure
                        )
                        compilerStatItem(
                            label: "Pass Rate",
                            value: String(format: "%.1f%%", summary.passrate),
                            color: summary.passrate >= 90 ? AppColors.success : AppColors.unstable
                        )
                    }

                    HStack(spacing: 16) {
                        compilerStatItem(
                            label: "Avg Compile",
                            value: String(format: "%.0fs", summary.compileTime),
                            color: .primary
                        )
                        compilerStatItem(
                            label: "Memory",
                            value: String(format: "%.2fx", summary.memoryRatio),
                            color: summary.memoryRatio >= 0.9 ? AppColors.success : AppColors.unstable
                        )
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Color(.secondarySystemBackground).opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.top, -4)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private func passrateBar(passrate: Double) -> some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3)
                    .fill(Color(.systemGray5))

                RoundedRectangle(cornerRadius: 3)
                    .fill(passrate >= 90 ? AppColors.success : AppColors.unstable)
                    .frame(width: max(0, geometry.size.width * CGFloat(passrate / 100)))
            }
        }
        .frame(height: 6)
        .overlay(alignment: .trailing) {
            Text(String(format: "%.0f%%", passrate))
                .font(.system(size: 9, design: .monospaced).weight(.medium))
                .foregroundStyle(.secondary)
                .offset(y: -10)
        }
    }

    private func compilerStatItem(label: String, value: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(.caption, design: .monospaced).weight(.semibold))
                .foregroundStyle(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Speedup Distribution

    private var speedupDistributionSection: some View {
        let chartData = filteredRecords
            .filter { ($0.speedup ?? 0) > 0 }
            .sorted { ($0.speedup ?? 0) > ($1.speedup ?? 0) }
            .prefix(20)

        return InfoCard(title: "Top Speedups", icon: "chart.bar") {
            if chartData.isEmpty {
                emptyChart
            } else {
                Chart(Array(chartData)) { record in
                    BarMark(
                        x: .value("Speedup", record.speedup ?? 1.0),
                        y: .value("Model", truncateModelName(record.name))
                    )
                    .foregroundStyle(speedupColor(record.speedup))
                    .cornerRadius(2)

                    // Reference line at 1.0x
                    RuleMark(x: .value("Baseline", 1.0))
                        .foregroundStyle(.secondary.opacity(0.5))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                }
                .chartXAxis {
                    AxisMarks(position: .bottom) { _ in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                            .foregroundStyle(.secondary.opacity(0.3))
                        AxisValueLabel()
                            .font(.caption2)
                    }
                }
                .chartYAxis {
                    AxisMarks { _ in
                        AxisValueLabel()
                            .font(.system(size: 9))
                    }
                }
                .frame(height: max(280, CGFloat(chartData.count) * 14))

                HStack(spacing: 12) {
                    Label("Pass", systemImage: "checkmark.circle.fill")
                        .font(.caption2)
                        .foregroundStyle(AppColors.success)
                    Label("Neutral", systemImage: "minus.circle.fill")
                        .font(.caption2)
                        .foregroundStyle(.primary)
                    Label("Fail", systemImage: "xmark.circle.fill")
                        .font(.caption2)
                        .foregroundStyle(AppColors.failure)
                    Spacer()
                    Text("-- 1.0x baseline")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 4)
            }
        }
    }

    private var emptyChart: some View {
        RoundedRectangle(cornerRadius: 12)
            .fill(Color(.secondarySystemBackground))
            .frame(height: 220)
            .overlay {
                VStack(spacing: 8) {
                    Image(systemName: "chart.bar.xaxis")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text("No data available")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
    }

    // MARK: - Model Details

    private var modelDetailsSection: some View {
        let sorted = sortedModelRecords

        return InfoCard(title: "Models (\(filteredRecords.count))", icon: "tablecells") {
            if sorted.isEmpty {
                EmptyStateView(
                    icon: "tablecells",
                    title: "No Results",
                    message: "No models match the current filters."
                )
                .frame(height: 120)
            } else {
                VStack(spacing: 8) {
                    // Sort control
                    sortPicker

                    LazyVStack(spacing: 6) {
                        ForEach(sorted.prefix(100)) { record in
                            modelCard(record)
                        }
                    }

                    if sorted.count > 100 {
                        Text("Showing 100 of \(sorted.count) models")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.top, 4)
                    }
                }
            }
        }
    }

    private var sortPicker: some View {
        Menu {
            ForEach(ModelSortOrder.allCases, id: \.self) { order in
                Button {
                    modelSortOrder = order
                } label: {
                    HStack {
                        Text(order.rawValue)
                        if order == modelSortOrder {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "arrow.up.arrow.down")
                    .font(.caption2)
                Text(modelSortOrder.rawValue)
                    .font(.caption)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Color(.systemGray6))
            .clipShape(Capsule())
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private func modelCard(_ record: CompilerPerformanceRecord) -> some View {
        let isExpanded = expandedModelId == record.id
        let (statusText, statusColor) = statusInfo(for: record)

        return Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                expandedModelId = isExpanded ? nil : record.id
            }
        } label: {
            VStack(spacing: 0) {
                // Primary row
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(record.name)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.primary)
                            .lineLimit(1)

                        Text(displayNameForCompiler(record.compiler))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }

                    Spacer(minLength: 4)

                    // Speedup
                    Text(record.speedup.map { String(format: "%.2fx", $0) } ?? "--")
                        .font(.system(.subheadline, design: .monospaced).weight(.bold))
                        .foregroundStyle(speedupColor(record.speedup))

                    // Status pill
                    Text(statusText)
                        .font(.system(size: 9, weight: .bold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(statusColor.opacity(0.15))
                        .foregroundStyle(statusColor)
                        .clipShape(Capsule())
                }

                // Expanded details
                if isExpanded {
                    VStack(spacing: 6) {
                        Divider()
                            .padding(.vertical, 4)

                        HStack(spacing: 0) {
                            detailItem(label: "Suite", value: record.suite)
                            detailItem(
                                label: "Compile",
                                value: record.compilationLatency.map { String(format: "%.1fs", $0) } ?? "--"
                            )
                            detailItem(
                                label: "Memory",
                                value: record.compressionRatio.map { String(format: "%.2fx", $0) } ?? "--"
                            )
                            detailItem(label: "Accuracy", value: record.accuracy)
                        }

                        if let peak = record.peakMemory, peak > 0 {
                            HStack {
                                Text("Peak Memory:")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                Text(String(format: "%.1f MB", peak / 1_048_576))
                                    .font(.system(.caption2, design: .monospaced))
                                    .foregroundStyle(.primary)
                                Spacer()
                            }
                        }
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .padding(10)
            .background(rowBackground(for: record))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color(.separator).opacity(0.2), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func detailItem(label: String, value: String) -> some View {
        VStack(spacing: 2) {
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.system(size: 10, design: .monospaced).weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
    }

    private func statusBadge(for record: CompilerPerformanceRecord) -> some View {
        let (text, color) = statusInfo(for: record)
        return Text(text)
            .font(.system(size: 9, weight: .semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    func statusInfo(for record: CompilerPerformanceRecord) -> (String, Color) {
        guard let speedup = record.speedup else { return ("N/A", AppColors.neutral) }
        if record.accuracy == "pass" || record.accuracy == "pass_due_to_skip" {
            if speedup >= 1.05 { return ("PASS", AppColors.success) }
            if speedup < 0.95 { return ("FAIL", AppColors.failure) }
            return ("OK", AppColors.neutral)
        }
        return ("SKIP", AppColors.neutral)
    }

    func rowBackground(for record: CompilerPerformanceRecord) -> Color {
        guard let speedup = record.speedup else { return Color(.secondarySystemBackground).opacity(0.5) }
        if speedup >= 1.05 { return AppColors.success.opacity(0.06) }
        if speedup < 0.95 { return AppColors.failure.opacity(0.06) }
        return Color(.secondarySystemBackground).opacity(0.5)
    }

    // MARK: - Helpers

    func speedupColor(_ speedup: Double?) -> Color {
        guard let speedup else { return .secondary }
        if speedup >= 1.05 { return AppColors.success }
        if speedup < 0.95 { return AppColors.failure }
        return .primary
    }

    func displayNameForCompiler(_ compiler: String) -> String {
        let displayMap: [String: String] = [
            "inductor": "cudagraphs",
            "inductor_with_cudagraphs": "cudagraphs",
            "inductor_dynamic": "cudagraphs_dynamic",
            "inductor_no_cudagraphs": "default",
            "inductor_cpp_wrapper": "cpp_wrapper",
            "inductor_aot_inductor": "aot_inductor",
            "inductor_eager": "eager",
        ]
        return displayMap[compiler] ?? compiler
    }

    func formatDisplayName(_ name: String) -> String {
        name.replacingOccurrences(of: "_", with: " ")
            .capitalized
    }

    func truncateModelName(_ name: String) -> String {
        let maxLength = 20
        if name.count > maxLength {
            return String(name.prefix(maxLength - 3)) + "..."
        }
        return name
    }

    func computeSummaryForCompiler(_ compiler: String, records: [CompilerPerformanceRecord]) -> CompilerSummaryStats {
        let total = records.count
        guard total > 0 else {
            return CompilerSummaryStats(
                compiler: compiler,
                passrate: 0,
                geomean: 0,
                compileTime: 0,
                memoryRatio: 0
            )
        }

        // Passrate: models with pass accuracy and speedup > 0
        let passing = records.filter {
            ($0.accuracy == "pass" || $0.accuracy == "pass_due_to_skip") && ($0.speedup ?? 0) > 0
        }.count
        let passrate = (Double(passing) / Double(total)) * 100

        // Geomean speedup
        let speedups = records.compactMap { $0.speedup }.filter { $0 > 0 }
        let geomean: Double
        if !speedups.isEmpty {
            let logSum = speedups.reduce(0.0) { $0 + log($1) }
            geomean = exp(logSum / Double(speedups.count))
        } else {
            geomean = 0
        }

        // Mean compilation time
        let compileTimes = records.compactMap { $0.compilationLatency }.filter { $0 > 0 }
        let compileTime = compileTimes.isEmpty ? 0 : compileTimes.reduce(0.0, +) / Double(compileTimes.count)

        // Memory compression ratio
        let memoryRatios = records.compactMap { $0.compressionRatio }.filter { $0 > 0 }
        let memoryRatio = memoryRatios.isEmpty ? 0 : memoryRatios.reduce(0.0, +) / Double(memoryRatios.count)

        return CompilerSummaryStats(
            compiler: compiler,
            passrate: passrate,
            geomean: geomean,
            compileTime: compileTime,
            memoryRatio: memoryRatio
        )
    }

    private func loadData() async {
        if state != .loaded {
            state = .loading
        }

        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS"
        dateFormatter.timeZone = TimeZone(identifier: "UTC")
        let now = Date()
        let startDate = Calendar.current.date(byAdding: .day, value: -lookbackDays, to: now) ?? now

        let devices = deviceNameMap[selectedDevice] ?? ["cuda"]
        let archs = archNameMap[selectedDevice] ?? ["h100"]

        // The ClickHouse params.json declares device and arch as String, not Array(String).
        // Pass the first element as a plain string to match the query's {device: String} placeholder.
        let parameters: [String: Any] = [
            "branches": ["main"],
            "commits": [] as [String],
            "compilers": [] as [String],
            "arch": archs.first ?? "h100",
            "device": devices.first ?? "cuda",
            "dtype": selectedDtype,
            "granularity": selectedGranularity,
            "mode": selectedMode,
            "startTime": dateFormatter.string(from: startDate),
            "stopTime": dateFormatter.string(from: now),
            "suites": suiteOptions.filter { $0 != "all" },
            "workflowId": 0,
        ]

        do {
            // The API returns a plain JSON array of raw benchmark rows, not wrapped in {data: [...]}.
            // Each row has: workflow_id, job_id, backend, suite, model, metric, value, extra_info, output, granularity_bucket.
            // We must pivot/aggregate these rows (grouped by workflow_id+model+backend) into
            // CompilerPerformanceRecord objects, mirroring the web app's convertToCompilerPerformanceData().
            let rawRows: [CompilerBenchmarkRawRow] = try await apiClient.fetch(
                APIEndpoint.clickhouseQuery(name: "compilers_benchmark_performance", parameters: parameters)
            )
            performanceData = Self.convertToPerformanceRecords(rawRows)
            state = .loaded
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    /// Converts raw ClickHouse benchmark rows into aggregated per-model performance records.
    /// This mirrors the web app's `convertToCompilerPerformanceData()` in compilerUtils.ts.
    ///
    /// Raw rows have one row per (workflow_id, model, backend, metric). The `metric` column
    /// contains metric names like "speedup", "accuracy", "compilation_latency", "compression_ratio",
    /// "dynamo_peak_mem", "abs_latency". The `value` column has the numeric value, except for
    /// "accuracy" where the value is stored as a JSON string in `extra_info.benchmark_values`.
    ///
    /// We group by (workflow_id, model, backend) and pivot metrics into fields on the record,
    /// then keep only the latest workflow_id per (model, backend) group.
    static func convertToPerformanceRecords(_ rawRows: [CompilerBenchmarkRawRow]) -> [CompilerPerformanceRecord] {
        // Track the earliest granularity_bucket per workflow_id (same logic as web app)
        var workflowBucket: [Int: String] = [:]
        for row in rawRows {
            if workflowBucket[row.workflowId] == nil {
                workflowBucket[row.workflowId] = row.granularityBucket
            }
        }

        // Group by (workflow_id, model, backend) and pivot metrics
        var grouped: [String: CompilerPerformanceMutable] = [:]
        for row in rawRows {
            let key = "\(row.workflowId) \(row.model) \(row.backend)"
            if grouped[key] == nil {
                grouped[key] = CompilerPerformanceMutable(
                    name: row.model,
                    compiler: row.backend,
                    suite: row.suite,
                    workflowId: row.workflowId,
                    granularityBucket: workflowBucket[row.workflowId] ?? row.granularityBucket
                )
            }

            switch row.metric {
            case "accuracy":
                // Accuracy value is a string stored in extra_info's benchmark_values JSON array
                if let extraInfo = row.extraInfo,
                   let benchmarkValues = extraInfo["benchmark_values"],
                   let jsonData = benchmarkValues.data(using: .utf8),
                   let parsed = try? JSONSerialization.jsonObject(with: jsonData) as? [Any],
                   let first = parsed.first as? String {
                    grouped[key]?.accuracy = first
                }
            case "speedup":
                grouped[key]?.speedup = row.value
            case "compilation_latency":
                grouped[key]?.compilationLatency = row.value
            case "compression_ratio":
                grouped[key]?.compressionRatio = row.value
            case "dynamo_peak_mem":
                grouped[key]?.peakMemory = row.value
            case "abs_latency":
                grouped[key]?.absLatency = row.value
            default:
                break
            }
        }

        // Keep only the latest workflow per (model, backend) to get most recent data
        var latestByModelBackend: [String: CompilerPerformanceMutable] = [:]
        for entry in grouped.values {
            let modelKey = "\(entry.name) \(entry.compiler)"
            if let existing = latestByModelBackend[modelKey] {
                if entry.workflowId > existing.workflowId {
                    latestByModelBackend[modelKey] = entry
                }
            } else {
                latestByModelBackend[modelKey] = entry
            }
        }

        return latestByModelBackend.values.map { mutable in
            CompilerPerformanceRecord(
                name: mutable.name,
                compiler: mutable.compiler,
                suite: mutable.suite,
                speedup: mutable.speedup,
                accuracy: mutable.accuracy ?? "",
                compilationLatency: mutable.compilationLatency,
                compressionRatio: mutable.compressionRatio,
                peakMemory: mutable.peakMemory
            )
        }
    }
}

// MARK: - Supporting Types

/// Raw row returned by the `compilers_benchmark_performance` ClickHouse query.
/// Each row represents a single metric for a (workflow, model, backend) combination.
/// The API returns a plain JSON array of these rows (not wrapped in `{data: [...]}`).
struct CompilerBenchmarkRawRow: Decodable {
    let workflowId: Int
    let jobId: Int?
    let backend: String
    let suite: String
    let model: String
    let metric: String
    let value: Double
    let extraInfo: [String: String]?
    let output: String?
    let granularityBucket: String

    enum CodingKeys: String, CodingKey {
        case backend, suite, model, metric, value, output
        case workflowId = "workflow_id"
        case jobId = "job_id"
        case extraInfo = "extra_info"
        case granularityBucket = "granularity_bucket"
    }
}

/// Mutable intermediate struct used during the pivot/aggregation of raw benchmark rows.
struct CompilerPerformanceMutable {
    let name: String
    let compiler: String
    let suite: String
    let workflowId: Int
    let granularityBucket: String
    var accuracy: String?
    var speedup: Double?
    var compilationLatency: Double?
    var compressionRatio: Double?
    var peakMemory: Double?
    var absLatency: Double?
}

/// Aggregated per-model performance record, produced by pivoting raw benchmark rows.
struct CompilerPerformanceRecord: Identifiable {
    let id: UUID = UUID()
    let name: String
    let compiler: String
    let suite: String
    let speedup: Double?
    let accuracy: String
    let compilationLatency: Double?
    let compressionRatio: Double?
    let peakMemory: Double?
}

struct CompilerSummaryStats: Identifiable {
    let id = UUID()
    let compiler: String
    let passrate: Double
    let geomean: Double
    let compileTime: Double
    let memoryRatio: Double
}

#Preview {
    NavigationStack {
        CompilerBenchmarkView(benchmarkId: "torchbench")
    }
}
