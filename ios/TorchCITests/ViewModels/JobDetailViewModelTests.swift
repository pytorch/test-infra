import XCTest
@testable import TorchCI

@MainActor
final class JobDetailViewModelTests: XCTestCase {

    // MARK: - Helpers

    /// Creates a `JobData` with sensible defaults. Override only the fields you need.
    private func makeJob(
        id: Int? = 1,
        name: String? = "pull / linux-build",
        workflowName: String? = "pull",
        workflowId: Int? = 5001,
        jobName: String? = "linux-build",
        conclusion: String? = "success",
        htmlUrl: String? = "https://github.com/pytorch/pytorch/actions/runs/1",
        logUrl: String? = "https://ossci-raw-job-status.s3.amazonaws.com/log/1",
        durationS: Int? = 1920,
        queueTimeS: Int? = nil,
        failureLines: [String]? = nil,
        failureCaptures: [String]? = nil,
        failureContext: String? = nil,
        runnerName: String? = nil,
        runnerGroup: String? = nil,
        status: String? = "completed",
        steps: [JobStep]? = nil,
        unstable: Bool? = false,
        previousRun: PreviousRun? = nil,
        runAttempt: Int? = nil
    ) -> JobData {
        JobData(
            id: id,
            name: name,
            workflowName: workflowName,
            workflowId: workflowId,
            jobName: jobName,
            conclusion: conclusion,
            htmlUrl: htmlUrl,
            logUrl: logUrl,
            durationS: durationS,
            queueTimeS: queueTimeS,
            failureLines: failureLines,
            failureCaptures: failureCaptures,
            failureContext: failureContext,
            runnerName: runnerName,
            runnerGroup: runnerGroup,
            status: status,
            steps: steps,
            time: nil,
            unstable: unstable,
            previousRun: previousRun,
            runAttempt: runAttempt
        )
    }

    private func makeViewModel(job: JobData? = nil) -> JobDetailViewModel {
        JobDetailViewModel(job: job ?? makeJob())
    }

    // MARK: - Display Name

    func testDisplayNamePrefersJobName() {
        let vm = makeViewModel(job: makeJob(name: "full/name", jobName: "short-name"))
        XCTAssertEqual(vm.displayName, "short-name")
    }

    func testDisplayNameFallsBackToName() {
        let vm = makeViewModel(job: makeJob(name: "full/name", jobName: nil))
        XCTAssertEqual(vm.displayName, "full/name")
    }

    func testDisplayNameFallsBackToUnknown() {
        let vm = makeViewModel(job: makeJob(name: nil, jobName: nil))
        XCTAssertEqual(vm.displayName, "Unknown Job")
    }

    // MARK: - Workflow Display Name

    func testWorkflowDisplayName() {
        let vm = makeViewModel(job: makeJob(workflowName: "trunk"))
        XCTAssertEqual(vm.workflowDisplayName, "trunk")
    }

    func testWorkflowDisplayNameFallback() {
        let vm = makeViewModel(job: makeJob(workflowName: nil))
        XCTAssertEqual(vm.workflowDisplayName, "Unknown Workflow")
    }

    // MARK: - Conclusion Display

    func testConclusionDisplayCapitalizes() {
        let vm = makeViewModel(job: makeJob(conclusion: "failure"))
        XCTAssertEqual(vm.conclusionDisplay, "Failure")
    }

    func testConclusionDisplayFallsBackToStatus() {
        let vm = makeViewModel(job: makeJob(conclusion: nil, status: "queued"))
        XCTAssertEqual(vm.conclusionDisplay, "Queued")
    }

    func testConclusionDisplayUnknownWhenBothNil() {
        let vm = makeViewModel(job: makeJob(conclusion: nil, status: nil))
        XCTAssertEqual(vm.conclusionDisplay, "Unknown")
    }

    // MARK: - Job ID Display

    func testJobIdDisplay() {
        let vm = makeViewModel(job: makeJob(id: 42))
        XCTAssertEqual(vm.jobIdDisplay, "Job #42")
    }

    func testJobIdDisplayNil() {
        let vm = makeViewModel(job: makeJob(id: nil))
        XCTAssertNil(vm.jobIdDisplay)
    }

    // MARK: - Workflow ID Display

    func testWorkflowIdDisplay() {
        let vm = makeViewModel(job: makeJob(workflowId: 100))
        XCTAssertEqual(vm.workflowIdDisplay, "Workflow #100")
    }

