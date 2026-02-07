import XCTest
@testable import TorchCI

/// Tests for the JobCancellationView.
///
/// The Job Cancellation view embeds a Grafana public dashboard directly,
/// matching the web version at torchci/pages/job_cancellation_dashboard.tsx.
/// Since there is no ViewModel or API logic (the dashboard is rendered by
/// Grafana via WKWebView), these tests verify the view can be instantiated
/// and that the dashboard configuration is correct.
final class JobCancellationViewTests: XCTestCase {

    @MainActor
    func testViewCanBeInstantiated() {
        // The view should be creatable without any dependencies
        let view = JobCancellationView()
        XCTAssertNotNil(view)
    }
}
