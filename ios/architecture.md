# TorchCI iOS App - Architecture

## Overview
Native iOS companion app for the PyTorch CI HUD (hud.pytorch.org). Provides mobile-friendly access to all 40+ CI monitoring screens, metrics, benchmarks, test management, and AI-powered analysis tools.

## Tech Stack
| Layer | Technology |
|-------|-----------|
| Language | Swift 6 (strict concurrency) |
| UI | SwiftUI (iOS 17+) |
| Architecture | MVVM + Coordinator |
| Networking | URLSession + async/await |
| Charts | Swift Charts (native) |
| Auth | GitHub OAuth (ASWebAuthenticationSession) |
| Storage | Keychain (tokens), UserDefaults (prefs), file cache |
| Notifications | UNUserNotificationCenter + BGTaskScheduler |
| Widgets | WidgetKit |
| Search | CoreSpotlight |
| Dependencies | Zero third-party (all Apple frameworks) |
| CI/CD | Fastlane + GitHub Actions |
| Signing | Automatic signing (Team ID via `APPLE_TEAM_ID` env var) |

## Lambda API Proxy

The iOS app does **not** call `hud.pytorch.org` directly. Instead, all API calls go through an AWS Lambda + API Gateway proxy that provides:

1. **Caching**: API Gateway caches responses with a 2-minute TTL, reducing load on the Next.js backend
2. **Bot Token Injection**: The Lambda injects the `HUD_BOT_TOKEN` into requests via `x-hud-bot-token` header, so the iOS app never needs to store or transmit this secret
3. **CORS**: Proper CORS headers for cross-origin requests
4. **Error Handling**: Forwards upstream errors with appropriate status codes

**Architecture:**
```
iOS App
  │
  │ HTTPS
  ▼
API Gateway (https://4gxl23l6f7.execute-api.us-east-1.amazonaws.com)
  │
  │ Cache: 2-min TTL per unique URL
  ▼
Lambda Function (ios/api-gateway/lambda/index.mjs)
  │
  │ Injects HUD_BOT_TOKEN header
  ▼
hud.pytorch.org (Next.js API)
```

**Source Files:**
- Lambda: `ios/api-gateway/lambda/index.mjs`
- Terraform: `ios/api-gateway/main.tf`
- iOS base URL: `APIClient.swift` line 35

The Lambda has a 2-minute in-memory cache (`Map` with TTL). On cache HIT, it returns the cached response without hitting the upstream. The `X-Cache` response header indicates HIT/MISS.

## Project Structure
```
ios/
├── TorchCI/                          # Main app target
│   ├── App/                          # App entry point & navigation
│   │   ├── TorchCIApp.swift          # @main, environment setup
│   │   ├── ContentView.swift         # Tab navigation + deep link routing
│   │   ├── DeepLinkHandler.swift     # URL scheme + universal links
│   │   └── AppDelegate.swift         # Push notification registration
│   ├── Core/                         # Infrastructure
│   │   ├── Network/                  # APIClient, APIEndpoint, APIError, NetworkMonitor
│   │   ├── Auth/                     # AuthManager, KeychainHelper
│   │   ├── Cache/                    # CacheManager (in-memory + disk)
│   │   ├── Notifications/            # HUDMonitor, NotificationManager
│   │   ├── Theme/                    # AppTheme (colors, typography)
│   │   ├── Accessibility/            # AccessibilityIdentifiers
│   │   └── Search/                   # SpotlightIndexer
│   ├── Models/                       # Decodable data types
│   │   ├── HUDData.swift             # HUDResponse, HUDRow, HUDJob
│   │   ├── CommitData.swift          # CommitResponse, JobData, JobStep
│   │   ├── PRData.swift              # PRResponse, PRCommit
│   │   ├── MetricsData.swift         # TimeSeriesDataPoint, KPIData
│   │   ├── TestData.swift            # TestResult, DisabledTest
│   │   ├── BenchmarkData.swift       # BenchmarkMetadata, RegressionReport
│   │   ├── RunnerData.swift          # Runner, RunnerGroup
│   │   ├── TorchAgentData.swift      # Message, Session, StreamChunk
│   │   └── UtilizationData.swift     # UtilizationReport, JobUtilization
│   ├── Features/                     # Feature modules
│   │   ├── HUD/                      # Main CI dashboard grid
│   │   ├── Metrics/                  # Metrics, KPIs, reliability, costs
│   │   ├── Tests/                    # Test search, info, disabled tests
│   │   ├── Benchmarks/               # Compiler, LLM, TorchAO benchmarks
│   │   ├── DevInfra/                 # Runners, utilization, failures
│   │   ├── TorchAgent/               # AI chat interface
│   │   └── Settings/                 # Login, notifications, about
│   └── SharedUI/                     # Reusable components
├── TorchCIWidget/                    # Widget extension
├── TorchCITests/                     # Unit tests (46 files, 1756 tests)
├── TorchCIUITests/                   # UI tests
├── api-gateway/                      # Lambda proxy infrastructure
│   ├── lambda/index.mjs              # Lambda function
│   └── main.tf                       # Terraform config
├── fastlane/                         # Build automation
├── .github/workflows/                # CI pipeline
└── project.yml                       # XCodeGen configuration
```

