# TorchCI iOS App - Architecture

## Overview
Native iOS companion app for the PyTorch CI HUD (hud.pytorch.org). Provides mobile-friendly access to all 40+ CI monitoring screens, metrics, benchmarks, test management, and AI-powered analysis tools.

## Tech Stack
| Layer | Technology |
|-------|-----------|
| Language | Swift 6 |
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
| Signing | Team ID N324UX8D9M, Automatic signing |

## Project Structure (135 Swift files)
```
ios/
├── TorchCI/                          # Main app target
│   ├── App/                          # App entry point & navigation (4 files)
│   │   ├── TorchCIApp.swift          # @main, environment setup
│   │   ├── ContentView.swift         # Tab navigation + deep link routing
│   │   ├── DeepLinkHandler.swift     # URL scheme + universal links
│   │   └── AppDelegate.swift         # Push notification registration
│   ├── Core/                         # Infrastructure (12 files)
│   │   ├── Network/                  # APIClient, endpoints, errors, monitoring
│   │   ├── Auth/                     # GitHub OAuth, Keychain storage
│   │   ├── Cache/                    # In-memory + disk cache
│   │   ├── Notifications/            # HUD monitor, notification manager
│   │   ├── Theme/                    # Colors, typography, theme manager
│   │   ├── Accessibility/            # Identifiers for UI testing
│   │   └── Search/                   # CoreSpotlight indexing
│   ├── Models/                       # Data types (9 files)
│   │   ├── HUDData.swift             # HUDResponse, HUDRow, HUDJob
│   │   ├── CommitData.swift          # CommitResponse, JobData, JobStep
│   │   ├── PRData.swift              # PRResponse, PRCommit
│   │   ├── MetricsData.swift         # TimeSeriesDataPoint, KPIData, etc.
│   │   ├── TestData.swift            # TestResult, DisabledTest, etc.
│   │   ├── BenchmarkData.swift       # BenchmarkMetadata, RegressionReport
│   │   ├── RunnerData.swift          # Runner, RunnerGroup
│   │   ├── TorchAgentData.swift      # Message, Session, StreamChunk
│   │   └── UtilizationData.swift     # UtilizationReport, JobUtilization
│   ├── Features/                     # Feature modules (96 files)
│   │   ├── HUD/           (16)       # Main CI dashboard grid
│   │   ├── Metrics/       (16)       # Metrics, KPIs, reliability, costs
│   │   ├── Tests/          (9)       # Test search, info, disabled tests
│   │   ├── Benchmarks/   (12)       # Compiler, LLM, TorchAO benchmarks
│   │   ├── DevInfra/     (11)       # Runners, utilization, failures
│   │   ├── TorchAgent/    (9)       # AI chat interface
│   │   └── Settings/      (4)       # Login, notifications, about
│   └── SharedUI/                     # Reusable components (10 files)
├── TorchCIWidget/                    # Widget extension (4 files)
├── TorchCITests/                     # Unit tests (14 files)
│   ├── Core/                         # APIClient, Keychain, HUDMonitor tests
│   ├── Models/                       # Data model decoding tests
│   ├── ViewModels/                   # ViewModel logic tests
│   └── Mocks/                        # MockAPIClient, MockData fixtures
├── TorchCIUITests/                   # UI tests (4 files)
├── fastlane/                         # Build automation
├── .github/workflows/                # CI pipeline
└── project.yml                       # XCodeGen configuration
```

## Data Flow
```
                ┌──────────────┐
                │  hud.pytorch │
                │    .org API  │
                └──────┬───────┘
                       │ HTTPS
                ┌──────▼───────┐
                │   APIClient  │ ← async/await + streaming
                └──────┬───────┘
                       │
              ┌────────┼────────┐
              │        │        │
        ┌─────▼──┐ ┌──▼───┐ ┌─▼──────┐
        │ Cache  │ │Models│ │Keychain│
        │Manager │ │      │ │ (auth) │
        └────────┘ └──┬───┘ └────────┘
                      │
              ┌───────▼───────┐
              │  ViewModels   │ ← @MainActor, @Published
              │  (per screen) │
              └───────┬───────┘
                      │
              ┌───────▼───────┐
              │  SwiftUI      │
              │  Views        │
              └───────────────┘
```

## API Integration
The app talks to the same Next.js API as the web app:
- **HUD data**: `/api/hud/{owner}/{repo}/{branch}/{page}`
- **Commits**: `/api/{owner}/{repo}/commit/{sha}`
- **PRs**: `/api/{owner}/{repo}/pull/{number}`
- **Metrics**: `/api/clickhouse/{queryName}`
- **Tests**: `/api/flaky-tests/*`
- **Benchmarks**: `/api/benchmark/*`
- **Runners**: `/api/runners/{org}`
- **TorchAgent**: `/api/torchagent-api` (streaming)
- **Auth**: GitHub OAuth via ASWebAuthenticationSession

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

## Design System
- SF Pro typography (system)
- SF Symbols icons throughout
- Adaptive colors (light + dark mode)
- Job status colors: Green (#2DA44E), Red (#CF222E), Yellow (#BF8700), Orange (#E16F24)
- 8pt spacing grid
- Native SwiftUI components (no third-party UI libs)

## Build & Deploy
- **XCodeGen**: `xcodegen generate` from project.yml
- **Fastlane**: `fastlane build`, `fastlane test`, `fastlane beta`
- **GitHub Actions**: Auto-build on push to ios/
- **Signing**: Automatic, Team N324UX8D9M
