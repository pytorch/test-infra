import Charts
import SwiftUI

struct RegressionReportView: View {
    let reportId: String

    @StateObject private var viewModel: RegressionReportViewModel

    init(reportId: String) {
        self.reportId = reportId
        _viewModel = StateObject(wrappedValue: RegressionReportViewModel())
    }

    // MARK: - Body

    var body: some View {
        Group {
            switch viewModel.state {
            case .idle, .loading where viewModel.report == nil:
                LoadingView(message: "Loading regression report...")

            case .error(let message) where viewModel.report == nil:
                ErrorView(
                    error: NSError(domain: "", code: 0, userInfo: [NSLocalizedDescriptionKey: message]),
                    retryAction: { Task { await viewModel.loadReport(id: reportId) } }
                )

            default:
                reportContent
            }
        }
        .navigationTitle("Regression Report")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if viewModel.state == .idle {
                await viewModel.loadReport(id: reportId)
            }
        }
    }

    // MARK: - Content

    private var reportContent: some View {
        ScrollView {
            VStack(spacing: 16) {
                statusHeader

                summaryPanels

                metadataSection

                if viewModel.report != nil {
                    filterSection

                    sortControl

                    tableViewContent
                }
            }
            .padding()
        }
        .refreshable {
            await viewModel.loadReport(id: reportId)
        }
        .overlay {
            if viewModel.state == .loading && viewModel.report != nil {
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

    // MARK: - Status Header

    private var statusHeader: some View {
        Group {
            if let status = viewModel.report?.status {
                HStack(spacing: 10) {
                    Image(systemName: statusIcon(status))
                        .font(.title2)
                        .foregroundStyle(statusColor(status))

                    VStack(alignment: .leading, spacing: 2) {
                        Text(statusLabel(status))
                            .font(.headline)
                        if let reportType = viewModel.report?.reportId {
                            Text(reportType)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }

                    Spacer()

                    statusBadge(status)
                }
                .padding()
                .background(statusColor(status).opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    // MARK: - Summary Panels

    private var summaryPanels: some View {
        HStack(spacing: 10) {
            ScalarPanel(
                label: "Regression",
                value: "\(viewModel.report?.regressionCount ?? 0)",
                icon: "xmark.octagon",
                valueColor: (viewModel.report?.regressionCount ?? 0) > 0 ? AppColors.failure : AppColors.success
            )

            ScalarPanel(
                label: "Suspected",
                value: "\(viewModel.report?.suspectedRegressionCount ?? 0)",
                icon: "exclamationmark.triangle",
                valueColor: (viewModel.report?.suspectedRegressionCount ?? 0) > 0 ? AppColors.unstable : AppColors.success
            )

            ScalarPanel(
                label: "Total",
                value: "\(viewModel.report?.totalCount ?? 0)",
                icon: "chart.bar",
                valueColor: .primary
            )
        }
    }

    // MARK: - Metadata Section

    private var metadataSection: some View {
        InfoCard(title: "Details", icon: "info.circle") {
            VStack(alignment: .leading, spacing: 8) {
                if let repo = viewModel.report?.repo {
                    metadataRow(icon: "building.2", label: "Repository", value: repo)
                }

                if let commit = viewModel.report?.lastRecordCommit {
                    metadataRow(icon: "point.3.connected.trianglepath.dotted", label: "Last Commit", value: String(commit.prefix(10)))
                }

                if let createdAt = viewModel.report?.createdAt {
                    metadataRow(icon: "clock", label: "Created", value: viewModel.formatDate(createdAt))
                }

                if let insufficientData = viewModel.report?.insufficientDataCount, insufficientData > 0 {
                    metadataRow(icon: "questionmark.circle", label: "Insufficient Data", value: "\(insufficientData)")
                }
            }
        }
    }

    private func statusBadge(_ status: String) -> some View {
        Text(statusLabel(status).uppercased())
            .font(.caption2.weight(.bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(statusColor(status))
            .clipShape(Capsule())
    }

    private func statusIcon(_ status: String) -> String {
        switch status.lowercased() {
        case "no_regression": return "checkmark.shield.fill"
        case "regression": return "exclamationmark.octagon.fill"
        case "suspicious": return "exclamationmark.triangle.fill"
        default: return "questionmark.circle.fill"
        }
    }

    private func statusLabel(_ status: String) -> String {
        switch status.lowercased() {
        case "no_regression": return "No Regression"
        case "regression": return "Regression Detected"
        case "suspicious": return "Suspicious"
        default: return status.capitalized
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "no_regression": return AppColors.success
        case "regression": return AppColors.failure
        case "suspicious": return AppColors.unstable
        default: return .gray
        }
    }

    private func metadataRow(icon: String, label: String, value: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 16)
            Text("\(label):")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption)
                .lineLimit(2)
        }
    }

    // MARK: - Filter Section

    private var filterSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let filters = viewModel.report?.filters, !filters.isEmpty {
                HStack {
                    Text("Filters")
                        .font(.subheadline.weight(.semibold))

                    Spacer()

                    if !viewModel.selectedFilters.isEmpty {
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                viewModel.clearFilters()
                            }
                        } label: {
                            Text("Clear All")
                                .font(.caption)
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                }

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(filters.keys.sorted()), id: \.self) { key in
                            if let values = filters[key], !values.isEmpty {
                                filterChip(key: key, values: values)
                            }
                        }
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func filterChip(key: String, values: [String]) -> some View {
        Menu {
            Button("All") {
                viewModel.updateFilter(key: key, value: nil)
            }
            ForEach(values, id: \.self) { value in
                Button(value) {
                    viewModel.updateFilter(key: key, value: value)
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(key.capitalized)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                Text(viewModel.selectedFilters[key] ?? "All")
                    .font(.caption)
                    .foregroundStyle(.primary)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                viewModel.selectedFilters[key] != nil
                    ? Color.accentColor.opacity(0.12)
                    : Color(.secondarySystemBackground)
            )
            .clipShape(Capsule())
        }
    }

    // MARK: - Sort Control

    private var sortControl: some View {
        HStack {
            Text("Sort by")
                .font(.caption)
                .foregroundStyle(.secondary)

            Picker("Sort", selection: $viewModel.sortOrder) {
                Text("Severity").tag(RegressionSortOrder.severity)
                Text("Change %").tag(RegressionSortOrder.changePercent)
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 200)

            Spacer()

            Text("\(viewModel.totalFilteredCount) items")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Table View

    private var tableViewContent: some View {
        VStack(spacing: 16) {
            if !viewModel.sortedRegressionItems.isEmpty {
                regressionSection(
                    title: "Regressions",
                    items: viewModel.sortedRegressionItems,
                    totalCount: viewModel.report?.details?.regression?.count ?? 0,
                    sectionColor: AppColors.failure
                )
            }

            if !viewModel.sortedSuspiciousItems.isEmpty {
                regressionSection(
                    title: "Suspicious",
                    items: viewModel.sortedSuspiciousItems,
                    totalCount: viewModel.report?.details?.suspicious?.count ?? 0,
                    sectionColor: AppColors.unstable
                )
            }

            if viewModel.sortedRegressionItems.isEmpty && viewModel.sortedSuspiciousItems.isEmpty {
                EmptyStateView(
                    icon: "checkmark.shield",
                    title: "No Results",
                    message: viewModel.selectedFilters.isEmpty
                        ? "No regression items found in this report."
                        : "No regression items match the current filters."
                )
                .frame(minHeight: 200)
            }
        }
    }

    private func regressionSection(title: String, items: [RegressionDetailItem], totalCount: Int, sectionColor: Color) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle()
                    .fill(sectionColor)
                    .frame(width: 8, height: 8)
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text("(\(items.count)/\(totalCount))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            LazyVStack(spacing: 0) {
                ForEach(Array(items.prefix(200).enumerated()), id: \.element.id) { index, item in
                    regressionDetailRow(item)
                    if index < items.prefix(200).count - 1 {
                        Divider()
                            .padding(.leading, 12)
                    }
                }
            }
            .background(Color(.systemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
        }
    }

    private func regressionDetailRow(_ item: RegressionDetailItem) -> some View {
        let isExpanded = viewModel.expandedItems.contains(item.id)

        return Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                viewModel.toggleExpanded(item.id)
            }
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                // Main row: severity icon, model/metric, change %
                HStack {
                    severityIndicator(for: item)

                    VStack(alignment: .leading, spacing: 2) {
                        if let model = item.groupInfo?["model"] ?? item.groupInfo?["name"] {
                            Text(model)
                                .font(.subheadline.weight(.medium))
                                .lineLimit(1)
                        }
                        if let metric = item.groupInfo?["metric"] {
                            Text(metric)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }

                    Spacer()

                    if let change = item.changePercent {
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(String(format: "%+.1f%%", change))
                                .font(.subheadline.weight(.bold).monospacedDigit())
                                .foregroundStyle(changeColor(change))

                            if let baseline = item.baselinePoint?.value,
                               let latest = item.latestPoint?.value {
                                Text("\(formatValue(baseline)) -> \(formatValue(latest))")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }

                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 4)
                }

                // Extra group info chips (collapsed)
                if !isExpanded, let groupInfo = item.groupInfo, groupInfo.count > 2 {
                    let extraKeys = groupInfo.keys.sorted().filter { $0 != "model" && $0 != "metric" && $0 != "name" }
                    if !extraKeys.isEmpty {
                        FlowLayout(spacing: 4) {
                            ForEach(extraKeys.prefix(4), id: \.self) { key in
                                if let value = groupInfo[key] {
                                    groupInfoChip(key: key, value: value)
                                }
                            }
                        }
                    }
                }

                // Expanded detail
                if isExpanded {
                    Divider()
                        .padding(.vertical, 2)

                    expandedDetails(for: item)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(rowBackgroundForChange(item.changePercent ?? 0))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func expandedDetails(for item: RegressionDetailItem) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            // Before/After comparison
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Baseline")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(formatValue(item.baselinePoint?.value ?? 0))
                        .font(.system(.callout, design: .monospaced).weight(.medium))
                        .foregroundStyle(.primary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(Color(.systemGray6))
                .clipShape(RoundedRectangle(cornerRadius: 6))

                Image(systemName: "arrow.right")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 4) {
                    Text("Latest")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(formatValue(item.latestPoint?.value ?? 0))
                        .font(.system(.callout, design: .monospaced).weight(.medium))
                        .foregroundStyle(changeColor(item.changePercent ?? 0))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(rowBackgroundForChange(item.changePercent ?? 0).opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }

            // All group info tags
            if let groupInfo = item.groupInfo, !groupInfo.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Properties")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    FlowLayout(spacing: 6) {
                        ForEach(Array(groupInfo.keys.sorted()), id: \.self) { key in
                            if let value = groupInfo[key] {
                                groupInfoChip(key: key, value: value)
                            }
                        }
                    }
                }
            }

            // Commit info
            if let baselineCommit = item.baselinePoint?.commit,
               let latestCommit = item.latestPoint?.commit {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Commits")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    HStack(spacing: 12) {
                        commitInfo(label: "Baseline", commit: baselineCommit)
                        commitInfo(label: "Latest", commit: latestCommit)
                    }
                }
            }
        }
    }

    private func severityIndicator(for item: RegressionDetailItem) -> some View {
        let severity = abs(item.changePercent ?? 0)
        let color: Color
        let icon: String

        if severity >= 20 {
            color = AppColors.failure
            icon = "xmark.octagon.fill"
        } else if severity >= 10 {
            color = AppColors.unstable
            icon = "exclamationmark.triangle.fill"
        } else {
            color = AppColors.pending
            icon = "info.circle.fill"
        }

        return Image(systemName: icon)
            .font(.body)
            .foregroundStyle(color)
    }

    private func groupInfoChip(key: String, value: String) -> some View {
        HStack(spacing: 4) {
            Text(key)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption2)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(Color(.tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    private func commitInfo(label: String, commit: String) -> some View {
        HStack(spacing: 4) {
            Text("\(label):")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(String(commit.prefix(7)))
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Helpers

    private func changeColor(_ change: Double) -> Color {
        let absChange = abs(change)
        if absChange < 1 { return .primary }
        if change > 0 { return AppColors.failure }
        return AppColors.success
    }

    private func rowBackgroundForChange(_ change: Double) -> Color {
        let severity = abs(change)
        if severity >= 20 { return AppColors.failure.opacity(0.04) }
        if severity >= 10 { return AppColors.unstable.opacity(0.04) }
        return .clear
    }

    private func formatValue(_ value: Double) -> String {
        if value >= 1_000_000 {
            return String(format: "%.1fM", value / 1_000_000)
        } else if value >= 1_000 {
            return String(format: "%.1fK", value / 1_000)
        } else if value < 0.01 && value > 0 {
            return String(format: "%.4f", value)
        } else {
            return String(format: "%.2f", value)
        }
    }
}

// MARK: - FlowLayout Helper

struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = FlowResult(in: proposal.replacingUnspecifiedDimensions().width, subviews: subviews, spacing: spacing)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = FlowResult(in: bounds.width, subviews: subviews, spacing: spacing)
        for (index, subview) in subviews.enumerated() {
            subview.place(at: CGPoint(x: bounds.minX + result.frames[index].minX, y: bounds.minY + result.frames[index].minY), proposal: .unspecified)
        }
    }

    struct FlowResult {
        var frames: [CGRect] = []
        var size: CGSize = .zero

        init(in maxWidth: CGFloat, subviews: Subviews, spacing: CGFloat) {
            var currentX: CGFloat = 0
            var currentY: CGFloat = 0
            var lineHeight: CGFloat = 0

            for subview in subviews {
                let size = subview.sizeThatFits(.unspecified)
                if currentX + size.width > maxWidth && currentX > 0 {
                    currentX = 0
                    currentY += lineHeight + spacing
                    lineHeight = 0
                }
                frames.append(CGRect(x: currentX, y: currentY, width: size.width, height: size.height))
                lineHeight = max(lineHeight, size.height)
                currentX += size.width + spacing
            }

            self.size = CGSize(width: maxWidth, height: currentY + lineHeight)
        }
    }
}

// MARK: - ViewModel

enum RegressionViewMode {
    case table
}

enum RegressionSortOrder {
    case severity
    case changePercent
}

@MainActor
final class RegressionReportViewModel: ObservableObject {
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

    @Published var state: ViewState = .idle
    @Published var report: RegressionReport?
    @Published var selectedView: RegressionViewMode = .table
    @Published var selectedFilters: [String: String] = [:]
    @Published var sortOrder: RegressionSortOrder = .severity
    @Published var expandedItems: Set<String> = []

    private let apiClient: APIClientProtocol

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    // MARK: - Computed

    var filteredRegressionItems: [RegressionDetailItem] {
        filterItems(report?.details?.regression ?? [])
    }

    var filteredSuspiciousItems: [RegressionDetailItem] {
        filterItems(report?.details?.suspicious ?? [])
    }

    var sortedRegressionItems: [RegressionDetailItem] {
        sortItems(filteredRegressionItems)
    }

    var sortedSuspiciousItems: [RegressionDetailItem] {
        sortItems(filteredSuspiciousItems)
    }

    var totalFilteredCount: Int {
        filteredRegressionItems.count + filteredSuspiciousItems.count
    }

    private func filterItems(_ items: [RegressionDetailItem]) -> [RegressionDetailItem] {
        let activeFilters = selectedFilters.filter { !$0.value.isEmpty }
        guard !activeFilters.isEmpty else { return items }

        return items.filter { item in
            guard let groupInfo = item.groupInfo else { return false }
            return activeFilters.allSatisfy { key, value in
                groupInfo[key] == value
            }
        }
    }

    private func sortItems(_ items: [RegressionDetailItem]) -> [RegressionDetailItem] {
        switch sortOrder {
        case .severity:
            return items.sorted { abs($0.changePercent ?? 0) > abs($1.changePercent ?? 0) }
        case .changePercent:
            return items.sorted { ($0.changePercent ?? 0) > ($1.changePercent ?? 0) }
        }
    }

    // MARK: - Actions

    func loadReport(id: String) async {
        state = .loading
        do {
            let result: RegressionReport = try await apiClient.fetch(
                APIEndpoint.regressionReport(id: id)
            )
            report = result
            state = .loaded
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    func updateFilter(key: String, value: String?) {
        if let value {
            selectedFilters[key] = value
        } else {
            selectedFilters.removeValue(forKey: key)
        }
    }

    func clearFilters() {
        selectedFilters.removeAll()
    }

    func toggleExpanded(_ itemId: String) {
        if expandedItems.contains(itemId) {
            expandedItems.remove(itemId)
        } else {
            expandedItems.insert(itemId)
        }
    }

    func formatDate(_ dateString: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fallback = ISO8601DateFormatter()

        guard let date = formatter.date(from: dateString) ?? fallback.date(from: dateString) else {
            return dateString
        }

        let relative = RelativeDateTimeFormatter()
        relative.unitsStyle = .abbreviated
        return relative.localizedString(for: date, relativeTo: Date())
    }
}

#Preview {
    NavigationStack {
        RegressionReportView(reportId: "test-report-123")
    }
}
