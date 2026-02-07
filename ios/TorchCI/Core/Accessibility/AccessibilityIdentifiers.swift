import Foundation

/// Centralized accessibility identifiers for all screens and interactive elements.
/// Used by VoiceOver and UI tests to locate and interact with specific views.
enum AccessibilityID {

    // MARK: - Tab Bar

    enum Tab {
        static let hud = "tab_hud"
        static let metrics = "tab_metrics"
        static let tests = "tab_tests"
        static let benchmarks = "tab_benchmarks"
        static let more = "tab_more"
    }

    // MARK: - HUD Screen

    enum HUD {
        static let grid = "hud_grid"
        static let searchBar = "hud_search"
        static let repoSelector = "hud_repo_selector"
        static let branchSelector = "hud_branch_selector"
        static let regexToggle = "hud_regex_toggle"
        static let filterClearButton = "hud_filter_clear"
        static let filterResultCount = "hud_filter_result_count"
        static let paginationView = "hud_pagination"
        static let refreshIndicator = "hud_refresh"
        static let failureWarningBanner = "hud_failure_warning_banner"
        static let emptyState = "hud_empty_state"
        static let loadingIndicator = "hud_loading"
        static let errorView = "hud_error"

        // Grid components
        static let frozenColumn = "hud_frozen_column"
        static let scrollableGrid = "hud_scrollable_grid"
        static let jobNameHeaders = "hud_job_name_headers"

        /// Returns the identifier for a commit row at the given index.
        static func commitRow(_ index: Int) -> String {
            "hud_commit_row_\(index)"
        }

        /// Returns the identifier for a specific job cell.
        static func jobCell(row: Int, column: Int) -> String {
            "hud_job_cell_\(row)_\(column)"
        }
    }

    // MARK: - Commit Detail Screen

    enum CommitDetail {
        static let headerSection = "commit_detail_header"
        static let title = "commit_detail_title"
        static let author = "commit_detail_author"
        static let shaLabel = "commit_detail_sha"
        static let copyShaButton = "commit_detail_copy_sha"
        static let prLink = "commit_detail_pr_link"
        static let commitMessageDisclosure = "commit_detail_message_disclosure"
        static let autorevertBanner = "commit_detail_autorevert_banner"
        static let summaryStats = "commit_detail_summary_stats"
        static let totalJobsStat = "commit_detail_total_jobs"
        static let passedJobsStat = "commit_detail_passed_jobs"
        static let failedJobsStat = "commit_detail_failed_jobs"
        static let pendingJobsStat = "commit_detail_pending_jobs"
        static let viewOnGitHubButton = "commit_detail_view_github"
        static let viewPRButton = "commit_detail_view_pr"
        static let jobsSection = "commit_detail_jobs_section"
        static let emptyJobsState = "commit_detail_empty_jobs"

        /// Returns the identifier for a workflow section.
        static func workflowSection(_ name: String) -> String {
            "commit_detail_workflow_\(name.slugified)"
        }

        /// Returns the identifier for a job row within a workflow.
        static func jobRow(_ jobId: Int) -> String {
            "commit_detail_job_\(jobId)"
        }
    }

    // MARK: - PR Detail Screen

    enum PRDetail {
        static let headerSection = "pr_detail_header"
        static let title = "pr_detail_title"
        static let stateBadge = "pr_detail_state_badge"
        static let author = "pr_detail_author"
        static let prNumber = "pr_detail_pr_number"
        static let viewOnGitHubButton = "pr_detail_view_github"
        static let commitsSection = "pr_detail_commits_section"
        static let commitSelector = "pr_detail_commit_selector"
        static let summaryStats = "pr_detail_summary_stats"
        static let jobsSection = "pr_detail_jobs_section"
        static let descriptionSection = "pr_detail_description"
        static let selectCommitEmptyState = "pr_detail_select_commit_empty"

