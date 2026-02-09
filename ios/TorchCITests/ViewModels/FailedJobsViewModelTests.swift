import XCTest
@testable import TorchCI

@MainActor
final class FailedJobsViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: FailedJobsViewModel!
    private var testDefaults: UserDefaults!
    private var testCache: AnnotationCache!

    override func setUp() {
        super.setUp()
        testDefaults = UserDefaults(suiteName: "test_failed_jobs_vm")!
        testDefaults.removePersistentDomain(forName: "test_failed_jobs_vm")
        testCache = AnnotationCache(defaults: testDefaults)
        mockClient = MockAPIClient()
        viewModel = FailedJobsViewModel(apiClient: mockClient, annotationCache: testCache)
    }

    override func tearDown() {
        mockClient.reset()
        testDefaults.removePersistentDomain(forName: "test_failed_jobs_vm")
        testDefaults = nil
        testCache = nil
        mockClient = nil
        viewModel = nil
        UserDefaults.standard.removeObject(forKey: "default_repo")
        UserDefaults.standard.removeObject(forKey: "default_branch")
        super.tearDown()
    }

    // MARK: - Settings Defaults

    func testInitUsesDefaultRepoFromSettings() {
        UserDefaults.standard.set("pytorch/vision", forKey: "default_repo")
        let vm = FailedJobsViewModel(apiClient: mockClient, annotationCache: testCache)
        XCTAssertEqual(vm.selectedRepo.name, "vision")
    }

    func testInitUsesDefaultBranchFromSettings() {
        UserDefaults.standard.set("viable/strict", forKey: "default_branch")
        let vm = FailedJobsViewModel(apiClient: mockClient, annotationCache: testCache)
        XCTAssertEqual(vm.selectedBranch, "viable/strict")
    }

    // MARK: - Test Helpers

    /// Creates a minimal failed job for testing.
    private func makeFailedJob(
        id: Int,
        jobName: String = "linux-test / build",
        workflowName: String? = "pull",
        conclusion: String = "failure",
        htmlUrl: String? = "https://github.com/pytorch/pytorch/commit/abc1234def567/checks",
        failureLines: [String]? = nil,
        failureCaptures: [String]? = nil,
        time: String? = "2025-01-20T10:00:00Z",
        unstable: Bool? = false,
        previousRun: PreviousRun? = nil,
        durationS: Int? = 120
    ) -> JobData {
        JobData(
            id: id,
            name: jobName,
            workflowName: workflowName,
            workflowId: nil,
            jobName: jobName,
            conclusion: conclusion,
            htmlUrl: htmlUrl,
            logUrl: nil,
            durationS: durationS,
            failureLines: failureLines,
            failureCaptures: failureCaptures,
            failureContext: nil,
            runnerName: nil,
            runnerGroup: nil,
            status: "completed",
            steps: nil,
            time: time,
            unstable: unstable,
            previousRun: previousRun
        )
    }

    /// Builds a FailedJobsAnnotationResponse JSON string for the mock client.
    private func makeResponseJSON(
        jobs: [JobData],
        annotations: [String: (annotation: String, jobID: Int)] = [:]
    ) -> String {
        // Build jobs JSON array
        let jobsJSON = jobs.map { job -> String in
            let idStr = job.jobId.map { "\($0)" } ?? "null"
            let nameStr = job.name.map { "\"\($0)\"" } ?? "null"
            let wfStr = job.workflowName.map { "\"\($0)\"" } ?? "null"
            let jnStr = job.jobName.map { "\"\($0)\"" } ?? "null"
            let concStr = job.conclusion.map { "\"\($0)\"" } ?? "null"
            let urlStr = job.htmlUrl.map { "\"\($0)\"" } ?? "null"
            let durationStr = job.durationS.map { "\($0)" } ?? "null"
            let timeStr = job.time.map { "\"\($0)\"" } ?? "null"
            let unstableStr = job.unstable.map { "\($0)" } ?? "null"

            let failureLinesStr: String
            if let lines = job.failureLines {
                let escaped = lines.map { "\"\($0)\"" }.joined(separator: ",")
                failureLinesStr = "[\(escaped)]"
            } else {
                failureLinesStr = "null"
            }

            let failureCapturesStr: String
            if let captures = job.failureCaptures {
                let escaped = captures.map { "\"\($0)\"" }.joined(separator: ",")
                failureCapturesStr = "[\(escaped)]"
            } else {
                failureCapturesStr = "null"
            }

            let previousRunStr: String
            if let prev = job.previousRun {
                let prevConc = prev.conclusion.map { "\"\($0)\"" } ?? "null"
                let prevUrl = prev.htmlUrl.map { "\"\($0)\"" } ?? "null"
                previousRunStr = "{\"conclusion\":\(prevConc),\"htmlUrl\":\(prevUrl)}"
            } else {
                previousRunStr = "null"
            }

            return """
            {
                "id": \(idStr),
                "name": \(nameStr),
                "workflowName": \(wfStr),
                "jobName": \(jnStr),
                "conclusion": \(concStr),
                "htmlUrl": \(urlStr),
                "durationS": \(durationStr),
                "failureLines": \(failureLinesStr),
                "failureCaptures": \(failureCapturesStr),
                "time": \(timeStr),
                "unstable": \(unstableStr),
                "previousRun": \(previousRunStr)
            }
            """
        }.joined(separator: ",")

        // Build annotations map JSON
        let annotationsJSON = annotations.map { (key, value) -> String in
            "\"\(key)\": {\"annotation\": \"\(value.annotation)\", \"jobID\": \(value.jobID)}"
        }.joined(separator: ",")

        return """
        {
            "failedJobs": [\(jobsJSON)],
            "annotationsMap": {\(annotationsJSON)}
        }
        """
    }

    /// Registers a mock response for the failed jobs endpoint.
    private func setFailedJobsResponse(
        jobs: [JobData],
        annotations: [String: (annotation: String, jobID: Int)] = [:],
        repoOwner: String = "pytorch",
        repoName: String = "pytorch"
    ) {
        let json = makeResponseJSON(jobs: jobs, annotations: annotations)
        // The endpoint path includes encoded JSON query params, so we need
        // to match against what the view model actually generates.
        // We register using a broad path prefix approach.
        let pathPrefix = "/api/job_annotation/\(repoOwner)/\(repoName)/failures/"

        // MockAPIClient matches exact paths, so register for all plausible paths
        // by hooking into the mock response mechanism.
        // We need to find the actual path the VM will produce.
        mockClient.setResponse(json, for: pathPrefix)
    }

    /// A simpler approach: directly set jobs on the view model to test
    /// computed properties without going through the API.
    private func setJobsDirectly(_ jobs: [JobData]) {
        viewModel.jobs = jobs
        viewModel.state = .loaded
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertTrue(viewModel.jobs.isEmpty)
        XCTAssertEqual(viewModel.selectedRepo.owner, "pytorch")
        XCTAssertEqual(viewModel.selectedRepo.name, "pytorch")
        XCTAssertEqual(viewModel.selectedBranch, "main")
        XCTAssertEqual(viewModel.filterType, .all)
        XCTAssertEqual(viewModel.searchFilter, "")
        XCTAssertEqual(viewModel.currentPage, 1)
        XCTAssertEqual(viewModel.timeRangeDays, 7)
        XCTAssertTrue(viewModel.annotations.isEmpty)
        XCTAssertTrue(viewModel.isLoading == false)
    }

    func testInitialDateRange() {
        // Start date should be roughly 7 days before end date
        let diff = viewModel.endDate.timeIntervalSince(viewModel.startDate)
        let sevenDays: TimeInterval = 7 * 24 * 60 * 60
        XCTAssertEqual(diff, sevenDays, accuracy: 60) // within a minute
    }

    // MARK: - Failure Classification

    func testClassifyFailureWithAnnotation() {
        let job = makeFailedJob(id: 1)
        viewModel.annotations[1] = .brokenTrunk

        XCTAssertEqual(viewModel.classifyFailure(job), .brokenTrunk)
    }

    func testClassifyFailureAnnotationFlaky() {
        let job = makeFailedJob(id: 2)
        viewModel.annotations[2] = .flaky

        XCTAssertEqual(viewModel.classifyFailure(job), .flaky)
    }

    func testClassifyFailureAnnotationInfra() {
        let job = makeFailedJob(id: 3)
        viewModel.annotations[3] = .infra

        XCTAssertEqual(viewModel.classifyFailure(job), .infra)
    }

    func testClassifyFailureAnnotationNoneFallsThrough() {
        let job = makeFailedJob(id: 4)
        viewModel.annotations[4] = .none

        // With .none annotation, falls through to heuristics
        XCTAssertEqual(viewModel.classifyFailure(job), .notAnnotated)
    }

    func testClassifyFailureInfraByFailureLines() {
        let infraKeywords = ["docker", "runner", "timeout", "disk space",
                             "infrastructure", "connection", "oom",
                             "no space left", "network", "certificate"]

        for keyword in infraKeywords {
            let job = makeFailedJob(
                id: 100,
                failureLines: ["Error: \(keyword) issue detected"]
            )
            XCTAssertEqual(
                viewModel.classifyFailure(job),
                .infra,
                "Expected .infra for keyword '\(keyword)' in failureLines"
            )
        }
    }

    func testClassifyFailureInfraByFailureCaptures() {
        let job = makeFailedJob(
            id: 101,
            failureCaptures: ["docker pull failed: connection timeout"]
        )
        XCTAssertEqual(viewModel.classifyFailure(job), .infra)
    }

    func testClassifyFailureFlakyByUnstable() {
        let job = makeFailedJob(id: 102, unstable: true)
        XCTAssertEqual(viewModel.classifyFailure(job), .flaky)
    }

    func testClassifyFailureFlakyByPreviousRunSuccess() {
        let previousRun = PreviousRun(conclusion: "success", htmlUrl: nil)
        let job = makeFailedJob(id: 103, previousRun: previousRun)
        XCTAssertEqual(viewModel.classifyFailure(job), .flaky)
    }

    func testClassifyFailureNotAnnotatedByDefault() {
        let job = makeFailedJob(id: 104)
        XCTAssertEqual(viewModel.classifyFailure(job), .notAnnotated)
    }

    func testClassifyFailurePreviousRunFailureIsNotFlaky() {
        let previousRun = PreviousRun(conclusion: "failure", htmlUrl: nil)
        let job = makeFailedJob(id: 105, previousRun: previousRun)
        XCTAssertEqual(viewModel.classifyFailure(job), .notAnnotated)
    }

    func testClassifyFailureAnnotationTakesPriorityOverHeuristics() {
        // Job has infra keywords AND an annotation of broken_trunk
        let job = makeFailedJob(
            id: 106,
            failureLines: ["docker pull failed"],
            unstable: true
        )
        viewModel.annotations[106] = .brokenTrunk

        XCTAssertEqual(viewModel.classifyFailure(job), .brokenTrunk)
    }

    func testClassifyFailureInfraPriorityOverFlaky() {
        // Job has both infra keywords and unstable=true
        // Infra check comes before flaky check
        let job = makeFailedJob(
            id: 107,
            failureLines: ["docker connection refused"],
            unstable: true
        )

        XCTAssertEqual(viewModel.classifyFailure(job), .infra)
    }

    // MARK: - Filtered Jobs

    func testFilteredJobsReturnsOnlyFailures() {
        let jobs = [
            makeFailedJob(id: 1, conclusion: "failure"),
            makeFailedJob(id: 2, conclusion: "success"),
            makeFailedJob(id: 3, conclusion: "failure"),
        ]
        setJobsDirectly(jobs)

        XCTAssertEqual(viewModel.filteredJobs.count, 2)
        XCTAssertTrue(viewModel.filteredJobs.allSatisfy { $0.isFailure })
    }

    func testFilteredJobsWithSearchFilter() {
        let jobs = [
            makeFailedJob(id: 1, jobName: "linux-build"),
            makeFailedJob(id: 2, jobName: "windows-build"),
            makeFailedJob(id: 3, jobName: "linux-test"),
        ]
        setJobsDirectly(jobs)
        viewModel.searchFilter = "linux"

        XCTAssertEqual(viewModel.filteredJobs.count, 2)
    }

    func testFilteredJobsSearchIsCaseInsensitive() {
        let jobs = [
            makeFailedJob(id: 1, jobName: "Linux-Build"),
            makeFailedJob(id: 2, jobName: "windows-build"),
        ]
        setJobsDirectly(jobs)
        viewModel.searchFilter = "linux"

        XCTAssertEqual(viewModel.filteredJobs.count, 1)
        XCTAssertEqual(viewModel.filteredJobs.first?.jobName, "Linux-Build")
    }

    func testFilteredJobsSearchByWorkflowName() {
        let jobs = [
            makeFailedJob(id: 1, jobName: "build", workflowName: "pull"),
            makeFailedJob(id: 2, jobName: "build", workflowName: "trunk"),
        ]
        setJobsDirectly(jobs)
        viewModel.searchFilter = "trunk"

        XCTAssertEqual(viewModel.filteredJobs.count, 1)
    }

    func testFilteredJobsByFailureType() {
        let jobs = [
            makeFailedJob(id: 1, unstable: true),      // flaky
            makeFailedJob(id: 2),                       // not annotated
            makeFailedJob(id: 3, failureLines: ["docker crash"]), // infra
        ]
        setJobsDirectly(jobs)
        viewModel.filterType = .flaky

        XCTAssertEqual(viewModel.filteredJobs.count, 1)
        XCTAssertEqual(viewModel.filteredJobs.first?.jobId, 1)
    }

    func testFilteredJobsAllTypeReturnsAllFailures() {
        let jobs = [
            makeFailedJob(id: 1, unstable: true),
            makeFailedJob(id: 2),
            makeFailedJob(id: 3, failureLines: ["docker crash"]),
        ]
        setJobsDirectly(jobs)
        viewModel.filterType = .all

        XCTAssertEqual(viewModel.filteredJobs.count, 3)
    }

    // MARK: - Grouped Failures

    func testGroupedFailuresGroupsBySameSignature() {
        let jobs = [
            makeFailedJob(id: 1, jobName: "linux-test", workflowName: "pull",
                          failureCaptures: ["AssertionError: mismatch"]),
            makeFailedJob(id: 2, jobName: "linux-test", workflowName: "pull",
                          failureCaptures: ["AssertionError: mismatch"]),
            makeFailedJob(id: 3, jobName: "linux-test", workflowName: "pull",
                          failureCaptures: ["AssertionError: mismatch"]),
        ]
        setJobsDirectly(jobs)

        let allGroups = viewModel.groupedFailures.values.flatMap { $0 }
        XCTAssertEqual(allGroups.count, 1, "All 3 jobs should be in one group")
        XCTAssertEqual(allGroups.first?.count, 3)
    }

    func testGroupedFailuresSeparatesDifferentJobNames() {
        let jobs = [
            makeFailedJob(id: 1, jobName: "linux-test"),
            makeFailedJob(id: 2, jobName: "windows-test"),
        ]
        setJobsDirectly(jobs)

        let allGroups = viewModel.groupedFailures.values.flatMap { $0 }
        XCTAssertEqual(allGroups.count, 2, "Different job names should create separate groups")
    }

    func testGroupedFailuresSortedByCountDescending() {
        let jobs = [
            makeFailedJob(id: 1, jobName: "job-a"),
            makeFailedJob(id: 2, jobName: "job-b"),
            makeFailedJob(id: 3, jobName: "job-b"),
            makeFailedJob(id: 4, jobName: "job-b"),
        ]
        setJobsDirectly(jobs)

        // All are .notAnnotated since no annotations or heuristics
        let groups = viewModel.groupedFailures[.notAnnotated] ?? []
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups.first?.count, 3, "Largest group should come first")
        XCTAssertEqual(groups.last?.count, 1)
    }

    func testGroupedFailuresRespectSearchFilter() {
        let jobs = [
            makeFailedJob(id: 1, jobName: "linux-test"),
            makeFailedJob(id: 2, jobName: "windows-test"),
        ]
        setJobsDirectly(jobs)
        viewModel.searchFilter = "linux"

        let allGroups = viewModel.groupedFailures.values.flatMap { $0 }
        XCTAssertEqual(allGroups.count, 1)
    }

    func testGroupedFailuresEmptyWhenNoFailures() {
        let jobs = [
            makeFailedJob(id: 1, conclusion: "success"),
        ]
        setJobsDirectly(jobs)

        XCTAssertTrue(viewModel.groupedFailures.isEmpty)
    }

    func testGroupedFailuresByDifferentCaptures() {
        // Same job name but different failure captures should be separate groups
        let jobs = [
            makeFailedJob(id: 1, jobName: "linux-test",
                          failureCaptures: ["Error A"]),
            makeFailedJob(id: 2, jobName: "linux-test",
                          failureCaptures: ["Error B"]),
        ]
        setJobsDirectly(jobs)

        let allGroups = viewModel.groupedFailures.values.flatMap { $0 }
        XCTAssertEqual(allGroups.count, 2, "Different failure captures mean different groups")
    }

    // MARK: - Failure Counts

    func testFailureCountsAllIsTotal() {
        let jobs = [
            makeFailedJob(id: 1),
            makeFailedJob(id: 2, unstable: true),
            makeFailedJob(id: 3, failureLines: ["docker error"]),
            makeFailedJob(id: 4, conclusion: "success"),
        ]
        setJobsDirectly(jobs)

        XCTAssertEqual(viewModel.failureCounts[.all], 3)
    }

    func testFailureCountsBreakdown() {
        let jobs = [
            makeFailedJob(id: 1, unstable: true),                          // flaky
            makeFailedJob(id: 2, unstable: true),                          // flaky
            makeFailedJob(id: 3, failureLines: ["docker pull failed"]),    // infra
            makeFailedJob(id: 4),                                          // not annotated
        ]
        setJobsDirectly(jobs)

        XCTAssertEqual(viewModel.failureCounts[.flaky], 2)
        XCTAssertEqual(viewModel.failureCounts[.infra], 1)
        XCTAssertEqual(viewModel.failureCounts[.notAnnotated], 1)
        XCTAssertNil(viewModel.failureCounts[.brokenTrunk])
    }

    func testFailureCountsWithAnnotations() {
        let jobs = [
            makeFailedJob(id: 1),
            makeFailedJob(id: 2),
        ]
        setJobsDirectly(jobs)
        viewModel.annotations[1] = .brokenTrunk

        XCTAssertEqual(viewModel.failureCounts[.brokenTrunk], 1)
        XCTAssertEqual(viewModel.failureCounts[.notAnnotated], 1)
    }

    // MARK: - Repo Selection

    func testSelectRepoUpdatesSelectedRepo() {
        let newRepo = RepoConfig(owner: "pytorch", name: "vision")
        viewModel.selectRepo(newRepo)

        XCTAssertEqual(viewModel.selectedRepo.name, "vision")
        XCTAssertEqual(viewModel.currentPage, 1)
        XCTAssertTrue(viewModel.jobs.isEmpty)
    }

    func testSelectSameRepoDoesNotReload() {
        let currentRepo = viewModel.selectedRepo
        viewModel.selectRepo(currentRepo)

        // Should not have triggered a load (no call recorded)
        XCTAssertEqual(mockClient.callCount, 0)
    }

    // MARK: - Branch Selection

    func testSelectBranchUpdatesBranch() {
        viewModel.selectBranch("viable/strict")

        XCTAssertEqual(viewModel.selectedBranch, "viable/strict")
        XCTAssertEqual(viewModel.currentPage, 1)
        XCTAssertTrue(viewModel.jobs.isEmpty)
    }

    func testSelectSameBranchDoesNotReload() {
        viewModel.selectBranch("main")

        XCTAssertEqual(mockClient.callCount, 0)
    }

    // MARK: - Time Range

    func testUpdateTimeRange() {
        viewModel.updateTimeRange(days: 14)

        XCTAssertEqual(viewModel.timeRangeDays, 14)
        XCTAssertEqual(viewModel.currentPage, 1)
        XCTAssertTrue(viewModel.jobs.isEmpty)

        let diff = viewModel.endDate.timeIntervalSince(viewModel.startDate)
        let fourteenDays: TimeInterval = 14 * 24 * 60 * 60
        XCTAssertEqual(diff, fourteenDays, accuracy: 60)
    }

    func testUpdateCustomDateRange() {
        let start = Date(timeIntervalSince1970: 1000000)
        let end = Date(timeIntervalSince1970: 2000000)

        viewModel.updateCustomDateRange(start: start, end: end)

        XCTAssertEqual(viewModel.startDate, start)
        XCTAssertEqual(viewModel.endDate, end)
        XCTAssertEqual(viewModel.currentPage, 1)
        XCTAssertTrue(viewModel.jobs.isEmpty)
    }

    // MARK: - Annotations

    func testAnnotateJob() {
        viewModel.annotate(jobId: 42, value: .brokenTrunk)

        XCTAssertEqual(viewModel.annotations[42], .brokenTrunk)
    }

    func testAnnotateJobOverwritesPrevious() {
        viewModel.annotate(jobId: 42, value: .brokenTrunk)
        viewModel.annotate(jobId: 42, value: .flaky)

        XCTAssertEqual(viewModel.annotations[42], .flaky)
    }

    func testAnnotateJobWithNone() {
        viewModel.annotate(jobId: 42, value: .brokenTrunk)
        viewModel.annotate(jobId: 42, value: .none)

        // Use explicit type to avoid ambiguity with Optional.none
        let expected: FailedJobsViewModel.AnnotationValue = .none
        XCTAssertEqual(viewModel.annotations[42], expected)
    }

    func testAnnotateJobPersistsToLocalCache() {
        let defaults = UserDefaults(suiteName: "test_annotations_persist")!
        defaults.removePersistentDomain(forName: "test_annotations_persist")
        let cache = AnnotationCache(defaults: defaults)
        let vm = FailedJobsViewModel(apiClient: mockClient, annotationCache: cache)

        vm.annotate(jobId: 99, value: .flaky)

        let cached = cache.load()
        XCTAssertEqual(cached[99], "flaky")

        defaults.removePersistentDomain(forName: "test_annotations_persist")
    }

    func testAnnotateJobRemoveFromCacheOnNone() {
        let defaults = UserDefaults(suiteName: "test_annotations_remove")!
        defaults.removePersistentDomain(forName: "test_annotations_remove")
        let cache = AnnotationCache(defaults: defaults)
        let vm = FailedJobsViewModel(apiClient: mockClient, annotationCache: cache)

        vm.annotate(jobId: 55, value: .brokenTrunk)
        XCTAssertEqual(cache.load()[55], "broken_trunk")

        vm.annotate(jobId: 55, value: .none)
        XCTAssertNil(cache.load()[55])

        defaults.removePersistentDomain(forName: "test_annotations_remove")
    }

    func testAnnotateMultipleJobsPersistsAll() {
        let defaults = UserDefaults(suiteName: "test_annotations_multi")!
        defaults.removePersistentDomain(forName: "test_annotations_multi")
        let cache = AnnotationCache(defaults: defaults)
        let vm = FailedJobsViewModel(apiClient: mockClient, annotationCache: cache)

        vm.annotateMultiple(jobIds: [10, 20, 30], value: .infra)

        XCTAssertEqual(vm.annotations[10], .infra)
        XCTAssertEqual(vm.annotations[20], .infra)
        XCTAssertEqual(vm.annotations[30], .infra)

        let cached = cache.load()
        XCTAssertEqual(cached[10], "infra")
        XCTAssertEqual(cached[20], "infra")
        XCTAssertEqual(cached[30], "infra")

        defaults.removePersistentDomain(forName: "test_annotations_multi")
    }

    func testCachedAnnotationsLoadedOnInit() {
        let defaults = UserDefaults(suiteName: "test_annotations_init")!
        defaults.removePersistentDomain(forName: "test_annotations_init")
        let cache = AnnotationCache(defaults: defaults)

        // Pre-populate cache
        cache.save(jobId: 7, annotation: "broken_trunk")
        cache.save(jobId: 8, annotation: "flaky")

        let vm = FailedJobsViewModel(apiClient: mockClient, annotationCache: cache)

        XCTAssertEqual(vm.annotations[7], .brokenTrunk)
        XCTAssertEqual(vm.annotations[8], .flaky)

        defaults.removePersistentDomain(forName: "test_annotations_init")
    }

    // MARK: - isAuthenticated

    func testIsAuthenticatedDelegatesToAuthManager() {
        // AuthManager.shared starts unauthenticated
        XCTAssertEqual(viewModel.isAuthenticated, viewModel.authManager.isAuthenticated)
    }

    // MARK: - ViewState Equatable

    func testViewStateEquality() {
        XCTAssertEqual(FailedJobsViewModel.ViewState.idle, .idle)
        XCTAssertEqual(FailedJobsViewModel.ViewState.loading, .loading)
        XCTAssertEqual(FailedJobsViewModel.ViewState.loaded, .loaded)
        XCTAssertEqual(FailedJobsViewModel.ViewState.error("a"), .error("a"))
        XCTAssertNotEqual(FailedJobsViewModel.ViewState.error("a"), .error("b"))
        XCTAssertNotEqual(FailedJobsViewModel.ViewState.idle, .loading)
        XCTAssertNotEqual(FailedJobsViewModel.ViewState.loading, .loaded)
        XCTAssertNotEqual(FailedJobsViewModel.ViewState.loaded, .error("x"))
    }

    // MARK: - FailureType Properties

    func testFailureTypeDescriptions() {
        XCTAssertEqual(FailedJobsViewModel.FailureType.all.description, "All")
        XCTAssertEqual(FailedJobsViewModel.FailureType.brokenTrunk.description, "Broken Trunk")
        XCTAssertEqual(FailedJobsViewModel.FailureType.flaky.description, "Flaky")
        XCTAssertEqual(FailedJobsViewModel.FailureType.infra.description, "Infra")
        XCTAssertEqual(FailedJobsViewModel.FailureType.notAnnotated.description, "Not Annotated")
    }

    func testFailureTypeIcons() {
        // Verify each type has a non-empty icon
        for type in FailedJobsViewModel.FailureType.allCases {
            XCTAssertFalse(type.icon.isEmpty, "\(type) should have an icon")
        }
    }

    func testFailureTypeAllCasesCount() {
        XCTAssertEqual(FailedJobsViewModel.FailureType.allCases.count, 5)
    }

    // MARK: - AnnotationValue Properties

    func testAnnotationValueDisplayNames() {
        XCTAssertEqual(FailedJobsViewModel.AnnotationValue.brokenTrunk.displayName, "Broken Trunk")
        XCTAssertEqual(FailedJobsViewModel.AnnotationValue.flaky.displayName, "Flaky")
        XCTAssertEqual(FailedJobsViewModel.AnnotationValue.infra.displayName, "Infra")
        XCTAssertEqual(FailedJobsViewModel.AnnotationValue.none.displayName, "None")
    }

    func testAnnotationValueRawValues() {
        XCTAssertEqual(FailedJobsViewModel.AnnotationValue.brokenTrunk.rawValue, "broken_trunk")
        XCTAssertEqual(FailedJobsViewModel.AnnotationValue.flaky.rawValue, "flaky")
        XCTAssertEqual(FailedJobsViewModel.AnnotationValue.infra.rawValue, "infra")
        XCTAssertEqual(FailedJobsViewModel.AnnotationValue.none.rawValue, "")
    }

    func testAnnotationValueAllCasesCount() {
        XCTAssertEqual(FailedJobsViewModel.AnnotationValue.allCases.count, 4)
    }

    // MARK: - Static Configuration

    func testReposConfig() {
        XCTAssertFalse(FailedJobsViewModel.repos.isEmpty)
        XCTAssertTrue(FailedJobsViewModel.repos.contains { $0.name == "pytorch" })
        XCTAssertTrue(FailedJobsViewModel.repos.contains { $0.name == "vision" })
    }

    func testBranchesConfig() {
        XCTAssertFalse(FailedJobsViewModel.branches.isEmpty)
        XCTAssertTrue(FailedJobsViewModel.branches.contains("main"))
        XCTAssertTrue(FailedJobsViewModel.branches.contains("viable/strict"))
    }

    // MARK: - FailureGroup

    func testFailureGroupCount() {
        let jobs = [
            makeFailedJob(id: 1),
            makeFailedJob(id: 2),
        ]
        let group = FailedJobsViewModel.FailureGroup(
            jobs: jobs,
            failureType: .notAnnotated,
            representativeJob: jobs[0]
        )

        XCTAssertEqual(group.count, 2)
    }

    func testFailureGroupIdIsUnique() {
        let jobs = [makeFailedJob(id: 1)]
        let group1 = FailedJobsViewModel.FailureGroup(
            jobs: jobs, failureType: .notAnnotated, representativeJob: jobs[0]
        )
        let group2 = FailedJobsViewModel.FailureGroup(
            jobs: jobs, failureType: .notAnnotated, representativeJob: jobs[0]
        )

        XCTAssertNotEqual(group1.id, group2.id)
    }

    // MARK: - isLoading

    func testIsLoadingReflectsState() {
        viewModel.state = .loading
        XCTAssertTrue(viewModel.isLoading)

        viewModel.state = .loaded
        XCTAssertFalse(viewModel.isLoading)

        viewModel.state = .idle
        XCTAssertFalse(viewModel.isLoading)

        viewModel.state = .error("oops")
        XCTAssertFalse(viewModel.isLoading)
    }

    // MARK: - Complex Classification Scenarios

    func testClassifyFailureInfraKeywordCaseInsensitive() {
        // "Docker" uppercase should still match
        let job = makeFailedJob(
            id: 200,
            failureLines: ["DOCKER daemon crashed"]
        )
        XCTAssertEqual(viewModel.classifyFailure(job), .infra)
    }

    func testClassifyFailureNoJobIdNoAnnotation() {
        // Job with nil jobId cannot have an annotation
        let job = JobData(
            id: nil,
            name: "test-job",
            workflowName: nil,
            workflowId: nil,
            jobName: "test-job",
            conclusion: "failure",
            htmlUrl: nil,
            logUrl: nil,
            durationS: nil,
            failureLines: nil,
            failureCaptures: nil,
            failureContext: nil,
            runnerName: nil,
            runnerGroup: nil,
            status: nil,
            steps: nil,
            time: nil,
            unstable: nil,
            previousRun: nil
        )

        XCTAssertEqual(viewModel.classifyFailure(job), .notAnnotated)
    }

    // MARK: - Edge Cases for Grouped Failures

    func testGroupedFailuresWithNilJobNames() {
        let job = JobData(
            id: 1,
            name: nil,
            workflowName: nil,
            workflowId: nil,
            jobName: nil,
            conclusion: "failure",
            htmlUrl: nil,
            logUrl: nil,
            durationS: nil,
            failureLines: nil,
            failureCaptures: nil,
            failureContext: nil,
            runnerName: nil,
            runnerGroup: nil,
            status: nil,
            steps: nil,
            time: nil,
            unstable: nil,
            previousRun: nil
        )
        setJobsDirectly([job])

        let allGroups = viewModel.groupedFailures.values.flatMap { $0 }
        XCTAssertEqual(allGroups.count, 1)
        XCTAssertEqual(allGroups.first?.count, 1)
    }

    func testGroupedFailuresJobsSortedByTimeDescending() {
        let jobs = [
            makeFailedJob(id: 1, jobName: "test", time: "2025-01-20T08:00:00Z"),
            makeFailedJob(id: 2, jobName: "test", time: "2025-01-20T12:00:00Z"),
            makeFailedJob(id: 3, jobName: "test", time: "2025-01-20T10:00:00Z"),
        ]
        setJobsDirectly(jobs)

        let allGroups = viewModel.groupedFailures.values.flatMap { $0 }
        XCTAssertEqual(allGroups.count, 1)

        let group = allGroups[0]
        XCTAssertEqual(group.jobs.count, 3)
        // Most recent first
        XCTAssertEqual(group.jobs[0].time, "2025-01-20T12:00:00Z")
        XCTAssertEqual(group.jobs[1].time, "2025-01-20T10:00:00Z")
        XCTAssertEqual(group.jobs[2].time, "2025-01-20T08:00:00Z")
    }

    // MARK: - Combined Filter and Classification

    func testSearchAndTypeFilterCombined() {
        let jobs = [
            makeFailedJob(id: 1, jobName: "linux-test", unstable: true),
            makeFailedJob(id: 2, jobName: "linux-build"),
            makeFailedJob(id: 3, jobName: "windows-test", unstable: true),
        ]
        setJobsDirectly(jobs)

        // Filter by "linux" AND "flaky"
        viewModel.searchFilter = "linux"
        viewModel.filterType = .flaky

        XCTAssertEqual(viewModel.filteredJobs.count, 1)
        XCTAssertEqual(viewModel.filteredJobs.first?.jobName, "linux-test")
    }

    func testEmptySearchFilterReturnsAll() {
        let jobs = [
            makeFailedJob(id: 1, jobName: "a"),
            makeFailedJob(id: 2, jobName: "b"),
        ]
        setJobsDirectly(jobs)
        viewModel.searchFilter = ""

        XCTAssertEqual(viewModel.filteredJobs.count, 2)
    }

    // MARK: - API Response Parsing

    func testLoadDataServerAnnotationsOverrideLocalCache() async {
        let defaults = UserDefaults(suiteName: "test_annotations_merge")!
        defaults.removePersistentDomain(forName: "test_annotations_merge")
        let cache = AnnotationCache(defaults: defaults)

        // Pre-populate local cache with an annotation
        cache.save(jobId: 1, annotation: "flaky")

        let vm = FailedJobsViewModel(apiClient: mockClient, annotationCache: cache)

        // Verify local cache is loaded
        XCTAssertEqual(vm.annotations[1], .flaky)

        // Set up server response with a different annotation for the same job
        let jobs = [makeFailedJob(id: 1)]
        let json = makeResponseJSON(
            jobs: jobs,
            annotations: [
                "1": (annotation: "broken_trunk", jobID: 1),
            ]
        )

        let queryParams: [String: Any] = [
            "branch": "main",
            "repo": "pytorch/pytorch",
            "startTime": formatDate(vm.startDate),
            "stopTime": formatDate(vm.endDate),
        ]
        let endpoint = APIEndpoint.failedJobsWithAnnotations(
            repoOwner: "pytorch",
            repoName: "pytorch",
            queryParams: queryParams
        )
        mockClient.setResponse(json, for: endpoint.path)

        await vm.loadData()

        // Server annotation should win
        XCTAssertEqual(vm.annotations[1], .brokenTrunk)

        defaults.removePersistentDomain(forName: "test_annotations_merge")
    }

    func testLoadDataDecodesAnnotationsFromResponse() async {
        let jobs = [makeFailedJob(id: 1), makeFailedJob(id: 2)]
        let json = makeResponseJSON(
            jobs: jobs,
            annotations: [
                "1": (annotation: "broken_trunk", jobID: 1),
                "2": (annotation: "flaky", jobID: 2),
            ]
        )

        // Find the actual endpoint path the view model will call
        let queryParams: [String: Any] = [
            "branch": "main",
            "repo": "pytorch/pytorch",
            "startTime": formatDate(viewModel.startDate),
            "stopTime": formatDate(viewModel.endDate),
        ]
        let endpoint = APIEndpoint.failedJobsWithAnnotations(
            repoOwner: "pytorch",
            repoName: "pytorch",
            queryParams: queryParams
        )
        mockClient.setResponse(json, for: endpoint.path)

        await viewModel.loadData()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(viewModel.jobs.count, 2)
        XCTAssertEqual(viewModel.annotations[1], .brokenTrunk)
        XCTAssertEqual(viewModel.annotations[2], .flaky)
    }

    func testLoadDataErrorSetsErrorState() async {
        // No response registered, MockAPIClient throws .notFound
        await viewModel.loadData()

        if case .error = viewModel.state {
            // expected
        } else {
            XCTFail("Expected error state but got \(viewModel.state)")
        }
    }

    func testRefreshCallsLoadData() async {
        // Register an empty response
        let queryParams: [String: Any] = [
            "branch": "main",
            "repo": "pytorch/pytorch",
            "startTime": formatDate(viewModel.startDate),
            "stopTime": formatDate(viewModel.endDate),
        ]
        let endpoint = APIEndpoint.failedJobsWithAnnotations(
            repoOwner: "pytorch",
            repoName: "pytorch",
            queryParams: queryParams
        )
        let json = makeResponseJSON(jobs: [])
        mockClient.setResponse(json, for: endpoint.path)

        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertEqual(mockClient.callCount, 1)
    }

    // MARK: - Date Format Helper

    private func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS"
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }
}
