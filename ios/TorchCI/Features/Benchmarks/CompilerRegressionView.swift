import SwiftUI

struct CompilerRegressionView: View {
    // MARK: - State

    @State private var state: ViewState = .idle
    @State private var regressionReports: [RegressionReport] = []
    @State private var searchText: String = ""
    @State private var selectedSeverity: SeverityFilter = .all
    @State private var selectedTimeRange: TimeRangeFilter = .all
    @State private var expandedItems: Set<String> = []

    private let apiClient: APIClientProtocol = APIClient.shared

    enum ViewState: Equatable {
        case idle
        case loading
        case loaded
        case error(String)
    }

    enum SeverityFilter: String, CaseIterable, CustomStringConvertible {
        case all = "All"
        case critical = "Critical"
        case warning = "Warning"
        case minor = "Minor"

        var description: String { rawValue }
    }

    enum TimeRangeFilter: String, CaseIterable, CustomStringConvertible {
        case all = "All Time"
        case day = "24 Hours"
        case week = "7 Days"
        case month = "30 Days"

        var description: String { rawValue }
    }

    // MARK: - Computed

    private var allRegressionDetailItems: [RegressionDetailItemWithReport] {
        regressionReports.flatMap { report in
            (report.details?.regression ?? []).map { item in
                RegressionDetailItemWithReport(item: item, report: report)
            }
        }
    }

    private var filteredItems: [RegressionDetailItemWithReport] {
        allRegressionDetailItems.filter { entry in
            let searchMatch = searchText.isEmpty
                || (entry.item.groupInfo?["model"] ?? "").lowercased().contains(searchText.lowercased())
                || (entry.item.groupInfo?["metric"] ?? "").lowercased().contains(searchText.lowercased())

            let severityMatch: Bool
            switch selectedSeverity {
            case .all:
                severityMatch = true
            case .critical:
                severityMatch = abs(entry.item.changePercent ?? 0) >= 20
            case .warning:
                severityMatch = abs(entry.item.changePercent ?? 0) >= 10 && abs(entry.item.changePercent ?? 0) < 20
            case .minor:
                severityMatch = abs(entry.item.changePercent ?? 0) < 10
            }

            let timeMatch: Bool
            switch selectedTimeRange {
            case .all:
                timeMatch = true
            case .day, .week, .month:
                guard let createdAt = entry.report.createdAt else {
                    timeMatch = false
                    return searchMatch && severityMatch && timeMatch
                }
                let cutoffDate = Calendar.current.date(
                    byAdding: selectedTimeRange == .day ? .hour : .day,
                    value: selectedTimeRange == .day ? -24 : (selectedTimeRange == .week ? -7 : -30),
                    to: Date()
                ) ?? Date()
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                let fallback = ISO8601DateFormatter()
                guard let reportDate = formatter.date(from: createdAt) ?? fallback.date(from: createdAt) else {
                    timeMatch = false
                    return searchMatch && severityMatch && timeMatch
                }
                timeMatch = reportDate >= cutoffDate
            }

            return searchMatch && severityMatch && timeMatch
        }
    }

    private var sortedItems: [RegressionDetailItemWithReport] {
        filteredItems.sorted { abs($0.item.changePercent ?? 0) > abs($1.item.changePercent ?? 0) }
    }

    private var criticalCount: Int {
        allRegressionDetailItems.filter { abs($0.item.changePercent ?? 0) >= 20 }.count
    }

    private var warningCount: Int {
        allRegressionDetailItems.filter { abs($0.item.changePercent ?? 0) >= 10 && abs($0.item.changePercent ?? 0) < 20 }.count
    }

    private var minorCount: Int {
        allRegressionDetailItems.filter { abs($0.item.changePercent ?? 0) < 10 }.count
    }

    // MARK: - Body