        /// Returns the identifier for a commit chip in the PR commit selector.
        static func commitChip(_ sha: String) -> String {
            "pr_detail_commit_\(sha.prefix(7))"
        }
    }

    // MARK: - Job Detail Sheet

    enum JobDetail {
        static let headerSection = "job_detail_header"
        static let jobName = "job_detail_name"
        static let statusBadge = "job_detail_status"
        static let duration = "job_detail_duration"
        static let failureLinesSection = "job_detail_failure_lines"
        static let failureCapturesSection = "job_detail_failure_captures"
        static let runnerSection = "job_detail_runner"
        static let linksSection = "job_detail_links"
        static let viewOnGitHubButton = "job_detail_view_github"
        static let viewLogsButton = "job_detail_view_logs"
        static let copyLinkButton = "job_detail_copy_link"
        static let doneButton = "job_detail_done"
        static let stepsSection = "job_detail_steps"
    }

    // MARK: - Metrics Dashboard

    enum Metrics {
        static let redRatePanel = "metrics_red_rate"
        static let forceMergesPanel = "metrics_force_merges"
        static let ttsPanel = "metrics_tts"
        static let timeRangePicker = "metrics_time_range_picker"
        static let granularityPicker = "metrics_granularity_picker"
        static let exploreSection = "metrics_explore_section"
        static let trendsSection = "metrics_trends_section"
        static let loadingIndicator = "metrics_loading"
        static let errorView = "metrics_error"

        // Navigation links
        static let kpisLink = "metrics_nav_kpis"
        static let reliabilityLink = "metrics_nav_reliability"
        static let autorevertLink = "metrics_nav_autorevert"
        static let vllmLink = "metrics_nav_vllm"
        static let ttsLink = "metrics_nav_tts"
        static let queueTimeLink = "metrics_nav_queue_time"
        static let costLink = "metrics_nav_cost"
        static let buildTimeLink = "metrics_nav_build_time"

        // Charts
        static let redRateChart = "metrics_chart_red_rate"
        static let forceMergesChart = "metrics_chart_force_merges"
        static let ttsChart = "metrics_chart_tts"
        static let queueTimeChart = "metrics_chart_queue_time"
        static let disabledTestsChart = "metrics_chart_disabled_tests"
    }

    // MARK: - KPIs View

    enum KPIs {
        static let loadingIndicator = "kpis_loading"
        static let errorView = "kpis_error"
        static let cardList = "kpis_card_list"

        /// Returns the identifier for a KPI card by name.
        static func card(_ name: String) -> String {
            "kpis_card_\(name.slugified)"
        }
    }

    // MARK: - Reliability View

    enum Reliability {
        static let loadingIndicator = "reliability_loading"
        static let errorView = "reliability_error"
        static let workflowList = "reliability_workflow_list"

        /// Returns the identifier for a workflow row.
        static func workflowRow(_ name: String) -> String {
            "reliability_workflow_\(name.slugified)"
        }
    }

    // MARK: - Tests Screen

    enum Tests {
        static let searchBar = "tests_search_bar"
        static let tabPicker = "tests_tab_picker"
        static let allTab = "tests_tab_all"
        static let flakyTab = "tests_tab_flaky"
        static let disabledTab = "tests_tab_disabled"
        static let resultsList = "tests_results_list"
        static let paginationView = "tests_pagination"
        static let loadingIndicator = "tests_loading"
        static let errorView = "tests_error"
        static let emptyState = "tests_empty_state"

        /// Returns the identifier for a test result row.
        static func testRow(_ name: String) -> String {
            "tests_row_\(name.slugified)"
        }

        /// Returns the identifier for a disabled test row.
        static func disabledTestRow(_ name: String) -> String {
            "tests_disabled_row_\(name.slugified)"
        }
    }

    // MARK: - Test Info View

