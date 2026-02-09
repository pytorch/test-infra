import SwiftUI
import Charts

struct KPIsView: View {
    @StateObject private var viewModel = KPIsViewModel()

    var body: some View {
        Group {
            switch viewModel.state {
            case .loading:
                LoadingView(message: "Loading KPIs...")

            case .error(let message):
                ErrorView(error: NSError(domain: "", code: 0, userInfo: [
                    NSLocalizedDescriptionKey: message,
                ])) {
                    Task { await viewModel.loadKPIs() }
                }

            case .loaded:
                kpiContent
            }
        }
        .navigationTitle("KPIs")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                timeRangeMenu
            }
        }
        .task {
            await viewModel.loadKPIs()
        }
    }

    @ViewBuilder
    private var timeRangeMenu: some View {
        Menu {
            ForEach([TimeRange.presets[4], TimeRange.presets[5], TimeRange.presets[6]]) { range in
                Button {
                    Task {
                        await viewModel.changeTimeRange(range)
                    }
                } label: {
                    HStack {
                        Text(range.label)
                        if viewModel.selectedTimeRange.id == range.id {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(viewModel.selectedTimeRange.label)
                    .font(.subheadline)
                Image(systemName: "chevron.down")
                    .font(.caption2)
            }
            .foregroundStyle(.blue)
        }
    }

    @ViewBuilder
    private var kpiContent: some View {
        ScrollView {
            if viewModel.kpis.isEmpty {
                ContentUnavailableView(
                    "No KPIs Available",
                    systemImage: "chart.bar.xaxis",
                    description: Text("No metrics data found for the selected time range.")
                )
                .padding(.top, 40)
            } else {
                LazyVStack(spacing: 12) {
                    ForEach(viewModel.kpis, id: \.name) { kpi in
                        KPICardView(
                            kpi: kpi,
                            formattedValue: viewModel.formatValue(for: kpi),
                            sparklineData: viewModel.sparkline(for: kpi),
                            accentColor: viewModel.color(for: kpi)
                        )
                    }
                }
                .padding()
            }
        }
        .refreshable {
            await viewModel.refresh()
        }
    }
}

// MARK: - KPI Card

private struct KPICardView: View {
    let kpi: KPIData
    let formattedValue: String
    let sparklineData: [TimeSeriesDataPoint]
    let accentColor: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header with title and trend
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(kpi.name)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)

                    Text(formattedValue)
                        .font(.title.bold())
                        .foregroundStyle(accentColor)
                }

                Spacer()

                trendBadge
            }

            // Sparkline chart
            SparklineChart(
                data: sparklineData,
                color: accentColor,
                height: 60
            )

            // Optional target
            if let target = kpi.target {
                HStack(spacing: 4) {
                    Image(systemName: "target")
                        .font(.caption2)
                    Text("Target: \(String(format: "%.1f", target))")
                        .font(.caption2)
                }
                .foregroundStyle(.tertiary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.04), radius: 2, y: 1)
    }

    @ViewBuilder
    private var trendBadge: some View {
        if let trend = kpi.trendPercentage {
            let trendValue = abs(trend)
            let isPositive = trend >= 0
            let trendColor = kpi.isImproving ? AppColors.success : AppColors.failure
            let trendIcon = isPositive ? "arrow.up.right" : "arrow.down.right"

            VStack(alignment: .trailing, spacing: 2) {
                HStack(spacing: 3) {
                    Image(systemName: trendIcon)
                    Text(String(format: "%.1f%%", trendValue))
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(trendColor)

                Text("vs 30d ago")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(trendColor.opacity(0.1))
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
    }
}

#Preview {
    NavigationStack {
        KPIsView()
    }
}