    var body: some View {
        Group {
            switch state {
            case .idle, .loading where regressionReports.isEmpty:
                LoadingView(message: "Loading regressions...")

            case .error(let message) where regressionReports.isEmpty:
                ErrorView(
                    error: NSError(domain: "", code: 0, userInfo: [NSLocalizedDescriptionKey: message]),
                    retryAction: { Task { await loadData() } }
                )

            default:
                regressionContent
            }
        }
        .navigationTitle("Regressions")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if state == .idle {
                await loadData()
            }
        }
    }

    // MARK: - Content

    private var regressionContent: some View {
        ScrollView {
            VStack(spacing: 16) {
                summarySection

                filtersSection

                regressionsList
            }
            .padding()
        }
        .refreshable {
            await loadData()
        }
        .overlay {
            if state == .loading && !regressionReports.isEmpty {
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

    // MARK: - Summary

    private var summarySection: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            ScalarPanel(
                label: "Total",
                value: "\(allRegressionDetailItems.count)",
                icon: "exclamationmark.triangle",
                valueColor: allRegressionDetailItems.isEmpty ? AppColors.success : AppColors.failure
            )

            ScalarPanel(
                label: "Critical",
                value: "\(criticalCount)",
                icon: "xmark.octagon",
                valueColor: criticalCount > 0 ? AppColors.failure : AppColors.success
            )

            ScalarPanel(
                label: "Warning",
                value: "\(warningCount)",
                icon: "exclamationmark.triangle",
                valueColor: warningCount > 0 ? AppColors.unstable : AppColors.success
            )

            ScalarPanel(
                label: "Minor",
                value: "\(minorCount)",
                icon: "info.circle",
                valueColor: AppColors.pending
            )
        }
    }

    // MARK: - Filters

    private var filtersSection: some View {
        VStack(spacing: 10) {
            SearchBar(text: $searchText, placeholder: "Filter by model or metric...")

            VStack(spacing: 8) {
                // Severity filters
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(SeverityFilter.allCases, id: \.self) { severity in
                            Button {
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    selectedSeverity = severity
                                }
                            } label: {
                                HStack(spacing: 4) {
                                    if severity != .all {
                                        Circle()
                                            .fill(colorForSeverity(severity))
                                            .frame(width: 6, height: 6)
                                    }
                                    Text(severity.rawValue)
                                        .font(.caption)
                                        .fontWeight(selectedSeverity == severity ? .semibold : .regular)
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(
                                    selectedSeverity == severity
                                        ? Color.accentColor
                                        : Color(.systemGray5)
                                )
                                .foregroundStyle(
                                    selectedSeverity == severity ? .white : .primary
                                )
                                .clipShape(Capsule())
                            }
                        }
                    }
                    .padding(.horizontal, 1)
                }

                // Time range filters
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(TimeRangeFilter.allCases, id: \.self) { timeRange in
                            Button {
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    selectedTimeRange = timeRange
                                }
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "clock")
                                        .font(.system(size: 10))
                                    Text(timeRange.rawValue)
                                        .font(.caption)
                                        .fontWeight(selectedTimeRange == timeRange ? .semibold : .regular)
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(
                                    selectedTimeRange == timeRange
                                        ? Color.accentColor
                                        : Color(.systemGray5)
                                )
                                .foregroundStyle(
                                    selectedTimeRange == timeRange ? .white : .primary
                                )
                                .clipShape(Capsule())
                            }
                        }
                    }
                    .padding(.horizontal, 1)
                }
            }
        }
    }

    // MARK: - Regressions List

    private var regressionsList: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !sortedItems.isEmpty {
                HStack {
                    Text("Showing \(min(sortedItems.count, 200)) of \(allRegressionDetailItems.count)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    if sortedItems.count != allRegressionDetailItems.count {
                        Text("filtered")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color(.systemGray5))
                            .clipShape(Capsule())
                    }
                }
            }

            if sortedItems.isEmpty {
                EmptyStateView(
                    icon: "checkmark.shield",
                    title: "No Regressions Found",
                    message: selectedSeverity == .all && searchText.isEmpty
                        ? "No regressions detected."
                        : "No regressions match the current filters."
                )
                .frame(minHeight: 200)
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(Array(sortedItems.prefix(200).enumerated()), id: \.element.id) { index, entry in
                        regressionRow(entry)

                        if index < sortedItems.prefix(200).count - 1 {
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
    }

    private func regressionRow(_ entry: RegressionDetailItemWithReport) -> some View {
        let isExpanded = expandedItems.contains(entry.id)

        return Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                if isExpanded {
                    expandedItems.remove(entry.id)
                } else {
                    expandedItems.insert(entry.id)
                }
            }
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                // Main row
                HStack {
                    severityIndicator(for: entry.item)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.item.groupInfo?["model"] ?? "Unknown Model")
                            .font(.subheadline.weight(.medium))
                            .lineLimit(2)

                        Text(entry.item.groupInfo?["metric"] ?? "")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 8)

                    VStack(alignment: .trailing, spacing: 2) {
                        Text(String(format: "%+.1f%%", entry.item.changePercent ?? 0))
                            .font(.subheadline.weight(.bold).monospacedDigit())
                            .foregroundStyle(changeColor(entry.item.changePercent ?? 0))

                        if let delta = entry.item.latestPoint?.value.flatMap({ latest in entry.item.baselinePoint?.value.map { latest - $0 } }) {
                            Text(String(format: "%.2f", delta))
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                    }

                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 4)
                }

                // Compact comparison
                if !isExpanded {
                    HStack(spacing: 0) {
                        Text(formatValue(entry.item.baselinePoint?.value ?? 0))
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)

                        Image(systemName: "arrow.right")
                            .font(.system(size: 8))
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 4)

                        Text(formatValue(entry.item.latestPoint?.value ?? 0))
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(changeColor(entry.item.changePercent ?? 0))

                        Spacer(minLength: 8)

                        groupInfoChips(for: entry.item, compact: true)
                    }
                }

                // Expanded details
                if isExpanded {
                    Divider()
                        .padding(.vertical, 4)

                    expandedDetails(for: entry)
                }
            }
            .padding(12)
            .background(severityBackground(for: entry.item))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func groupInfoChips(for item: RegressionDetailItem, compact: Bool) -> some View {
        let keysToSkip: Set<String> = ["model", "metric"]
        let extraKeys = (item.groupInfo ?? [:])
            .filter { !keysToSkip.contains($0.key) }
            .sorted { $0.key < $1.key }

        return Group {
            if extraKeys.isEmpty {
                EmptyView()
            } else {
                HStack(spacing: 4) {
                    ForEach(extraKeys.prefix(compact ? 2 : extraKeys.count), id: \.key) { key, value in
                        Text(value)
                            .font(.system(size: compact ? 9 : 10))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(Color(.systemGray6))
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                }
            }
        }
    }

    private func expandedDetails(for entry: RegressionDetailItemWithReport) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            // All group info tags
            if let groupInfo = entry.item.groupInfo, !groupInfo.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Configuration")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)

                    FlowLayout(spacing: 6) {
                        ForEach(Array(groupInfo.keys.sorted()), id: \.self) { key in
                            if let value = groupInfo[key] {
                                HStack(spacing: 3) {
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
                        }
                    }
                }
            }

            // Before/After comparison
            VStack(alignment: .leading, spacing: 8) {
                Text("Comparison")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)

                HStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Before")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        Text(formatValue(entry.item.baselinePoint?.value ?? 0))
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

                    VStack(alignment: .leading, spacing: 4) {
                        Text("After")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        Text(formatValue(entry.item.latestPoint?.value ?? 0))
                            .font(.system(.callout, design: .monospaced).weight(.medium))
                            .foregroundStyle(changeColor(entry.item.changePercent ?? 0))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(severityBackground(for: entry.item).opacity(0.3))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }
            }

            // Delta and change
            if let delta = entry.item.latestPoint?.value.flatMap({ latest in entry.item.baselinePoint?.value.map { latest - $0 } }) {
                HStack(spacing: 12) {
                    HStack(spacing: 4) {
                        Image(systemName: "plusminus")
                            .font(.caption2)
                        Text("Delta:")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(String(format: "%.4f", delta))
                            .font(.system(.caption, design: .monospaced).weight(.medium))
                            .foregroundStyle(.primary)
                    }

                    if let change = entry.item.changePercent {
                        HStack(spacing: 4) {
                            Image(systemName: "percent")
                                .font(.caption2)
                            Text("Change:")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(String(format: "%+.2f%%", change))
                                .font(.system(.caption, design: .monospaced).weight(.medium))
                                .foregroundStyle(changeColor(change))
                        }
                    }
                }
            }

            // Commit info
            if let baseCommit = entry.item.baselinePoint?.commit,
               let latestCommit = entry.item.latestPoint?.commit {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Commits")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)

                    HStack(spacing: 12) {
                        HStack(spacing: 4) {
                            Text("Base:")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                            Text(String(baseCommit.prefix(7)))
                                .font(.system(.caption2, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                        HStack(spacing: 4) {
                            Text("Latest:")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                            Text(String(latestCommit.prefix(7)))
                                .font(.system(.caption2, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            // Report metadata
            VStack(alignment: .leading, spacing: 6) {
                if let reportId = entry.report.reportId, !reportId.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "doc.text")
                            .font(.caption2)
                        Text("Report:")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(reportId)
                            .font(.caption)
                            .foregroundStyle(.primary)
                    }
                }

                if let status = entry.report.status, !status.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "flag")
                            .font(.caption2)
                        Text("Status:")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(status.replacingOccurrences(of: "_", with: " ").capitalized)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(statusColor(status))
                    }
                }

                if let createdAt = entry.report.createdAt {
                    HStack(spacing: 4) {
                        Image(systemName: "clock")
                            .font(.caption2)
                        Text("Detected:")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(formatDate(createdAt))
                            .font(.caption)
                            .foregroundStyle(.primary)
                    }
                }
            }
        }
    }

    // MARK: - Helpers

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

    private func severityBackground(for item: RegressionDetailItem) -> Color {
        let severity = abs(item.changePercent ?? 0)
        if severity >= 20 { return AppColors.failure.opacity(0.04) }
        if severity >= 10 { return AppColors.unstable.opacity(0.04) }
        return .clear
    }

    private func changeColor(_ change: Double) -> Color {
        if change > 0 { return AppColors.failure }
        if change < 0 { return AppColors.success }
        return .primary
    }

    private func colorForSeverity(_ severity: SeverityFilter) -> Color {
        switch severity {
        case .all: return .primary
        case .critical: return AppColors.failure
        case .warning: return AppColors.unstable
        case .minor: return AppColors.pending
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "no_regression": return AppColors.success
        case "regression": return AppColors.failure
        case "suspicious": return AppColors.unstable
        default: return .secondary
        }
    }

    private func formatValue(_ value: Double) -> String {
        if value >= 1_000_000 {
            return String(format: "%.2fM", value / 1_000_000)
        } else if value >= 1_000 {
            return String(format: "%.1fK", value / 1_000)
        } else if value < 0.01 && value > 0 {
            return String(format: "%.4f", value)
        } else {
            return String(format: "%.2f", value)
        }
    }

    private func formatDate(_ dateString: String) -> String {
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

    private func loadData() async {
        state = .loading
        do {
            let result: RegressionReportListResponse = try await apiClient.fetch(
                APIEndpoint.regressionReports(reportId: "compiler_precompute")
            )
            regressionReports = result.reports ?? []
            state = .loaded
        } catch {
            state = .error(error.localizedDescription)
        }
    }
}

// MARK: - Supporting Types

private struct RegressionDetailItemWithReport: Identifiable {
    let item: RegressionDetailItem
    let report: RegressionReport

    var id: String { "\(report.id)-\(item.id)" }
}

#Preview {
    NavigationStack {
        CompilerRegressionView()
    }
}
