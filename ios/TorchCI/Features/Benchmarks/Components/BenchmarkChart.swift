import Charts
import SwiftUI

struct BenchmarkChart: View {
    let dataPoints: [BenchmarkTimeSeriesPoint]
    let metricLabel: String
    var regressionCommits: Set<String> = []
    var selectedPoint: BenchmarkTimeSeriesPoint?
    var onPointSelected: ((BenchmarkTimeSeriesPoint?) -> Void)?

    @State private var rawSelectedDate: Date?
    @State private var hiddenSeries: Set<String> = []

    // Cached formatters (creating these is expensive in a computed property)
    nonisolated(unsafe) private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let isoBasic = ISO8601DateFormatter()
    nonisolated(unsafe) private static let clickhouseFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()
    nonisolated(unsafe) private static let clickhouseNoMs: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    private var parsedPoints: [ParsedChartPoint] {
        return dataPoints.compactMap { point in
            guard let dateStr = point.commitDate else { return nil }
            let date = Self.isoFractional.date(from: dateStr)
                ?? Self.isoBasic.date(from: dateStr)
                ?? Self.clickhouseFormatter.date(from: dateStr)
                ?? Self.clickhouseNoMs.date(from: dateStr)
            guard let date else { return nil }
            return ParsedChartPoint(
                date: date,
                value: point.value,
                commit: point.commit,
                model: point.model ?? "default",
                metric: point.metric ?? metricLabel,
                isRegression: regressionCommits.contains(point.commit),
                original: point
            )
        }
        .sorted { $0.date < $1.date }
    }

    private var seriesNames: [String] {
        Array(Set(parsedPoints.map(\.model))).sorted()
    }

    private var visiblePoints: [ParsedChartPoint] {
        if hiddenSeries.isEmpty { return parsedPoints }
        return parsedPoints.filter { !hiddenSeries.contains($0.model) }
    }

    private var yDomain: ClosedRange<Double> {
        let values = visiblePoints.map(\.value)
        guard let minVal = values.min(), let maxVal = values.max() else {
            return 0...1
        }
        let padding = (maxVal - minVal) * 0.1
        return (minVal - padding)...(maxVal + padding)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if parsedPoints.isEmpty {
                emptyChartPlaceholder
            } else {
                chartView
                legendView
            }
        }
    }

    // MARK: - Chart

    private var chartView: some View {
        Chart {
            ForEach(visiblePoints, id: \.id) { point in
                LineMark(
                    x: .value("Date", point.date),
                    y: .value(metricLabel, point.value)
                )
                .foregroundStyle(by: .value("Model", point.model))
                .interpolationMethod(.catmullRom)
                .lineStyle(StrokeStyle(lineWidth: 2))

                if seriesNames.count == 1 {
                    AreaMark(
                        x: .value("Date", point.date),
                        y: .value(metricLabel, point.value)
                    )
                    .foregroundStyle(
                        LinearGradient(
                            colors: [.accentColor.opacity(0.2), .accentColor.opacity(0.02)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                }

                if point.isRegression {
                    PointMark(
                        x: .value("Date", point.date),
                        y: .value(metricLabel, point.value)
                    )
                    .foregroundStyle(.red)
                    .symbolSize(80)
                    .annotation(position: .top, spacing: 4) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption2)
                            .foregroundStyle(.red)
                    }
                }
            }

            if let rawSelectedDate, let closest = closestPoint(to: rawSelectedDate) {
                RuleMark(x: .value("Selected", closest.date))
                    .foregroundStyle(.secondary.opacity(0.5))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    .annotation(
                        position: .top,
                        spacing: 4,
                        overflowResolution: .init(x: .fit(to: .chart), y: .disabled)
                    ) {
                        annotationView(for: closest)
                    }
            }
        }
        .chartYScale(domain: yDomain)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 5)) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                    .foregroundStyle(.secondary.opacity(0.3))
                AxisValueLabel(format: .dateTime.month(.abbreviated).day())
                    .font(.caption2)
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 5)) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
                    .foregroundStyle(.secondary.opacity(0.3))
                if let doubleValue = value.as(Double.self) {
                    AxisValueLabel {
                        Text(formatValue(doubleValue))
                            .font(.caption2)
                    }
                }
            }
        }
        .chartXSelection(value: $rawSelectedDate)
        .onChange(of: rawSelectedDate) { _, newValue in
            if let newValue, let closest = closestPoint(to: newValue) {
                onPointSelected?(closest.original)
            } else {
                onPointSelected?(nil)
            }
        }
        .frame(height: 240)
    }

    // MARK: - Annotation

    private func annotationView(for point: ParsedChartPoint) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(point.date, format: .dateTime.month(.abbreviated).day().hour().minute())
                .font(.caption2)
                .foregroundStyle(.secondary)

            HStack(spacing: 4) {
                Text(point.model)
                    .font(.caption2.weight(.medium))
                Text(formatValue(point.value))
                    .font(.caption.weight(.bold).monospacedDigit())
            }

            Text(String(point.commit.prefix(8)))
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
        }
        .padding(8)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .shadow(color: .black.opacity(0.1), radius: 4, y: 2)
    }

    // MARK: - Legend

    @ViewBuilder
    private var legendView: some View {
        if seriesNames.count > 1 {
            VStack(alignment: .leading, spacing: 4) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(seriesNames, id: \.self) { name in
                            let isHidden = hiddenSeries.contains(name)
                            Button {
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    if isHidden {
                                        hiddenSeries.remove(name)
                                    } else {
                                        // Don't hide the last visible series
                                        if hiddenSeries.count < seriesNames.count - 1 {
                                            hiddenSeries.insert(name)
                                        }
                                    }
                                }
                            } label: {
                                HStack(spacing: 4) {
                                    Circle()
                                        .fill(isHidden ? Color.gray.opacity(0.3) : Color.accentColor)
                                        .frame(width: 8, height: 8)
                                    Text(name)
                                        .font(.caption2)
                                        .foregroundStyle(isHidden ? .tertiary : .secondary)
                                        .strikethrough(isHidden)
                                }
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(isHidden ? Color.clear : Color(.tertiarySystemFill))
                                .clipShape(Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                if !hiddenSeries.isEmpty {
                    Text("Tap legend to show/hide series")
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    // MARK: - Empty State

    private var emptyChartPlaceholder: some View {
        RoundedRectangle(cornerRadius: 12)
            .fill(Color(.secondarySystemBackground))
            .frame(height: 240)
            .overlay {
                VStack(spacing: 8) {
                    Image(systemName: "chart.xyaxis.line")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text("No chart data available")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
    }

    // MARK: - Helpers

    private func closestPoint(to date: Date) -> ParsedChartPoint? {
        visiblePoints.min(by: {
            abs($0.date.timeIntervalSince(date)) < abs($1.date.timeIntervalSince(date))
        })
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
}

// MARK: - Internal Model

private struct ParsedChartPoint: Identifiable {
    let date: Date
    let value: Double
    let commit: String
    let model: String
    let metric: String
    let isRegression: Bool
    let original: BenchmarkTimeSeriesPoint

    var id: String { "\(commit)-\(model)-\(metric)" }
}

#Preview {
    BenchmarkChart(
        dataPoints: [],
        metricLabel: "Speedup"
    )
    .padding()
}