## SwiftUI Architecture (MVVM)

Each feature screen follows this pattern:

```swift
// ViewModel: @MainActor, holds state, calls APIClient
@MainActor
final class SomeViewModel: ObservableObject {
    @Published var data: [Item] = []
    @Published var isLoading = false
    @Published var error: Error?

    private let apiClient: APIClientProtocol  // Injected for testability

    func fetchData() async {
        isLoading = true
        defer { isLoading = false }
        do {
            data = try await apiClient.fetch(.someEndpoint())
        } catch {
            self.error = error
        }
    }
}

// View: observes ViewModel, renders UI
struct SomeView: View {
    @StateObject private var viewModel: SomeViewModel

    init(apiClient: APIClientProtocol = APIClient.shared) {
        _viewModel = StateObject(wrappedValue: SomeViewModel(apiClient: apiClient))
    }

    var body: some View {
        // SwiftUI content using viewModel.data
    }
}
```

**Key patterns:**
- `APIClientProtocol` is injected everywhere for testability
- `MockAPIClient` provides deterministic test data
- ViewModels are `@MainActor` to safely update `@Published` properties
- Views use `@StateObject` for owned ViewModels
- Static formatters use `nonisolated(unsafe)` for Swift 6 strict concurrency

## API Integration

All API calls go through `APIClient` -> Lambda Proxy -> `hud.pytorch.org`:

| Feature | API Endpoint | iOS Endpoint Factory |
|---------|-------------|---------------------|
| HUD Grid | `/api/hud/{owner}/{repo}/{branch}/{page}` | `APIEndpoint.hud()` |
| Commit Detail | `/api/{owner}/{repo}/commit/{sha}` | `APIEndpoint.commit()` |
| PR Detail | `/api/{owner}/{repo}/pull/{number}` | `APIEndpoint.pullRequest()` |
| Metrics (ClickHouse) | `/api/clickhouse/{queryName}?parameters={json}` | `APIEndpoint.clickhouseQuery()` |
| Test Search | `/api/flaky-tests/search` | `APIEndpoint.searchTests()` |
| Test Failures | `/api/flaky-tests/failures` | `APIEndpoint.testFailures()` |
| Test 3D Stats | `/api/flaky-tests/3dStats` | `APIEndpoint.test3dStats()` |
| Disabled Tests | `/api/flaky-tests/getDisabledTestsAndJobs` | `APIEndpoint.disabledTests()` |
| File Report | `/api/flaky-tests/fileReport` | `APIEndpoint.fileReport()` |
| Benchmark List | `/api/benchmark/list_metadata` (POST) | `APIEndpoint.benchmarkList()` |
| Benchmark TimeSeries | `/api/benchmark/get_time_series` (POST) | `APIEndpoint.benchmarkTimeSeries()` |
| Benchmark Group Data | `/api/benchmark/group_data` | `APIEndpoint.benchmarkGroupData()` |
| Regression Reports | `/api/benchmark/list_regression_summary_reports` (POST) | `APIEndpoint.regressionReports()` |
| Regression Report | `/api/benchmark/get_regression_summary_report` (POST) | `APIEndpoint.regressionReport()` |
| Failure Search | `/api/search` | `APIEndpoint.searchFailures()` |
| Similar Failures | `/api/failure` | `APIEndpoint.similarFailures()` |
| Failed Jobs | `/api/hud/{owner}/{repo}/{branch}/{page}` | `APIEndpoint.failedJobs()` |
| Failed Jobs (Annotated) | `/api/job_annotation/.../failures/{params}` | `APIEndpoint.failedJobsWithAnnotations()` |
| Autorevert Metrics | `/api/autorevert/metrics` | `APIEndpoint.autorevertMetrics()` |
| Runners | `/api/runners/{org}` | `APIEndpoint.runners()` |
| Utilization Report | `/api/list_util_reports/{groupBy}` | `APIEndpoint.utilizationReport()` |
| Utilization Metadata | `/api/list_utilization_metadata_info/{wfId}` | `APIEndpoint.utilizationMetadata()` |
| Job Utilization | `/api/job_utilization/{wfId}/{jobId}/{attempt}` | `APIEndpoint.jobUtilization()` |
| Issues by Label | `/api/issue/{label}` | `APIEndpoint.issuesByLabel()` |
| Artifacts | `/api/artifacts` | `APIEndpoint.artifacts()` |
| Workflow Dispatch | `/api/github/dispatch/...` (POST) | `APIEndpoint.workflowDispatch()` |
| TorchAgent Query | `/api/torchagent-api` (POST, streaming) | `APIEndpoint.torchAgentQuery()` |
| TorchAgent History | `/api/torchagent-get-history` | `APIEndpoint.torchAgentHistory()` |
| TorchAgent Chat | `/api/torchagent-get-chat-history` | `APIEndpoint.torchAgentChatHistory()` |
| TorchAgent Shared | `/api/torchagent-get-shared/{uuid}` | `APIEndpoint.torchAgentShared()` |
| TorchAgent Share | `/api/torchagent-share` (POST) | `APIEndpoint.torchAgentShare()` |
| TorchAgent Perms | `/api/torchagent-check-permissions` | `APIEndpoint.torchAgentCheckPermissions()` |
| TorchAgent Feedback | `/api/torchagent-feedback` (POST) | `APIEndpoint.torchAgentFeedback()` |

