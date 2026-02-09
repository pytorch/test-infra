import SwiftUI

// MARK: - Job Status Accessibility

/// A ViewModifier that provides a rich accessibility description for a CI job status element.
/// It announces the job name, its conclusion status, and optional duration so that
/// VoiceOver users can understand CI results without seeing the color-coded cells.
struct AccessibleJobStatusModifier: ViewModifier {
    let conclusion: String?
    let name: String
    let duration: String?
    let isUnstable: Bool

    func body(content: Content) -> some View {
        content
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityValue(accessibilityValue)
            .accessibilityHint(accessibilityHint)
            .accessibilityAddTraits(accessibilityTraits)
    }

    private var accessibilityLabel: Text {
        Text("Job: \(name)")
    }

    private var accessibilityValue: String {
        var parts: [String] = []
        parts.append("Status: \(statusDescription)")
        if let duration {
            parts.append("Duration: \(duration)")
        }
        return parts.joined(separator: ", ")
    }

    private var accessibilityHint: String {
        switch conclusion?.lowercased() {
        case "failure" where !isUnstable:
            return "This job has failed. Double-tap to view failure details."
        case "failure" where isUnstable:
            return "This job is marked as unstable. Double-tap for details."
        case "success":
            return "This job passed successfully. Double-tap for details."
        case "pending", "queued", "in_progress", nil:
            return "This job is still running. Double-tap for details."
        default:
            return "Double-tap to view job details."
        }
    }

    private var statusDescription: String {
        if isUnstable { return "Unstable" }
        switch conclusion?.lowercased() {
        case "success": return "Passed"
        case "failure": return "Failed"
        case "pending", "queued", "in_progress": return "Pending"
        case "skipped": return "Skipped"
        case "cancelled", "canceled": return "Cancelled"
        case nil: return "In progress"
        default: return conclusion ?? "Unknown"
        }
    }

    private var accessibilityTraits: AccessibilityTraits {
        switch conclusion?.lowercased() {
        case "failure" where !isUnstable:
            return [.isButton, .startsMediaSession]
        default:
            return .isButton
        }
    }
}

extension View {
    /// Adds a comprehensive accessibility description for a CI job status element.
    ///
    /// This modifier replaces child accessibility elements with a single, clearly announced
    /// element that describes the job name, its pass/fail/pending status, and duration.
    ///
    /// - Parameters:
    ///   - conclusion: The job conclusion string (e.g. "success", "failure", "pending").
    ///   - name: The human-readable job name.
    ///   - duration: Optional formatted duration string (e.g. "5m 23s").
    ///   - isUnstable: Whether the job is marked as unstable.
    func accessibleJobStatus(
        conclusion: String?,
        name: String,
        duration: String? = nil,
        isUnstable: Bool = false
    ) -> some View {
        modifier(AccessibleJobStatusModifier(
            conclusion: conclusion,
            name: name,
            duration: duration,
            isUnstable: isUnstable
        ))
    }
}

// MARK: - Metric Accessibility

/// A ViewModifier that announces a metric with its current value and trend direction,
/// so VoiceOver users understand dashboard data without visual indicators.
struct AccessibleMetricModifier: ViewModifier {
    let name: String
    let value: String
    let trend: MetricTrend?
    let unit: String?

    func body(content: Content) -> some View {
        content
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityValue(accessibilityValue)
            .accessibilityHint(accessibilityHint)
    }

    private var accessibilityLabel: Text {
        Text(name)
    }

    private var accessibilityValue: String {
        var result = value
        if let unit {
            result += " \(unit)"
        }
        if let trend {
            result += ", \(trend.accessibilityDescription)"
        }
        return result
    }

    private var accessibilityHint: String {
        if let trend {
            switch trend {
            case .improving(let percentage):
                return "Improved by \(formattedPercentage(percentage)) compared to the previous period."
            case .declining(let percentage):
                return "Declined by \(formattedPercentage(percentage)) compared to the previous period."
            case .stable:
                return "This metric has remained stable compared to the previous period."
            case .noData:
                return "No trend data available for comparison."
            }
        }
        return ""
    }

    private func formattedPercentage(_ value: Double) -> String {
        String(format: "%.1f percent", abs(value))
    }
}

/// Represents the trend direction for a metric value.
enum MetricTrend: Equatable {
    /// The metric is improving (lower is better for most CI metrics).
    case improving(percentage: Double)
    /// The metric is getting worse.
    case declining(percentage: Double)
    /// The metric has not changed significantly.
    case stable
    /// No previous data to compare against.
    case noData

    var accessibilityDescription: String {
        switch self {
        case .improving(let pct):
            return "trending better by \(String(format: "%.1f", abs(pct))) percent"
        case .declining(let pct):
            return "trending worse by \(String(format: "%.1f", abs(pct))) percent"
        case .stable:
            return "stable"
        case .noData:
            return "no trend data"
        }
    }

    var systemImageName: String {
        switch self {
        case .improving: return "arrow.down.right"
        case .declining: return "arrow.up.right"
        case .stable: return "arrow.right"
        case .noData: return "minus"
        }
    }