    func testWorkflowIdDisplayNil() {
        let vm = makeViewModel(job: makeJob(workflowId: nil))
        XCTAssertNil(vm.workflowIdDisplay)
    }

    // MARK: - Run Attempt Display

    func testRunAttemptDisplay() {
        let vm = makeViewModel(job: makeJob(runAttempt: 3))
        XCTAssertEqual(vm.runAttemptDisplay, "Attempt 3")
    }

    func testRunAttemptDisplayNil() {
        let vm = makeViewModel(job: makeJob(runAttempt: nil))
        XCTAssertNil(vm.runAttemptDisplay)
    }

    // MARK: - Queue Time Formatted

    func testQueueTimeFormattedMinutesAndSeconds() {
        let vm = makeViewModel(job: makeJob(queueTimeS: 125))
        XCTAssertEqual(vm.queueTimeFormatted, "2m 5s")
    }

    func testQueueTimeFormattedSecondsOnly() {
        let vm = makeViewModel(job: makeJob(queueTimeS: 45))
        XCTAssertEqual(vm.queueTimeFormatted, "45s")
    }

    func testQueueTimeFormattedNil() {
        let vm = makeViewModel(job: makeJob(queueTimeS: nil))
        XCTAssertNil(vm.queueTimeFormatted)
    }

    func testQueueTimeFormattedZero() {
        let vm = makeViewModel(job: makeJob(queueTimeS: 0))
        XCTAssertEqual(vm.queueTimeFormatted, "0s")
    }

    // MARK: - Has Failure Info

    func testHasFailureInfoWithLines() {
        let vm = makeViewModel(job: makeJob(failureLines: ["FAIL: test_foo"]))
        XCTAssertTrue(vm.hasFailureInfo)
    }

    func testHasFailureInfoWithCaptures() {
        let vm = makeViewModel(job: makeJob(failureCaptures: ["RuntimeError"]))
        XCTAssertTrue(vm.hasFailureInfo)
    }

    func testHasFailureInfoWithContext() {
        let vm = makeViewModel(job: makeJob(failureContext: "exit code 1"))
        XCTAssertTrue(vm.hasFailureInfo)
    }

    func testHasFailureInfoFalseWhenEmpty() {
        let vm = makeViewModel(job: makeJob(
            failureLines: [],
            failureCaptures: [],
            failureContext: nil
        ))
        XCTAssertFalse(vm.hasFailureInfo)
    }

    func testHasFailureInfoFalseWhenNil() {
        let vm = makeViewModel(job: makeJob(
            failureLines: nil,
            failureCaptures: nil,
            failureContext: nil
        ))
        XCTAssertFalse(vm.hasFailureInfo)
    }

    func testHasFailureInfoFalseWithEmptyContext() {
        let vm = makeViewModel(job: makeJob(failureContext: ""))
        XCTAssertFalse(vm.hasFailureInfo)
    }

    // MARK: - Has Steps

    func testHasStepsTrue() {
        let steps = [JobStep(name: "Build", conclusion: "success", number: 1, startedAt: nil, completedAt: nil)]
        let vm = makeViewModel(job: makeJob(steps: steps))
        XCTAssertTrue(vm.hasSteps)
    }

    func testHasStepsFalseWhenEmpty() {
        let vm = makeViewModel(job: makeJob(steps: []))
        XCTAssertFalse(vm.hasSteps)
    }

    func testHasStepsFalseWhenNil() {
        let vm = makeViewModel(job: makeJob(steps: nil))
        XCTAssertFalse(vm.hasSteps)
    }

    // MARK: - Has Runner Info

    func testHasRunnerInfoWithName() {
        let vm = makeViewModel(job: makeJob(runnerName: "i-0abc"))
        XCTAssertTrue(vm.hasRunnerInfo)
    }

    func testHasRunnerInfoWithGroup() {
        let vm = makeViewModel(job: makeJob(runnerGroup: "linux.2xlarge"))
        XCTAssertTrue(vm.hasRunnerInfo)
    }

    func testHasRunnerInfoFalse() {
        let vm = makeViewModel(job: makeJob(runnerName: nil, runnerGroup: nil))
        XCTAssertFalse(vm.hasRunnerInfo)
    }

    // MARK: - Has Previous Run

    func testHasPreviousRunTrue() {
        let prevRun = PreviousRun(conclusion: "success", htmlUrl: "https://example.com")
        let vm = makeViewModel(job: makeJob(previousRun: prevRun))
        XCTAssertTrue(vm.hasPreviousRun)
    }