## Grafana Embeds

Two pages use embedded Grafana dashboards via WKWebView instead of native charts:
- **Job Cancellation**: `JobCancellationView.swift` - Embeds Grafana dashboard via CloudFront URL
- **Claude Billing**: `ClaudeBillingView.swift` - Embeds Grafana billing dashboard via CloudFront URL

These use `SafariView` (WKWebView wrapper) because the underlying data comes from Grafana, not from the torchci API.

## Custom Chart Implementations

The app implements native Swift Charts for data that the web renders with Recharts/custom React components:

| Chart Type | iOS Implementation | Web Equivalent |
|-----------|-------------------|----------------|
| HUD Job Grid | Custom `LazyHGrid` with colored cells | HTML table with colored `<td>` cells |
| Time Series | `TimeSeriesChart` (Swift Charts `LineMark`) | Recharts `LineChart` |
| KPI Panels | `ScalarPanel` + `MetricCard` | Custom React KPI cards |
| Benchmark Charts | `BenchmarkChart` (Swift Charts) | Recharts with custom tooltips |
| Reliability Breakdown | `Chart` with `BarMark` | Recharts `StackedBarChart` |
| Test 3D Stats | Not yet native (data available) | 3D scatter plot |
| TTS Distribution | `Chart` with `BarMark` | Recharts histogram |

## Shortcuts & Known Simplifications

1. **Grafana embeds**: Job Cancellation and Claude Billing use WebView embeds rather than native charts, because the data source is Grafana (not the torchci API)
2. **No 3D charts**: Test 3D Stats page doesn't have a native 3D scatter plot; shows data in a flat format
3. **No Issues page**: The web's `[repoOwner]/[repoName]/issues/[issueNumber]` page has no iOS equivalent
4. **No TorchBench/TritonBench**: `torchbench/userbenchmark` and `tritonbench/commit_view` web pages have no iOS equivalent
5. **No Query Execution Metrics**: `query_execution_metrics` web page has no iOS equivalent
6. **Simplified filters**: Some pages have fewer filter options than the web (e.g., HUD branch filter is a dropdown vs. web's text input)
7. **Static formatters**: DateFormatters cached as `nonisolated(unsafe) static let` for Swift 6 concurrency compliance and performance

## Navigation

5-tab architecture:
1. **HUD** - CI commit/job grid (default tab)
2. **Metrics** - Dashboards, KPIs, reliability
3. **Tests** - Search, flaky tests, disabled tests
4. **Benchmarks** - Compiler, LLM, TorchAO
5. **More** - Dev infra tools, AI agent, settings

Deep linking: `torchci://` URL scheme + `hud.pytorch.org` universal links.

## Notification System
- **HUDMonitor**: Actor that checks for consecutive failures via API
- **BGTaskScheduler**: Background refresh every 5 minutes
- **Local notifications**: No server needed
- **Configurable**: Threshold (default 3), branches (default viable/strict), repos

## Widget
- Small: Last commit status (pass/fail dot + SHA)
- Medium: Last 3 commits with job counts
- Large: Last 5 commits with details
- Refreshes every 15 minutes via WidgetKit timeline

## Build & Deploy
- **XCodeGen**: `xcodegen generate` from project.yml
- **Fastlane**: `fastlane build`, `fastlane test`, `fastlane beta`
- **GitHub Actions**: Auto-build on push to ios/
- **Signing**: Automatic (Team ID via `APPLE_TEAM_ID` env var)
- **TestFlight**: Public link https://testflight.apple.com/join/Xv7SNdaz
- **Bundle ID**: `com.pytorch.torchci`

## Testing
- **1756 unit tests** across 46 test files
- **MockAPIClient**: Thread-safe (`@unchecked Sendable` with `NSLock`) mock for all API calls
- **MockData**: Deterministic JSON fixtures for every endpoint
- Tests cover: API client, models, all ViewModels, view rendering, keychain, HUD monitor
