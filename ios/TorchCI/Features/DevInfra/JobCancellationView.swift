import SwiftUI

struct JobCancellationView: View {
    /// The Grafana public dashboard ID for the Job Cancellation dashboard.
    /// This matches the web version at torchci/pages/job_cancellation_dashboard.tsx.
    private static let grafanaDashboardID = "c540578db0b741168e1a94e80e21f6f7"

    var body: some View {
        VStack(spacing: 0) {
            headerSection
                .padding(.horizontal)
                .padding(.top, 8)

            Divider()
                .padding(.top, 12)

            GrafanaDashboardView(dashboardID: Self.grafanaDashboardID)
        }
        .navigationTitle("Job Cancellations")
        .navigationBarTitleDisplayMode(.large)
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(spacing: 10) {
            HStack {
                Text("Powered by Grafana")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer()
            }

            LinkButton(
                title: "Open in Browser",
                url: "https://disz2yd9jqnwc.cloudfront.net/public-dashboards/\(Self.grafanaDashboardID)",
                icon: "safari"
            )
        }
    }
}

#Preview {
    NavigationStack {
        JobCancellationView()
    }
}