    func testHasPreviousRunFalse() {
        let vm = makeViewModel(job: makeJob(previousRun: nil))
        XCTAssertFalse(vm.hasPreviousRun)
    }

    // MARK: - GitHub / Logs URLs

    func testGithubURL() {
        let vm = makeViewModel(job: makeJob(htmlUrl: "https://github.com/foo"))
        XCTAssertEqual(vm.githubURL, "https://github.com/foo")
    }

    func testGithubURLNil() {
        let vm = makeViewModel(job: makeJob(htmlUrl: nil))
        XCTAssertNil(vm.githubURL)
    }

    func testLogsURL() {
        let vm = makeViewModel(job: makeJob(logUrl: "https://logs.example.com"))
        XCTAssertEqual(vm.logsURL, "https://logs.example.com")
    }

    func testLogsURLNil() {
        let vm = makeViewModel(job: makeJob(logUrl: nil))
        XCTAssertNil(vm.logsURL)
    }

    // MARK: - Has Any Metrics

    func testHasAnyMetricsWithDuration() {
        let vm = makeViewModel(job: makeJob(durationS: 100, queueTimeS: nil))
        XCTAssertTrue(vm.hasAnyMetrics)
    }

    func testHasAnyMetricsWithQueueTime() {
        let vm = makeViewModel(job: makeJob(durationS: nil, queueTimeS: 50))
        XCTAssertTrue(vm.hasAnyMetrics)
    }

    func testHasAnyMetricsFalse() {
        let vm = makeViewModel(job: makeJob(durationS: nil, queueTimeS: nil))
        XCTAssertFalse(vm.hasAnyMetrics)
    }

    // MARK: - Sorted Steps

    func testSortedStepsOrdersByNumber() {
        let steps = [
            JobStep(name: "Third", conclusion: "success", number: 3, startedAt: nil, completedAt: nil),
            JobStep(name: "First", conclusion: "success", number: 1, startedAt: nil, completedAt: nil),
            JobStep(name: "Second", conclusion: "success", number: 2, startedAt: nil, completedAt: nil),
        ]
        let vm = makeViewModel(job: makeJob(steps: steps))
        XCTAssertEqual(vm.sortedSteps.map(\.name), ["First", "Second", "Third"])
    }

    func testSortedStepsEmptyWhenNil() {
        let vm = makeViewModel(job: makeJob(steps: nil))
        XCTAssertTrue(vm.sortedSteps.isEmpty)
    }

    // MARK: - Steps Progress

    func testStepsProgressCountsCompleted() {
        let steps = [
            JobStep(name: "A", conclusion: "success", number: 1, startedAt: nil, completedAt: nil),
            JobStep(name: "B", conclusion: "failure", number: 2, startedAt: nil, completedAt: nil),
            JobStep(name: "C", conclusion: nil, number: 3, startedAt: nil, completedAt: nil),
            JobStep(name: "D", conclusion: "in_progress", number: 4, startedAt: nil, completedAt: nil),
        ]
        let vm = makeViewModel(job: makeJob(steps: steps))
        let progress = vm.stepsProgress
        XCTAssertEqual(progress.completed, 2) // success + failure
        XCTAssertEqual(progress.total, 4)
    }

    func testStepsProgressZeroWhenNil() {
        let vm = makeViewModel(job: makeJob(steps: nil))
        let progress = vm.stepsProgress
        XCTAssertEqual(progress.completed, 0)
        XCTAssertEqual(progress.total, 0)
    }

    // MARK: - Step Counts

    func testStepCountsBreakdown() {
        let steps = [
            JobStep(name: "A", conclusion: "success", number: 1, startedAt: nil, completedAt: nil),
            JobStep(name: "B", conclusion: "success", number: 2, startedAt: nil, completedAt: nil),
            JobStep(name: "C", conclusion: "failure", number: 3, startedAt: nil, completedAt: nil),
            JobStep(name: "D", conclusion: "skipped", number: 4, startedAt: nil, completedAt: nil),
            JobStep(name: "E", conclusion: nil, number: 5, startedAt: nil, completedAt: nil),
            JobStep(name: "F", conclusion: "in_progress", number: 6, startedAt: nil, completedAt: nil),
        ]
        let vm = makeViewModel(job: makeJob(steps: steps))
        let counts = vm.stepCounts
        XCTAssertEqual(counts.success, 2)
        XCTAssertEqual(counts.failure, 1)
        XCTAssertEqual(counts.skipped, 1)
        XCTAssertEqual(counts.pending, 2) // nil + in_progress
    }