    /// Create a `MetricTrend` from a raw percentage change.
    /// Positive values mean the metric increased; the `lowerIsBetter` flag determines
    /// whether an increase is improving or declining.
    static func from(
        percentageChange: Double?,
        lowerIsBetter: Bool = true,
        stableThreshold: Double = 1.0
    ) -> MetricTrend {
        guard let change = percentageChange else { return .noData }
        if abs(change) < stableThreshold { return .stable }
        if lowerIsBetter {
            return change < 0 ? .improving(percentage: change) : .declining(percentage: change)
        } else {
            return change > 0 ? .improving(percentage: change) : .declining(percentage: change)
        }
    }
}

extension View {
    /// Adds an accessibility description for a metric panel that announces the metric name,
    /// current value, optional unit, and trend direction.
    ///
    /// - Parameters:
    ///   - name: The metric name (e.g. "Red Rate", "TTS p50").
    ///   - value: The formatted value string (e.g. "12.3%", "45m").
    ///   - trend: Optional trend information describing improvement or decline.
    ///   - unit: Optional unit label (e.g. "percent", "minutes").
    func accessibleMetric(
        name: String,
        value: String,
        trend: MetricTrend? = nil,
        unit: String? = nil
    ) -> some View {
        modifier(AccessibleMetricModifier(
            name: name,
            value: value,
            trend: trend,
            unit: unit
        ))
    }
}

// MARK: - Chart Accessibility

/// A ViewModifier that provides a summary-level accessibility description for a chart,
/// replacing individual data point announcements with a high-level overview.
struct AccessibleChartModifier: ViewModifier {
    let title: String
    let summary: String
    let dataPointCount: Int?

    func body(content: Content) -> some View {
        content
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityValue(accessibilityValue)
            .accessibilityHint("Double-tap and hold to explore individual data points.")
            .accessibilityAddTraits(.isImage)
    }

    private var accessibilityLabel: Text {
        Text("Chart: \(title)")
    }

    private var accessibilityValue: String {
        var result = summary
        if let count = dataPointCount {
            result += ". \(count) data point\(count == 1 ? "" : "s")."
        }
        return result
    }
}

extension View {
    /// Adds a summary accessibility description to a chart view. Instead of VoiceOver
    /// reading each data point individually, it announces a high-level summary.
    ///
    /// - Parameters:
    ///   - title: The chart title (e.g. "Master Commit Red %").
    ///   - summary: A textual summary of the chart data (e.g. "Ranges from 5% to 18%,
    ///     trending downward over the last 7 days.").
    ///   - dataPointCount: Optional count of data points in the chart.
    func accessibleChart(
        title: String,
        summary: String,
        dataPointCount: Int? = nil
    ) -> some View {
        modifier(AccessibleChartModifier(
            title: title,
            summary: summary,
            dataPointCount: dataPointCount
        ))
    }
}

// MARK: - Stat Cell Accessibility

/// A ViewModifier for stat cells (e.g., "42 Passed", "3 Failed") that announces
/// the label and numeric value together as a single accessible element.
struct AccessibleStatCellModifier: ViewModifier {
    let label: String
    let value: Int
    let context: String?

    func body(content: Content) -> some View {
        content
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(label))
            .accessibilityValue("\(value)" + (context.map { ", \($0)" } ?? ""))
    }
}

extension View {
    /// Adds a combined accessibility description for a stat cell showing a label and numeric value.
    ///
    /// - Parameters:
    ///   - label: The stat label (e.g. "Total", "Passed", "Failed").
    ///   - value: The numeric value.
    ///   - context: Optional additional context (e.g. "out of 150 jobs").
    func accessibleStatCell(
        label: String,
        value: Int,
        context: String? = nil
    ) -> some View {
        modifier(AccessibleStatCellModifier(
            label: label,
            value: value,
            context: context
        ))
    }
}

// MARK: - Commit Row Accessibility

/// A ViewModifier for HUD commit rows that announces the commit SHA, title, author,
/// and age in a single coherent VoiceOver description.
struct AccessibleCommitRowModifier: ViewModifier {
    let sha: String
    let title: String?
    let author: String?
    let relativeTime: String
    let prNumber: Int?
    let isForcedMerge: Bool

    func body(content: Content) -> some View {
        content
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityValue(accessibilityValue)
            .accessibilityHint("Double-tap to view commit details.")
            .accessibilityAddTraits(.isButton)
    }

    private var accessibilityLabel: Text {
        Text(title ?? "Commit \(sha.prefix(7))")
    }

    private var accessibilityValue: String {
        var parts: [String] = []
        parts.append("SHA \(sha.prefix(7))")
        if let author {
            parts.append("by \(author)")
        }
        parts.append(relativeTime)
        if let prNumber {
            parts.append("PR number \(prNumber)")
        }
        if isForcedMerge {
            parts.append("force merged")
        }
        return parts.joined(separator: ", ")
    }
}

