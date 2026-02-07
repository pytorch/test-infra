# TorchCI iOS App - Implementation Plan

## Overview
Native iOS app for the PyTorch CI HUD (torchci) dashboard. Provides mobile-friendly access to all CI monitoring, metrics, benchmarks, test management, and AI-powered analysis tools. Includes push notifications for HUD failures blocking viable/strict.

## Tech Stack
- **Language**: Swift 6
- **UI Framework**: SwiftUI (iOS 17+)
- **Architecture**: MVVM + Coordinator pattern
- **Networking**: URLSession with async/await, Combine for reactive streams
- **Charts**: Swift Charts (native)
- **Auth**: GitHub OAuth via ASWebAuthenticationSession
- **Storage**: SwiftData for local caching, Keychain for tokens
- **Push Notifications**: APNs + background fetch for HUD monitoring
- **Dependencies**: Zero third-party dependencies (all Apple frameworks)

## Architecture

### Layer Structure
```
┌─────────────────────────────────────┐
│           App / Navigation          │
├─────────────────────────────────────┤
│         Feature Modules             │
│  (HUD, Metrics, Benchmarks, etc.)  │
├─────────────────────────────────────┤
│         Shared UI Components        │
│  (Charts, Pickers, Cards, etc.)    │
├─────────────────────────────────────┤
│            Core Services            │
│  (API, Auth, Cache, Notifications) │
├─────────────────────────────────────┤
│          Models & Types             │
└─────────────────────────────────────┘
```

### Navigation
- Tab-based main navigation (5 tabs):
  1. **HUD** - CI Dashboard (default)
  2. **Metrics** - Metrics & KPIs
  3. **Tests** - Test search & flaky tests
  4. **Benchmarks** - Performance benchmarks
  5. **More** - Dev Infra tools, Settings, AI Agent

### Data Flow
```
API Client → Repository → ViewModel → SwiftUI View
                ↕
          SwiftData Cache
```

## Pages / Screens (Complete List)

### Tab 1: HUD
1. **HUD Grid** - Main commit/job grid with horizontal scroll
2. **Commit Detail** - Full commit info with job breakdown
3. **PR Detail** - PR info with commit selector
4. **Job Detail** - Job logs, artifacts, annotation
5. **Workflow Detail** - Workflow status visualization

### Tab 2: Metrics
6. **Metrics Dashboard** - Time series panels, granularity picker
7. **KPIs** - 6-month trend cards
8. **Reliability** - Failure breakdown by type
9. **Autorevert Metrics** - Success rates, false positives
10. **vLLM Metrics** - vLLM-specific CI metrics
11. **TTS (Time to Signal)** - Percentile analysis
12. **Build Time Metrics** - Build duration trends
13. **Queue Time Analysis** - Queue wait analysis
14. **Cost Analysis** - CI cost breakdown
15. **Claude Billing** - AI usage costs

### Tab 3: Tests
16. **Test Search** - Search by name/suite/file
17. **Test Info** - Detailed test history
18. **Test File Report** - Per-file summaries
19. **Disabled Tests** - Disabled test management
20. **Flaky Test Detail** - Flaky test patterns

### Tab 4: Benchmarks
21. **Benchmark List** - Available benchmarks
22. **Benchmark Dashboard** - Time series performance
23. **Compiler Benchmarks** - Compiler performance
24. **Compiler Regression** - Regression detection
25. **LLM Benchmarks** - LLM performance
26. **TorchAO Benchmarks** - TorchAO metrics
27. **Benchmark Single** - Individual benchmark view
28. **Regression Report** - Detailed regression analysis

### Tab 5: More
29. **Failure Analysis** - Global failure search
30. **Failed Jobs Classifier** - Job failure annotation
31. **Runners** - Self-hosted runner status
32. **Utilization Report** - Resource utilization
33. **Utilization Workflow** - Per-workflow utilization
34. **Job Cancellation** - Cancellation tracking
35. **Nightlies** - Nightly build status
36. **TorchAgent (Flambeau)** - AI chat interface
37. **Shared TorchAgent Session** - View shared chats
38. **Settings** - App preferences, notifications
39. **Notification Preferences** - Configure HUD alerts
40. **Login** - GitHub OAuth

## Notification System (HUD Failure Alerts)
- Monitor HUD for 3+ consecutive failing commits on viable/strict
- Background fetch every 5 minutes when app is backgrounded
- Push notification with:
  - Number of consecutive failures
  - Branch affected (viable/strict)
  - Most common failure patterns
  - Quick action to view in app
- User configurable: repos, branches, threshold count
- Local notifications (no server needed) via background refresh