    func testStepCountsAllZerosWhenNoSteps() {
        let vm = makeViewModel(job: makeJob(steps: nil))
        let counts = vm.stepCounts
        XCTAssertEqual(counts.success, 0)
        XCTAssertEqual(counts.failure, 0)
        XCTAssertEqual(counts.skipped, 0)
        XCTAssertEqual(counts.pending, 0)
    }

    func testStepCountsQueuedIsPending() {
        let steps = [
            JobStep(name: "A", conclusion: "queued", number: 1, startedAt: nil, completedAt: nil),
        ]
        let vm = makeViewModel(job: makeJob(steps: steps))
        XCTAssertEqual(vm.stepCounts.pending, 1)
    }

    // MARK: - Failed Step Name

    func testFailedStepNameReturnsFirstFailedStep() {
        let steps = [
            JobStep(name: "Build", conclusion: "success", number: 1, startedAt: nil, completedAt: nil),
            JobStep(name: "Run tests", conclusion: "failure", number: 2, startedAt: nil, completedAt: nil),
            JobStep(name: "Upload", conclusion: "failure", number: 3, startedAt: nil, completedAt: nil),
        ]
        let vm = makeViewModel(job: makeJob(steps: steps))
        XCTAssertEqual(vm.failedStepName, "Run tests")
    }

    func testFailedStepNameNilWhenNoFailures() {
        let steps = [
            JobStep(name: "Build", conclusion: "success", number: 1, startedAt: nil, completedAt: nil),
        ]
        let vm = makeViewModel(job: makeJob(steps: steps))
        XCTAssertNil(vm.failedStepName)
    }

    func testFailedStepNameNilWhenNoSteps() {
        let vm = makeViewModel(job: makeJob(steps: nil))
        XCTAssertNil(vm.failedStepName)
    }

    // MARK: - Steps Progress Fraction

    func testStepsProgressFractionHalfCompleted() {
        let steps = [
            JobStep(name: "A", conclusion: "success", number: 1, startedAt: nil, completedAt: nil),
            JobStep(name: "B", conclusion: nil, number: 2, startedAt: nil, completedAt: nil),
        ]
        let vm = makeViewModel(job: makeJob(steps: steps))
        XCTAssertEqual(vm.stepsProgressFraction, 0.5, accuracy: 0.01)
    }

    func testStepsProgressFractionAllCompleted() {
        let steps = [
            JobStep(name: "A", conclusion: "success", number: 1, startedAt: nil, completedAt: nil),
            JobStep(name: "B", conclusion: "failure", number: 2, startedAt: nil, completedAt: nil),
        ]
        let vm = makeViewModel(job: makeJob(steps: steps))
        XCTAssertEqual(vm.stepsProgressFraction, 1.0, accuracy: 0.01)
    }

    func testStepsProgressFractionZeroWhenNoSteps() {
        let vm = makeViewModel(job: makeJob(steps: nil))
        XCTAssertEqual(vm.stepsProgressFraction, 0.0, accuracy: 0.01)
    }

    // MARK: - Status Summary Text

    func testStatusSummaryTextSuccessWithDuration() {
        let vm = makeViewModel(job: makeJob(conclusion: "success", durationS: 330))
        XCTAssertEqual(vm.statusSummaryText, "Completed successfully in 5m 30s")
    }

    func testStatusSummaryTextSuccessWithoutDuration() {
        let vm = makeViewModel(job: makeJob(conclusion: "success", durationS: nil))
        XCTAssertEqual(vm.statusSummaryText, "Completed successfully")
    }

    func testStatusSummaryTextFailureWithStep() {
        let steps = [
            JobStep(name: "Build", conclusion: "success", number: 1, startedAt: nil, completedAt: nil),
            JobStep(name: "Run tests", conclusion: "failure", number: 2, startedAt: nil, completedAt: nil),
        ]
        let vm = makeViewModel(job: makeJob(conclusion: "failure", steps: steps))
        XCTAssertEqual(vm.statusSummaryText, "Failed at: Run tests")
    }

    func testStatusSummaryTextFailureWithoutStep() {
        let vm = makeViewModel(job: makeJob(conclusion: "failure", steps: nil))
        XCTAssertEqual(vm.statusSummaryText, "Failed")
    }