extension View {
    /// Adds an accessibility description for an HUD commit row, combining SHA, title,
    /// author, time, and PR number into a single coherent announcement.
    ///
    /// - Parameters:
    ///   - sha: The full commit SHA.
    ///   - title: The commit title/message.
    ///   - author: The commit author's username.
    ///   - relativeTime: A human-readable relative time string (e.g. "2h ago").
    ///   - prNumber: Optional associated PR number.
    ///   - isForcedMerge: Whether this was a forced merge.
    func accessibleCommitRow(
        sha: String,
        title: String?,
        author: String?,
        relativeTime: String,
        prNumber: Int? = nil,
        isForcedMerge: Bool = false
    ) -> some View {
        modifier(AccessibleCommitRowModifier(
            sha: sha,
            title: title,
            author: author,
            relativeTime: relativeTime,
            prNumber: prNumber,
            isForcedMerge: isForcedMerge
        ))
    }
}

// MARK: - Workflow Section Accessibility

/// A ViewModifier for collapsible workflow sections that announces the workflow name,
/// job counts, and expansion state.
struct AccessibleWorkflowSectionModifier: ViewModifier {
    let workflowName: String
    let totalJobs: Int
    let successCount: Int
    let failureCount: Int
    let isExpanded: Bool

    func body(content: Content) -> some View {
        content
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Text(workflowName))
            .accessibilityValue(accessibilityValue)
            .accessibilityHint(isExpanded ? "Double-tap to collapse." : "Double-tap to expand and see jobs.")
            .accessibilityAddTraits(.isButton)
    }

    private var accessibilityValue: String {
        var parts: [String] = []
        parts.append("\(totalJobs) job\(totalJobs == 1 ? "" : "s")")
        if successCount > 0 {
            parts.append("\(successCount) passed")
        }
        if failureCount > 0 {
            parts.append("\(failureCount) failed")
        }
        parts.append(isExpanded ? "expanded" : "collapsed")
        return parts.joined(separator: ", ")
    }
}

extension View {
    /// Adds an accessibility description for a collapsible workflow section header
    /// in commit/PR detail views.
    ///
    /// - Parameters:
    ///   - workflowName: The name of the CI workflow.
    ///   - totalJobs: Total number of jobs in this workflow.
    ///   - successCount: Number of successful jobs.
    ///   - failureCount: Number of failed jobs.
    ///   - isExpanded: Whether the section is currently expanded.
    func accessibleWorkflowSection(
        workflowName: String,
        totalJobs: Int,
        successCount: Int,
        failureCount: Int,
        isExpanded: Bool
    ) -> some View {
        modifier(AccessibleWorkflowSectionModifier(
            workflowName: workflowName,
            totalJobs: totalJobs,
            successCount: successCount,
            failureCount: failureCount,
            isExpanded: isExpanded
        ))
    }
}

// MARK: - Loading / Error State Accessibility

extension View {
    /// Announces a loading state to VoiceOver, posting an announcement when loading begins.
    func accessibleLoadingState(isLoading: Bool, message: String = "Loading") -> some View {
        self
            .accessibilityElement(children: isLoading ? .ignore : .contain)
            .accessibilityLabel(isLoading ? Text(message) : Text(""))
            .accessibilityAddTraits(isLoading ? .updatesFrequently : [])
            .onChange(of: isLoading) { _, newValue in
                if newValue {
                    UIAccessibility.post(
                        notification: .announcement,
                        argument: message
                    )
                }
            }
    }

    /// Posts a VoiceOver announcement when an error occurs.
    func accessibleErrorAnnouncement(error: String?) -> some View {
        self.onChange(of: error) { _, newValue in
            if let errorMessage = newValue {
                UIAccessibility.post(
                    notification: .announcement,
                    argument: "Error: \(errorMessage)"
                )
            }
        }
    }
}

// MARK: - Convenience: Chart Summary Builder

/// Utility to generate a textual summary of time-series data for accessibility.
enum ChartSummaryBuilder {

    /// Generate a summary string for a time-series dataset.
    ///
    /// - Parameters:
    ///   - title: The chart title.
    ///   - values: The numeric values in chronological order.
    ///   - format: A closure that formats a `Double` into a display string.
    /// - Returns: A human-readable summary suitable for VoiceOver.
    static func summary(
        title: String,
        values: [Double],
        format: (Double) -> String = { String(format: "%.1f", $0) }
    ) -> String {
        guard !values.isEmpty else {
            return "\(title): No data available."
        }

        guard let minVal = values.min(),
              let maxVal = values.max(),
              let latest = values.last,
              let first = values.first else {
            return "\(title): No data available."
        }

        var parts: [String] = []
        parts.append("Ranges from \(format(minVal)) to \(format(maxVal))")
        parts.append("Current value is \(format(latest))")

        if values.count >= 2 {
            let change = latest - first
            if abs(change) < 0.01 * max(abs(first), 1) {
                parts.append("Trend is stable")
            } else if change > 0 {
                parts.append("Trending upward")
            } else {
                parts.append("Trending downward")
            }
        }

        return parts.joined(separator: ". ") + "."
    }
}