    enum TestInfo {
        static let loadingIndicator = "test_info_loading"
        static let errorView = "test_info_error"
        static let statsSection = "test_info_stats"
        static let failuresSection = "test_info_failures"
        static let statusHistorySection = "test_info_status_history"
    }

    // MARK: - Benchmarks Screen

    enum Benchmarks {
        static let searchBar = "benchmarks_search_bar"
        static let quickLinksSection = "benchmarks_quick_links"
        static let compilersLink = "benchmarks_compilers"
        static let llmsLink = "benchmarks_llms"
        static let torchAOLink = "benchmarks_torchaO"
        static let cardsList = "benchmarks_cards_list"
        static let loadingIndicator = "benchmarks_loading"
        static let errorView = "benchmarks_error"
        static let emptyState = "benchmarks_empty_state"

        /// Returns the identifier for a benchmark card.
        static func benchmarkCard(_ id: String) -> String {
            "benchmarks_card_\(id.slugified)"
        }
    }

    // MARK: - Benchmark Dashboard

    enum BenchmarkDashboard {
        static let modelPicker = "benchmark_dashboard_model_picker"
        static let chart = "benchmark_dashboard_chart"
        static let summarySection = "benchmark_dashboard_summary"
        static let loadingIndicator = "benchmark_dashboard_loading"
        static let errorView = "benchmark_dashboard_error"
    }

    // MARK: - More Screen

    enum More {
        static let devInfraSection = "more_dev_infra_section"
        static let failureAnalysisLink = "more_failure_analysis"
        static let failedJobsLink = "more_failed_jobs"
        static let runnersLink = "more_runners"
        static let utilizationLink = "more_utilization"
        static let nightliesLink = "more_nightlies"
        static let jobCancellationsLink = "more_job_cancellations"
        static let queueTimeLink = "more_queue_time"
        static let costAnalysisLink = "more_cost_analysis"
        static let buildTimeLink = "more_build_time"

        static let aiSection = "more_ai_section"
        static let torchAgentLink = "more_torch_agent"
        static let claudeBillingLink = "more_claude_billing"

        static let accountSection = "more_account_section"
        static let signedInLabel = "more_signed_in_label"
        static let signOutButton = "more_sign_out"
        static let signInLink = "more_sign_in"

        static let settingsLink = "more_settings"
        static let notificationsLink = "more_notifications"
    }

    // MARK: - Failure Analysis

    enum FailureAnalysis {
        static let searchBar = "failure_analysis_search_bar"
        static let searchButton = "failure_analysis_search_button"
        static let dateRangeToggle = "failure_analysis_date_range_toggle"
        static let startDatePicker = "failure_analysis_start_date"
        static let endDatePicker = "failure_analysis_end_date"
        static let resetDateButton = "failure_analysis_reset_date"
        static let clearButton = "failure_analysis_clear"
        static let resultsList = "failure_analysis_results"
        static let summarySection = "failure_analysis_summary"
        static let distributionSection = "failure_analysis_distribution"
        static let failuresSection = "failure_analysis_failures"
        static let loadingIndicator = "failure_analysis_loading"
        static let errorView = "failure_analysis_error"
        static let emptyState = "failure_analysis_empty_state"
        static let idleState = "failure_analysis_idle"
    }

    // MARK: - Failed Jobs Classifier

    enum FailedJobs {
        static let repoSelector = "failed_jobs_repo_selector"
        static let branchSelector = "failed_jobs_branch_selector"
        static let searchBar = "failed_jobs_search_bar"
        static let failureTypeBar = "failed_jobs_failure_type_bar"
        static let jobsList = "failed_jobs_list"
        static let paginationView = "failed_jobs_pagination"
        static let loadingIndicator = "failed_jobs_loading"
        static let errorView = "failed_jobs_error"
        static let emptyState = "failed_jobs_empty_state"
        static let summarySection = "failed_jobs_summary"