    func testStatusSummaryTextCancelled() {
        let vm = makeViewModel(job: makeJob(conclusion: "cancelled"))
        XCTAssertEqual(vm.statusSummaryText, "Cancelled")
    }

    func testStatusSummaryTextCanceled() {
        let vm = makeViewModel(job: makeJob(conclusion: "canceled"))
        XCTAssertEqual(vm.statusSummaryText, "Cancelled")
    }

    func testStatusSummaryTextSkipped() {
        let vm = makeViewModel(job: makeJob(conclusion: "skipped"))
        XCTAssertEqual(vm.statusSummaryText, "Skipped")
    }

    func testStatusSummaryTextInProgressWithSteps() {
        let steps = [
            JobStep(name: "A", conclusion: "success", number: 1, startedAt: nil, completedAt: nil),
            JobStep(name: "B", conclusion: nil, number: 2, startedAt: nil, completedAt: nil),
            JobStep(name: "C", conclusion: nil, number: 3, startedAt: nil, completedAt: nil),
        ]
        let vm = makeViewModel(job: makeJob(conclusion: nil, status: "in_progress", steps: steps))
        XCTAssertEqual(vm.statusSummaryText, "Running (1/3 steps)")
    }

    func testStatusSummaryTextQueuedWithoutSteps() {
        let vm = makeViewModel(job: makeJob(conclusion: nil, status: "queued", steps: nil))
        XCTAssertEqual(vm.statusSummaryText, "Running")
    }

    func testStatusSummaryTextUnknown() {
        let vm = makeViewModel(job: makeJob(conclusion: nil, status: nil))
        XCTAssertEqual(vm.statusSummaryText, "Unknown")
    }

    func testStatusSummaryTextFallsBackToStatusCapitalized() {
        let vm = makeViewModel(job: makeJob(conclusion: nil, status: "completed"))
        XCTAssertEqual(vm.statusSummaryText, "Completed")
    }

    // MARK: - Total Failure Line Count

    func testTotalFailureLineCount() {
        let vm = makeViewModel(job: makeJob(failureLines: ["a", "b", "c"]))
        XCTAssertEqual(vm.totalFailureLineCount, 3)
    }

    func testTotalFailureLineCountZeroWhenNil() {
        let vm = makeViewModel(job: makeJob(failureLines: nil))
        XCTAssertEqual(vm.totalFailureLineCount, 0)
    }

    func testTotalFailureLineCountZeroWhenEmpty() {
        let vm = makeViewModel(job: makeJob(failureLines: []))
        XCTAssertEqual(vm.totalFailureLineCount, 0)
    }

    // MARK: - Failure Summary

    func testFailureSummaryReturnsFirstCapture() {
        let vm = makeViewModel(job: makeJob(failureCaptures: ["RuntimeError: foo", "AssertionError: bar"]))
        XCTAssertEqual(vm.failureSummary, "RuntimeError: foo")
    }

    func testFailureSummaryNilWhenEmpty() {
        let vm = makeViewModel(job: makeJob(failureCaptures: []))
        XCTAssertNil(vm.failureSummary)
    }

    func testFailureSummaryNilWhenNil() {
        let vm = makeViewModel(job: makeJob(failureCaptures: nil))
        XCTAssertNil(vm.failureSummary)
    }

    // MARK: - Initial Expansion State (Failure Job)

    func testFailureJobExpandsFailureSections() {
        let vm = makeViewModel(job: makeJob(
            conclusion: "failure",
            failureLines: ["FAIL"]
        ))
        XCTAssertTrue(vm.isFailureLinesExpanded)
        XCTAssertTrue(vm.isFailureCapturesExpanded)
        XCTAssertFalse(vm.isStepsExpanded)
    }

    // MARK: - Initial Expansion State (Success Job)

    func testSuccessJobExpandsStepsNotFailure() {
        let vm = makeViewModel(job: makeJob(conclusion: "success"))
        XCTAssertFalse(vm.isFailureLinesExpanded)
        XCTAssertFalse(vm.isFailureCapturesExpanded)
        XCTAssertTrue(vm.isStepsExpanded)
    }

    // MARK: - Initial Expansion State (Pending Job)

    func testPendingJobExpandsSteps() {
        let vm = makeViewModel(job: makeJob(conclusion: nil))
        XCTAssertTrue(vm.isStepsExpanded)
    }