## Design System
- **Colors**: Adaptive (light/dark mode)
  - Success: Green (#2DA44E)
  - Failure: Red (#CF222E)
  - Pending: Yellow (#BF8700)
  - Unstable: Orange (#E16F24)
  - Skipped: Gray (#8B949E)
- **Typography**: SF Pro (system default)
- **Spacing**: 8pt grid system
- **Components**: Native SwiftUI with custom modifiers
- **Icons**: SF Symbols throughout

## File Structure
```
ios/
├── TorchCI/
│   ├── App/
│   │   ├── TorchCIApp.swift
│   │   ├── AppCoordinator.swift
│   │   ├── ContentView.swift
│   │   └── Assets.xcassets/
│   ├── Core/
│   │   ├── Network/
│   │   │   ├── APIClient.swift
│   │   │   ├── APIEndpoint.swift
│   │   │   ├── APIError.swift
│   │   │   └── NetworkMonitor.swift
│   │   ├── Auth/
│   │   │   ├── AuthManager.swift
│   │   │   ├── KeychainHelper.swift
│   │   │   └── GitHubOAuth.swift
│   │   ├── Cache/
│   │   │   ├── CacheManager.swift
│   │   │   └── Models/ (SwiftData)
│   │   ├── Notifications/
│   │   │   ├── NotificationManager.swift
│   │   │   ├── HUDMonitor.swift
│   │   │   └── NotificationPreferences.swift
│   │   └── Theme/
│   │       ├── AppTheme.swift
│   │       ├── Colors.swift
│   │       └── Typography.swift
│   ├── Models/
│   │   ├── JobData.swift
│   │   ├── CommitData.swift
│   │   ├── HUDData.swift
│   │   ├── PRData.swift
│   │   ├── BenchmarkData.swift
│   │   ├── MetricsData.swift
│   │   ├── TestData.swift
│   │   ├── RunnerData.swift
│   │   ├── UtilizationData.swift
│   │   └── TorchAgentData.swift
│   ├── Features/
│   │   ├── HUD/
│   │   │   ├── HUDView.swift
│   │   │   ├── HUDViewModel.swift
│   │   │   ├── HUDGridView.swift
│   │   │   ├── JobCellView.swift
│   │   │   ├── CommitRowView.swift
│   │   │   ├── CommitDetailView.swift
│   │   │   ├── CommitDetailViewModel.swift
│   │   │   ├── PRDetailView.swift
│   │   │   ├── PRDetailViewModel.swift
│   │   │   ├── JobDetailView.swift
│   │   │   ├── JobDetailViewModel.swift
│   │   │   └── Components/
│   │   │       ├── JobStatusBadge.swift
│   │   │       ├── WorkflowSection.swift
│   │   │       ├── FilterBar.swift
│   │   │       ├── RepoSelector.swift
│   │   │       └── BranchSelector.swift
│   │   ├── Metrics/
│   │   │   ├── MetricsDashboardView.swift
│   │   │   ├── MetricsDashboardViewModel.swift
│   │   │   ├── KPIsView.swift
│   │   │   ├── KPIsViewModel.swift
│   │   │   ├── ReliabilityView.swift
│   │   │   ├── ReliabilityViewModel.swift
│   │   │   ├── AutorevertMetricsView.swift
│   │   │   ├── TTSView.swift
│   │   │   ├── QueueTimeView.swift
│   │   │   ├── CostAnalysisView.swift
│   │   │   ├── BuildTimeView.swift
│   │   │   ├── VLLMMetricsView.swift
│   │   │   └── Components/
│   │   │       ├── TimeSeriesChart.swift
│   │   │       ├── GranularityPicker.swift
│   │   │       ├── TimeRangePicker.swift
│   │   │       ├── MetricCard.swift
│   │   │       └── ScalarPanel.swift
│   │   ├── Tests/
│   │   │   ├── TestSearchView.swift
│   │   │   ├── TestSearchViewModel.swift
│   │   │   ├── TestInfoView.swift
│   │   │   ├── TestInfoViewModel.swift
│   │   │   ├── DisabledTestsView.swift
│   │   │   ├── DisabledTestsViewModel.swift
│   │   │   ├── TestFileReportView.swift
│   │   │   └── Components/
│   │   │       ├── TestResultRow.swift
│   │   │       └── TestStatusBadge.swift
│   │   ├── Benchmarks/
│   │   │   ├── BenchmarkListView.swift
│   │   │   ├── BenchmarkListViewModel.swift
│   │   │   ├── BenchmarkDashboardView.swift
│   │   │   ├── BenchmarkDashboardViewModel.swift
│   │   │   ├── CompilerBenchmarkView.swift
│   │   │   ├── CompilerRegressionView.swift
│   │   │   ├── LLMBenchmarkView.swift
│   │   │   ├── TorchAOBenchmarkView.swift
│   │   │   ├── RegressionReportView.swift
│   │   │   └── Components/
│   │   │       ├── BenchmarkChart.swift
│   │   │       ├── BenchmarkCard.swift
│   │   │       └── ModelPicker.swift
│   │   ├── DevInfra/
│   │   │   ├── FailureAnalysisView.swift
│   │   │   ├── FailureAnalysisViewModel.swift
│   │   │   ├── FailedJobsView.swift
│   │   │   ├── FailedJobsViewModel.swift
│   │   │   ├── RunnersView.swift
│   │   │   ├── RunnersViewModel.swift
│   │   │   ├── UtilizationView.swift
│   │   │   ├── UtilizationViewModel.swift
│   │   │   ├── NightliesView.swift
│   │   │   └── JobCancellationView.swift
│   │   ├── TorchAgent/
│   │   │   ├── TorchAgentView.swift
│   │   │   ├── TorchAgentViewModel.swift
│   │   │   ├── ChatMessageView.swift
│   │   │   ├── ChatHistoryView.swift
│   │   │   ├── SharedSessionView.swift
│   │   │   └── Components/
│   │   │       ├── MessageBubble.swift
│   │   │       ├── ToolUseView.swift
│   │   │       ├── StreamingIndicator.swift
│   │   │       └── QueryInputBar.swift
│   │   └── Settings/
│   │       ├── SettingsView.swift
│   │       ├── NotificationSettingsView.swift
│   │       ├── LoginView.swift
│   │       └── AboutView.swift
│   └── SharedUI/
│       ├── StatusBadge.swift
│       ├── LoadingView.swift
│       ├── ErrorView.swift
│       ├── EmptyStateView.swift
│       ├── SearchBar.swift
│       ├── RefreshableScrollView.swift
│       ├── PaginationView.swift
│       ├── SegmentedPicker.swift
│       ├── InfoCard.swift
│       ├── SectionHeader.swift
│       └── SafariView.swift
├── TorchCITests/
│   ├── Core/
│   │   ├── APIClientTests.swift
│   │   ├── AuthManagerTests.swift
│   │   ├── KeychainHelperTests.swift
│   │   ├── CacheManagerTests.swift
│   │   └── HUDMonitorTests.swift
│   ├── Models/
│   │   ├── JobDataTests.swift
│   │   ├── CommitDataTests.swift
│   │   ├── HUDDataTests.swift
│   │   └── BenchmarkDataTests.swift
│   ├── ViewModels/
│   │   ├── HUDViewModelTests.swift
│   │   ├── MetricsViewModelTests.swift
│   │   ├── TestSearchViewModelTests.swift
│   │   └── TorchAgentViewModelTests.swift
│   └── Mocks/
│       ├── MockAPIClient.swift
│       ├── MockAuthManager.swift
│       └── MockData.swift
├── TorchCIUITests/
│   ├── HUDUITests.swift
│   ├── NavigationUITests.swift
│   ├── MetricsUITests.swift
│   └── SettingsUITests.swift
├── TorchCI.xcodeproj/
│   └── project.pbxproj
├── plan.md
└── progress.md
```

## Implementation Phases

### Phase 1: Foundation (Core + Models + Scaffold)
- Xcode project setup
- Core networking layer (APIClient, endpoints)
- Authentication (GitHub OAuth)
- Data models (all API response types)
- Theme system
- Shared UI components
- Tab navigation shell

### Phase 2: Primary Screens
- HUD Grid (main dashboard)
- Commit Detail
- PR Detail
- Job Detail
- Metrics Dashboard
- Test Search

### Phase 3: Secondary Screens
- KPIs, Reliability, TTS
- Benchmark List + Dashboard
- Failure Analysis
- Disabled Tests
- Runners
- Settings

### Phase 4: Advanced Features
- TorchAgent chat (streaming)
- Notification system (HUD monitoring)
- Cost Analysis charts
- Utilization reports
- vLLM metrics
- Queue Time Analysis

### Phase 5: Polish & Testing
- Unit tests for all ViewModels
- UI tests for critical flows
- Accessibility audit
- Performance optimization
- Offline support refinement

## Mobile UX Adaptations

### HUD Grid
- Horizontal scroll with frozen first column (commit info)
- Pinch-to-zoom for dense grids
- Tap job cell → detail sheet
- Pull-to-refresh
- Swipe between pages

### Charts
- Native Swift Charts with touch interaction
- Tap for data point details
- Pinch to zoom time range
- Landscape mode for full-width charts

### Tables
- Expandable/collapsible sections
- Swipe actions where applicable
- Search/filter at top
- Pull-to-refresh

### Navigation
- Deep linking support (torchci:// URL scheme)
- Handoff support (open same page on Mac)
- Share sheets for all detail pages
