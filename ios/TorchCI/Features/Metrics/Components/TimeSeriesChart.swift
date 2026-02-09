import SwiftUI
import Charts

struct TimeSeriesChart: View {
    let title: String
    let data: [TimeSeriesDataPoint]
    var color: Color = .blue
    var valueFormat: ValueFormat = .decimal(1)
    var showArea: Bool = true
    var chartHeight: CGFloat = 200

    @State private var selectedPoint: TimeSeriesDataPoint?
    @State private var plotWidth: CGFloat = 0

    nonisolated(unsafe) private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let isoFallbackFormatter = ISO8601DateFormatter()

    enum ValueFormat {
        case decimal(Int)
        case percentage(Int)
        case integer
        case duration

        func format(_ value: Double) -> String {
            switch self {
            case .decimal(let places):
                return String(format: "%.\(places)f", value)
            case .percentage(let places):
                return String(format: "%.\(places)f%%", value)
            case .integer:
                return String(format: "%.0f", value)
            case .duration:
                let hours = Int(value) / 3600
                let minutes = (Int(value) % 3600) / 60
                if hours > 0 {
                    return "\(hours)h \(minutes)m"
                }
                return "\(minutes)m"
            }
        }
    }

    private var validData: [(date: Date, value: Double)] {
        data.compactMap { point in
            guard let value = point.value else { return nil }
            let date = Self.isoFormatter.date(from: point.granularity_bucket)
                ?? Self.isoFallbackFormatter.date(from: point.granularity_bucket)
            guard let date else { return nil }
            return (date: date, value: value)
        }
        .sorted { $0.date < $1.date }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title)
                    .font(.headline)
                Spacer()
                if let selectedPoint {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(valueFormat.format(selectedPoint.value ?? 0))
                            .font(.subheadline.bold())
                            .foregroundStyle(color)
                        Text(selectedPoint.granularity_bucket.prefix(10))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .transition(.opacity)
                }
            }

            if validData.isEmpty {
                emptyChartView
            } else {
                chartView
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }

    @ViewBuilder
    private var emptyChartView: some View {
        RoundedRectangle(cornerRadius: 8)
            .fill(Color(.secondarySystemBackground))
            .frame(height: chartHeight)
            .overlay {
                Text("No data available")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
    }

    @ViewBuilder
    private var chartView: some View {
        Chart {
            ForEach(validData, id: \.date) { point in
                LineMark(
                    x: .value("Date", point.date),
                    y: .value("Value", point.value)
                )
                .foregroundStyle(color)
                .lineStyle(StrokeStyle(lineWidth: 2))
                .interpolationMethod(.catmullRom)

                if showArea {
                    AreaMark(
                        x: .value("Date", point.date),
                        y: .value("Value", point.value)
                    )
                    .foregroundStyle(
                        LinearGradient(
                            colors: [color.opacity(0.3), color.opacity(0.05)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .interpolationMethod(.catmullRom)
                }
            }

            if let selectedPoint, let value = selectedPoint.value {
                let formatter = ISO8601DateFormatter()
                if let date = formatter.date(from: selectedPoint.granularity_bucket) {
                    RuleMark(x: .value("Selected", date))
                        .foregroundStyle(.gray.opacity(0.3))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [5, 3]))

                    PointMark(
                        x: .value("Date", date),
                        y: .value("Value", value)
                    )
                    .foregroundStyle(color)
                    .symbolSize(60)
                }
            }
        }
        .frame(height: chartHeight)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 5)) {
                AxisValueLabel(format: .dateTime.month(.abbreviated).day())
                AxisGridLine()
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) {
                AxisValueLabel()
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
            }
        }
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle()
                    .fill(.clear)
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { drag in
                                guard let plotFrame = proxy.plotFrame else { return }
                                let origin = geometry[plotFrame].origin
                                let location = CGPoint(
                                    x: drag.location.x - origin.x,
                                    y: drag.location.y - origin.y
                                )
                                guard let date: Date = proxy.value(atX: location.x) else { return }
                                selectNearestPoint(to: date)
                            }
                            .onEnded { _ in
                                withAnimation(.easeOut(duration: 0.2)) {
                                    selectedPoint = nil
                                }
                            }
                    )
            }
        }
    }

    private func selectNearestPoint(to targetDate: Date) {
        let formatter = ISO8601DateFormatter()
        var nearest: TimeSeriesDataPoint?
        var minDistance: TimeInterval = .infinity
        for point in data {
            guard point.value != nil,
                  let date = formatter.date(from: point.granularity_bucket) else { continue }
            let distance = abs(date.timeIntervalSince(targetDate))
            if distance < minDistance {
                minDistance = distance
                nearest = point
            }
        }
        if nearest?.id != selectedPoint?.id {
            withAnimation(.easeInOut(duration: 0.15)) {
                selectedPoint = nearest
            }
        }
    }
}

// MARK: - Sparkline (compact chart for KPI cards)

struct SparklineChart: View {
    let data: [TimeSeriesDataPoint]
    var color: Color = .blue
    var height: CGFloat = 40

    private var validData: [(date: Date, value: Double)] {
        let formatter = ISO8601DateFormatter()
        return data.compactMap { point in
            guard let value = point.value,
                  let date = formatter.date(from: point.granularity_bucket) else { return nil }
            return (date: date, value: value)
        }
        .sorted { $0.date < $1.date }
    }

    var body: some View {
        if validData.isEmpty {
            Rectangle()
                .fill(Color(.systemGray5))
                .frame(height: height)
                .clipShape(RoundedRectangle(cornerRadius: 4))
        } else {
            Chart {
                ForEach(validData, id: \.date) { point in
                    LineMark(
                        x: .value("Date", point.date),
                        y: .value("Value", point.value)
                    )
                    .foregroundStyle(color)
                    .interpolationMethod(.catmullRom)

                    AreaMark(
                        x: .value("Date", point.date),
                        y: .value("Value", point.value)
                    )
                    .foregroundStyle(
                        LinearGradient(
                            colors: [color.opacity(0.2), color.opacity(0.02)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .interpolationMethod(.catmullRom)
                }
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .frame(height: height)
        }
    }
}

#Preview {
    TimeSeriesChart(
        title: "Test Metric",
        data: [
            TimeSeriesDataPoint(granularity_bucket: "2024-01-01T00:00:00Z", value: 10),
            TimeSeriesDataPoint(granularity_bucket: "2024-01-02T00:00:00Z", value: 15),
            TimeSeriesDataPoint(granularity_bucket: "2024-01-03T00:00:00Z", value: 12),
            TimeSeriesDataPoint(granularity_bucket: "2024-01-04T00:00:00Z", value: 18),
        ],
        color: .blue,
        valueFormat: .decimal(1)
    )
    .padding()
}