    // MARK: - Copy Link

    func testCopyLinkSetsCopiedFlag() {
        let vm = makeViewModel(job: makeJob(htmlUrl: "https://example.com"))
        XCTAssertFalse(vm.copiedLink)

        vm.copyLink()

        XCTAssertTrue(vm.copiedLink)
    }

    func testCopyLinkNoOpWhenNoUrl() {
        let vm = makeViewModel(job: makeJob(htmlUrl: nil))
        vm.copyLink()
        XCTAssertFalse(vm.copiedLink)
    }

    // MARK: - Copy Failure Summary

    func testCopyFailureSummarySetsCopiedFlag() {
        let vm = makeViewModel(job: makeJob(conclusion: "failure", failureCaptures: ["Error: test"]))
        XCTAssertFalse(vm.copiedFailure)

        vm.copyFailureSummary()

        XCTAssertTrue(vm.copiedFailure)
    }

    func testCopyFailureSummaryIncludesJobName() {
        let vm = makeViewModel(job: makeJob(jobName: "linux-build", conclusion: "failure"))
        vm.copyFailureSummary()

        let copied = UIPasteboard.general.string ?? ""
        XCTAssertTrue(copied.contains("Job: linux-build"))
    }

    func testCopyFailureSummaryIncludesConclusion() {
        let vm = makeViewModel(job: makeJob(conclusion: "failure"))
        vm.copyFailureSummary()

        let copied = UIPasteboard.general.string ?? ""
        XCTAssertTrue(copied.contains("Status: failure"))
    }

    func testCopyFailureSummaryIncludesUrl() {
        let vm = makeViewModel(job: makeJob(htmlUrl: "https://github.com/test"))
        vm.copyFailureSummary()

        let copied = UIPasteboard.general.string ?? ""
        XCTAssertTrue(copied.contains("Link: https://github.com/test"))
    }

    func testCopyFailureSummaryIncludesCaptures() {
        let vm = makeViewModel(job: makeJob(
            failureCaptures: ["RuntimeError: boom", "AssertionError: nope"]
        ))
        vm.copyFailureSummary()

        let copied = UIPasteboard.general.string ?? ""
        XCTAssertTrue(copied.contains("Failures:"))
        XCTAssertTrue(copied.contains("  - RuntimeError: boom"))
        XCTAssertTrue(copied.contains("  - AssertionError: nope"))
    }

    func testCopyFailureSummaryIncludesFailureLines() {
        let vm = makeViewModel(job: makeJob(
            failureLines: ["FAIL: test_foo", "Expected True got False"],
            failureCaptures: nil
        ))
        vm.copyFailureSummary()

        let copied = UIPasteboard.general.string ?? ""
        XCTAssertTrue(copied.contains("Failure lines:"))
        XCTAssertTrue(copied.contains("  FAIL: test_foo"))
    }

    func testCopyFailureSummaryTruncatesLongFailureLines() {
        let lines = (0..<15).map { "Line \($0)" }
        let vm = makeViewModel(job: makeJob(
            failureLines: lines,
            failureCaptures: nil
        ))
        vm.copyFailureSummary()

        let copied = UIPasteboard.general.string ?? ""
        XCTAssertTrue(copied.contains("... (5 more lines)"))
        // Should only include first 10 lines
        XCTAssertTrue(copied.contains("Line 9"))
        XCTAssertFalse(copied.contains("  Line 10"))
    }

    func testCopyFailureSummaryPrefersCaptures() {
        let vm = makeViewModel(job: makeJob(
            failureLines: ["Should not appear"],
            failureCaptures: ["RuntimeError"]
        ))
        vm.copyFailureSummary()

        let copied = UIPasteboard.general.string ?? ""
        XCTAssertTrue(copied.contains("Failures:"))
        XCTAssertTrue(copied.contains("RuntimeError"))
        XCTAssertFalse(copied.contains("Should not appear"))
    }

    func testCopyFailureSummaryNoFailureInfoStillCopies() {
        let vm = makeViewModel(job: makeJob(
            conclusion: "success",
            failureLines: nil,
            failureCaptures: nil
        ))
        vm.copyFailureSummary()

        let copied = UIPasteboard.general.string ?? ""
        XCTAssertTrue(copied.contains("Job:"))
        XCTAssertFalse(copied.contains("Failures:"))
        XCTAssertFalse(copied.contains("Failure lines:"))
    }
}