        /// Returns the identifier for a failure type filter chip.
        static func failureTypeChip(_ type: String) -> String {
            "failed_jobs_type_\(type.slugified)"
        }

        /// Returns the identifier for an annotation button on a job.
        static func annotationButton(jobId: Int, value: String) -> String {
            "failed_jobs_annotate_\(jobId)_\(value.slugified)"
        }
    }

    // MARK: - Torch Agent (AI Chat)

    enum TorchAgent {
        static let welcomeScreen = "torch_agent_welcome"
        static let messagesList = "torch_agent_messages"
        static let queryInputBar = "torch_agent_input_bar"
        static let queryTextField = "torch_agent_query_field"
        static let sendButton = "torch_agent_send"
        static let cancelButton = "torch_agent_cancel"
        static let historyButton = "torch_agent_history"
        static let shareButton = "torch_agent_share"
        static let streamingIndicator = "torch_agent_streaming"
        static let betaBadge = "torch_agent_beta_badge"

        /// Returns the identifier for an example prompt button.
        static func examplePrompt(_ index: Int) -> String {
            "torch_agent_example_\(index)"
        }

        /// Returns the identifier for a chat message.
        static func message(_ id: String) -> String {
            "torch_agent_message_\(id)"
        }
    }

    // MARK: - Settings

    enum Settings {
        static let appearanceSection = "settings_appearance"
        static let lightTheme = "settings_theme_light"
        static let darkTheme = "settings_theme_dark"
        static let systemTheme = "settings_theme_system"
        static let defaultRepoSelector = "settings_default_repo"
        static let defaultBranchSelector = "settings_default_branch"
        static let cacheSize = "settings_cache_size"
        static let clearCacheButton = "settings_clear_cache"
        static let clearCacheConfirmation = "settings_clear_cache_confirm"
        static let aboutLink = "settings_about"
        static let githubRepoLink = "settings_github_repo"
        static let feedbackLink = "settings_feedback"
    }

    // MARK: - Notification Settings

    enum NotificationSettings {
        static let authorizationStatus = "notification_auth_status"
        static let enableButton = "notification_enable"
        static let openSettingsButton = "notification_open_settings"
        static let masterToggle = "notification_master_toggle"
        static let failureThresholdStepper = "notification_threshold_stepper"
        static let monitoredBranchesSection = "notification_branches"
        static let addBranchButton = "notification_add_branch"
        static let monitoredReposSection = "notification_repos"
        static let addRepoButton = "notification_add_repo"
        static let testNotificationButton = "notification_send_test"

        /// Returns the identifier for a monitored branch row.
        static func branchRow(_ name: String) -> String {
            "notification_branch_\(name.slugified)"
        }

        /// Returns the identifier for a monitored repo row.
        static func repoRow(_ name: String) -> String {
            "notification_repo_\(name.slugified)"
        }
    }

    // MARK: - Shared / Reusable Components

    enum Shared {
        static let loadingView = "shared_loading"
        static let errorView = "shared_error"
        static let errorRetryButton = "shared_error_retry"
        static let emptyStateView = "shared_empty_state"
        static let emptyStateAction = "shared_empty_state_action"
        static let safariView = "shared_safari"
        static let paginationPrevious = "shared_pagination_previous"
        static let paginationNext = "shared_pagination_next"
        static let paginationPageLabel = "shared_pagination_page_label"
        static let searchBarClearButton = "shared_search_clear"
        static let infoCard = "shared_info_card"
        static let statusBadge = "shared_status_badge"
        static let jobStatusIcon = "shared_job_status_icon"
    }
}

// MARK: - String Helper

private extension String {
    /// Converts an arbitrary string to a URL/identifier-safe slug.
    var slugified: String {
        lowercased()
            .replacingOccurrences(
                of: "[^a-z0-9]+",
                with: "_",
                options: .regularExpression
            )
            .trimmingCharacters(in: CharacterSet(charactersIn: "_"))
    }
}
