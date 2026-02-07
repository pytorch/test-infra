import XCTest
@testable import TorchCI

final class CompilerBenchmarkTests: XCTestCase {

    // MARK: - CompilerBenchmarkRawRow Decoding

    func testRawRowDecoding() {
        let json = """
        {
            "workflow_id": 12345,
            "job_id": 67890,
            "backend": "inductor",
            "suite": "torchbench",
            "model": "BERT_pytorch",
            "metric": "speedup",
            "value": 1.45,
            "extra_info": {"benchmark_values": "[\\"pass\\"]"},
            "output": "some_output_string",
            "granularity_bucket": "2025-01-15T10:00:00.000"
        }
        """

        let row: CompilerBenchmarkRawRow = MockData.decode(json)

        XCTAssertEqual(row.workflowId, 12345)
        XCTAssertEqual(row.jobId, 67890)
        XCTAssertEqual(row.backend, "inductor")
        XCTAssertEqual(row.suite, "torchbench")
        XCTAssertEqual(row.model, "BERT_pytorch")
        XCTAssertEqual(row.metric, "speedup")
        XCTAssertEqual(row.value, 1.45, accuracy: 0.001)
        XCTAssertEqual(row.extraInfo?["benchmark_values"], "[\"pass\"]")
        XCTAssertEqual(row.output, "some_output_string")
        XCTAssertEqual(row.granularityBucket, "2025-01-15T10:00:00.000")
    }

    func testRawRowDecodingNullOptionals() {
        let json = """
        {
            "workflow_id": 100,
            "backend": "inductor",
            "suite": "huggingface",
            "model": "resnet50",
            "metric": "accuracy",
            "value": 0,
            "granularity_bucket": "2025-01-15T10:00:00.000"
        }
        """

        let row: CompilerBenchmarkRawRow = MockData.decode(json)

        XCTAssertNil(row.jobId)
        XCTAssertNil(row.extraInfo)
        XCTAssertNil(row.output)
    }

    // MARK: - convertToPerformanceRecords

    func testConvertPivotsMetricsCorrectly() {
        let rawRows: [CompilerBenchmarkRawRow] = MockData.decode("""
        [
            {"workflow_id": 1, "backend": "inductor", "suite": "torchbench", "model": "bert", "metric": "speedup", "value": 1.45, "granularity_bucket": "2025-01-15T10:00:00.000"},
            {"workflow_id": 1, "backend": "inductor", "suite": "torchbench", "model": "bert", "metric": "compilation_latency", "value": 12.5, "granularity_bucket": "2025-01-15T10:00:00.000"},
            {"workflow_id": 1, "backend": "inductor", "suite": "torchbench", "model": "bert", "metric": "compression_ratio", "value": 0.95, "granularity_bucket": "2025-01-15T10:00:00.000"},
            {"workflow_id": 1, "backend": "inductor", "suite": "torchbench", "model": "bert", "metric": "dynamo_peak_mem", "value": 1073741824, "granularity_bucket": "2025-01-15T10:00:00.000"},
            {"workflow_id": 1, "backend": "inductor", "suite": "torchbench", "model": "bert", "metric": "accuracy", "value": 0, "extra_info": {"benchmark_values": "[\\"pass\\"]"}, "granularity_bucket": "2025-01-15T10:00:00.000"}
        ]
        """)

        let records = CompilerBenchmarkView.convertToPerformanceRecords(rawRows)

        XCTAssertEqual(records.count, 1)
        let record = records[0]
        XCTAssertEqual(record.name, "bert")
        XCTAssertEqual(record.compiler, "inductor")
        XCTAssertEqual(record.suite, "torchbench")
        XCTAssertEqual(record.speedup!, 1.45, accuracy: 0.001)
        XCTAssertEqual(record.accuracy, "pass")
        XCTAssertEqual(record.compilationLatency!, 12.5, accuracy: 0.001)
        XCTAssertEqual(record.compressionRatio!, 0.95, accuracy: 0.001)
        XCTAssertEqual(record.peakMemory!, 1_073_741_824, accuracy: 1)
    }

    func testConvertGroupsByWorkflowModelBackend() {
        let rawRows: [CompilerBenchmarkRawRow] = MockData.decode("""
        [
            {"workflow_id": 1, "backend": "inductor", "suite": "torchbench", "model": "bert", "metric": "speedup", "value": 1.2, "granularity_bucket": "2025-01-15T10:00:00.000"},
            {"workflow_id": 1, "backend": "inductor_no_cudagraphs", "suite": "torchbench", "model": "bert", "metric": "speedup", "value": 0.9, "granularity_bucket": "2025-01-15T10:00:00.000"},
            {"workflow_id": 1, "backend": "inductor", "suite": "huggingface", "model": "resnet", "metric": "speedup", "value": 1.5, "granularity_bucket": "2025-01-15T10:00:00.000"}
        ]
        """)

        let records = CompilerBenchmarkView.convertToPerformanceRecords(rawRows)

        XCTAssertEqual(records.count, 3)
        let names = Set(records.map { "\($0.name)-\($0.compiler)" })
        XCTAssertTrue(names.contains("bert-inductor"))
        XCTAssertTrue(names.contains("bert-inductor_no_cudagraphs"))
        XCTAssertTrue(names.contains("resnet-inductor"))
    }

    func testConvertKeepsLatestWorkflow() {
        let rawRows: [CompilerBenchmarkRawRow] = MockData.decode("""
        [
            {"workflow_id": 100, "backend": "inductor", "suite": "torchbench", "model": "bert", "metric": "speedup", "value": 1.2, "granularity_bucket": "2025-01-15T08:00:00.000"},
            {"workflow_id": 200, "backend": "inductor", "suite": "torchbench", "model": "bert", "metric": "speedup", "value": 1.5, "granularity_bucket": "2025-01-15T10:00:00.000"}
        ]
        """)

        let records = CompilerBenchmarkView.convertToPerformanceRecords(rawRows)

        XCTAssertEqual(records.count, 1)
        // Should keep workflow 200 (higher = more recent)
        XCTAssertEqual(records[0].speedup!, 1.5, accuracy: 0.001)
    }

    func testConvertEmptyRows() {
        let records = CompilerBenchmarkView.convertToPerformanceRecords([])
        XCTAssertEqual(records.count, 0)
    }

    func testConvertMissingAccuracyDefaultsToEmpty() {
        let rawRows: [CompilerBenchmarkRawRow] = MockData.decode("""
        [
            {"workflow_id": 1, "backend": "inductor", "suite": "torchbench", "model": "bert", "metric": "speedup", "value": 1.2, "granularity_bucket": "2025-01-15T10:00:00.000"}
        ]
        """)

        let records = CompilerBenchmarkView.convertToPerformanceRecords(rawRows)

        XCTAssertEqual(records.count, 1)
        XCTAssertEqual(records[0].accuracy, "")
    }

    // MARK: - CompilerPerformanceRecord

    func testCompilerPerformanceRecordHasUniqueId() {
        let record1 = makeRecord()
        let record2 = makeRecord()

        // Each instance should get a unique UUID
        XCTAssertNotEqual(record1.id, record2.id)
    }

    // MARK: - displayNameForCompiler

    func testDisplayNameForInductor() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        XCTAssertEqual(view.displayNameForCompiler("inductor"), "cudagraphs")
    }

    func testDisplayNameForInductorWithCudagraphs() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        XCTAssertEqual(view.displayNameForCompiler("inductor_with_cudagraphs"), "cudagraphs")
    }

    func testDisplayNameForInductorDynamic() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        XCTAssertEqual(view.displayNameForCompiler("inductor_dynamic"), "cudagraphs_dynamic")
    }

    func testDisplayNameForInductorNoCudagraphs() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        XCTAssertEqual(view.displayNameForCompiler("inductor_no_cudagraphs"), "default")
    }

    func testDisplayNameForInductorCppWrapper() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        XCTAssertEqual(view.displayNameForCompiler("inductor_cpp_wrapper"), "cpp_wrapper")
    }

    func testDisplayNameForInductorAotInductor() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        XCTAssertEqual(view.displayNameForCompiler("inductor_aot_inductor"), "aot_inductor")
    }

    func testDisplayNameForInductorEager() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        XCTAssertEqual(view.displayNameForCompiler("inductor_eager"), "eager")
    }

    func testDisplayNameForUnknownCompilerPassesThrough() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        XCTAssertEqual(view.displayNameForCompiler("custom_compiler"), "custom_compiler")
    }

    // MARK: - formatDisplayName

    func testFormatDisplayNameUnderscoreReplacement() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        XCTAssertEqual(view.formatDisplayName("cuda_h100"), "Cuda H100")
    }

    func testFormatDisplayNameCapitalization() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        XCTAssertEqual(view.formatDisplayName("training"), "Training")
    }

    func testFormatDisplayNameMultipleUnderscores() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        XCTAssertEqual(view.formatDisplayName("cudagraphs_dynamic"), "Cudagraphs Dynamic")
    }

    func testFormatDisplayNameAllCaps() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        XCTAssertEqual(view.formatDisplayName("AMP"), "Amp")
    }

    // MARK: - truncateModelName

    func testTruncateModelNameShortName() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        XCTAssertEqual(view.truncateModelName("resnet50"), "resnet50")
    }

    func testTruncateModelNameExactLength() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let name = String(repeating: "a", count: 20)
        XCTAssertEqual(view.truncateModelName(name), name)
    }

    func testTruncateModelNameLongName() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let name = "this_is_a_very_long_model_name_that_exceeds_limit"
        let result = view.truncateModelName(name)
        XCTAssertEqual(result.count, 20)
        XCTAssertTrue(result.hasSuffix("..."))
        XCTAssertEqual(result, "this_is_a_very_lo...")
    }

    func testTruncateModelNameOneOverLimit() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let name = String(repeating: "x", count: 21)
        let result = view.truncateModelName(name)
        XCTAssertEqual(result.count, 20)
        XCTAssertTrue(result.hasSuffix("..."))
    }

    // MARK: - speedupColor

    func testSpeedupColorNil() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let color = view.speedupColor(nil)
        XCTAssertEqual(color, .secondary)
    }

    func testSpeedupColorPass() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let color = view.speedupColor(1.10)
        XCTAssertEqual(color, AppColors.success)
    }

    func testSpeedupColorFail() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let color = view.speedupColor(0.90)
        XCTAssertEqual(color, AppColors.failure)
    }

    func testSpeedupColorNeutralAtExactBoundary() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        // 0.95 is NOT < 0.95, so it should be neutral (.primary)
        let color = view.speedupColor(0.95)
        XCTAssertEqual(color, .primary)
    }

    func testSpeedupColorNeutralAt105() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        // 1.05 is >= 1.05, so it should be success
        let color = view.speedupColor(1.05)
        XCTAssertEqual(color, AppColors.success)
    }

    func testSpeedupColorJustBelowPass() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let color = view.speedupColor(1.0499)
        XCTAssertEqual(color, .primary)
    }

    func testSpeedupColorJustBelowFail() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let color = view.speedupColor(0.9499)
        XCTAssertEqual(color, AppColors.failure)
    }

    // MARK: - statusInfo

    func testStatusInfoPassWithHighSpeedup() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let record = makeRecord(speedup: 1.10, accuracy: "pass")
        let (text, color) = view.statusInfo(for: record)
        XCTAssertEqual(text, "PASS")
        XCTAssertEqual(color, AppColors.success)
    }

    func testStatusInfoPassWithLowSpeedup() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let record = makeRecord(speedup: 0.90, accuracy: "pass")
        let (text, color) = view.statusInfo(for: record)
        XCTAssertEqual(text, "FAIL")
        XCTAssertEqual(color, AppColors.failure)
    }

    func testStatusInfoPassWithNeutralSpeedup() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let record = makeRecord(speedup: 1.00, accuracy: "pass")
        let (text, color) = view.statusInfo(for: record)
        XCTAssertEqual(text, "OK")
        XCTAssertEqual(color, AppColors.neutral)
    }

    func testStatusInfoPassDueToSkip() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let record = makeRecord(speedup: 1.20, accuracy: "pass_due_to_skip")
        let (text, color) = view.statusInfo(for: record)
        XCTAssertEqual(text, "PASS")
        XCTAssertEqual(color, AppColors.success)
    }

    func testStatusInfoNilSpeedup() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let record = makeRecord(speedup: nil, accuracy: "pass")
        let (text, color) = view.statusInfo(for: record)
        XCTAssertEqual(text, "N/A")
        XCTAssertEqual(color, AppColors.neutral)
    }

    func testStatusInfoNonPassAccuracy() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let record = makeRecord(speedup: 1.50, accuracy: "fail")
        let (text, color) = view.statusInfo(for: record)
        XCTAssertEqual(text, "SKIP")
        XCTAssertEqual(color, AppColors.neutral)
    }

    func testStatusInfoBoundarySpeedup105Pass() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let record = makeRecord(speedup: 1.05, accuracy: "pass")
        let (text, _) = view.statusInfo(for: record)
        XCTAssertEqual(text, "PASS")
    }

    func testStatusInfoBoundarySpeedup095Pass() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let record = makeRecord(speedup: 0.95, accuracy: "pass")
        let (text, _) = view.statusInfo(for: record)
        XCTAssertEqual(text, "OK")
    }

    // MARK: - computeSummaryForCompiler

    func testComputeSummaryEmptyRecords() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let stats = view.computeSummaryForCompiler("test", records: [])

        XCTAssertEqual(stats.compiler, "test")
        XCTAssertEqual(stats.passrate, 0)
        XCTAssertEqual(stats.geomean, 0)
        XCTAssertEqual(stats.compileTime, 0)
        XCTAssertEqual(stats.memoryRatio, 0)
    }

    func testComputeSummaryAllPassing() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let records = [
            makeRecord(name: "m1", speedup: 1.20, accuracy: "pass", compilationLatency: 10.0, compressionRatio: 0.95),
            makeRecord(name: "m2", speedup: 1.50, accuracy: "pass", compilationLatency: 20.0, compressionRatio: 0.90),
            makeRecord(name: "m3", speedup: 1.10, accuracy: "pass_due_to_skip", compilationLatency: 15.0, compressionRatio: 0.85),
        ]

        let stats = view.computeSummaryForCompiler("cudagraphs", records: records)

        XCTAssertEqual(stats.compiler, "cudagraphs")
        XCTAssertEqual(stats.passrate, 100.0, accuracy: 0.001)

        // Geomean of 1.20, 1.50, 1.10 = exp((ln(1.2) + ln(1.5) + ln(1.1)) / 3)
        let expectedGeomean = exp((log(1.20) + log(1.50) + log(1.10)) / 3.0)
        XCTAssertEqual(stats.geomean, expectedGeomean, accuracy: 0.001)

        // Mean compile time: (10 + 20 + 15) / 3 = 15
        XCTAssertEqual(stats.compileTime, 15.0, accuracy: 0.001)

        // Mean memory ratio: (0.95 + 0.90 + 0.85) / 3 = 0.9
        XCTAssertEqual(stats.memoryRatio, 0.9, accuracy: 0.001)
    }

    func testComputeSummaryMixedResults() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let records = [
            makeRecord(name: "m1", speedup: 1.20, accuracy: "pass", compilationLatency: 10.0, compressionRatio: 0.95),
            makeRecord(name: "m2", speedup: nil, accuracy: "fail"),
            makeRecord(name: "m3", speedup: 0.80, accuracy: "pass", compilationLatency: 5.0, compressionRatio: 1.10),
            makeRecord(name: "m4", speedup: 1.05, accuracy: "pass", compilationLatency: 8.0, compressionRatio: 0.88),
        ]

        let stats = view.computeSummaryForCompiler("default", records: records)

        // Passing: m1 (pass, speedup>0), m3 (pass, speedup>0), m4 (pass, speedup>0) = 3 / 4 = 75%
        XCTAssertEqual(stats.passrate, 75.0, accuracy: 0.001)

        // Geomean of 1.20, 0.80, 1.05 (nil speedup excluded)
        let expectedGeomean = exp((log(1.20) + log(0.80) + log(1.05)) / 3.0)
        XCTAssertEqual(stats.geomean, expectedGeomean, accuracy: 0.001)

        // Mean compile time: (10 + 5 + 8) / 3 = 7.667
        XCTAssertEqual(stats.compileTime, 7.667, accuracy: 0.01)

        // Mean memory ratio: (0.95 + 1.10 + 0.88) / 3 = 0.977
        XCTAssertEqual(stats.memoryRatio, 0.977, accuracy: 0.01)
    }

    func testComputeSummaryNoSpeedupData() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let records = [
            makeRecord(name: "m1", speedup: nil, accuracy: "fail"),
            makeRecord(name: "m2", speedup: nil, accuracy: "fail"),
        ]

        let stats = view.computeSummaryForCompiler("test", records: records)

        XCTAssertEqual(stats.passrate, 0.0, accuracy: 0.001)
        XCTAssertEqual(stats.geomean, 0.0, accuracy: 0.001)
    }

    func testComputeSummaryZeroSpeedupExcludedFromGeomean() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let records = [
            makeRecord(name: "m1", speedup: 0.0, accuracy: "pass"),
            makeRecord(name: "m2", speedup: 2.0, accuracy: "pass"),
        ]

        let stats = view.computeSummaryForCompiler("test", records: records)

        // Only speedup > 0 is included in geomean, so only 2.0
        XCTAssertEqual(stats.geomean, 2.0, accuracy: 0.001)

        // Passrate: m1 has speedup 0 (not > 0), so only m2 passes = 1/2 = 50%
        XCTAssertEqual(stats.passrate, 50.0, accuracy: 0.001)
    }

    func testComputeSummaryNilCompilationLatencyExcluded() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let records = [
            makeRecord(name: "m1", speedup: 1.0, accuracy: "pass", compilationLatency: nil),
            makeRecord(name: "m2", speedup: 1.0, accuracy: "pass", compilationLatency: 20.0),
        ]

        let stats = view.computeSummaryForCompiler("test", records: records)

        // Only non-nil, positive compile times included
        XCTAssertEqual(stats.compileTime, 20.0, accuracy: 0.001)
    }

    // MARK: - rowBackground

    func testRowBackgroundPassingSpeedup() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let record = makeRecord(speedup: 1.10, accuracy: "pass")
        let color = view.rowBackground(for: record)
        // Should be success-tinted
        XCTAssertNotEqual(color, .clear)
    }

    func testRowBackgroundFailingSpeedup() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let record = makeRecord(speedup: 0.80, accuracy: "pass")
        let color = view.rowBackground(for: record)
        // Should be failure-tinted
        XCTAssertNotEqual(color, .clear)
    }

    func testRowBackgroundNilSpeedup() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let record = makeRecord(speedup: nil, accuracy: "pass")
        let _ = view.rowBackground(for: record)
        // Should not crash; returns a valid color
    }

    // MARK: - CompilerSummaryStats

    func testCompilerSummaryStatsIdentifiable() {
        let stats1 = CompilerSummaryStats(compiler: "a", passrate: 90, geomean: 1.1, compileTime: 10, memoryRatio: 0.9)
        let stats2 = CompilerSummaryStats(compiler: "a", passrate: 90, geomean: 1.1, compileTime: 10, memoryRatio: 0.9)

        // Each instance should have a unique id
        XCTAssertNotEqual(stats1.id, stats2.id)
    }

    // MARK: - ModelSortOrder

    func testModelSortOrderAllCases() {
        let cases = CompilerBenchmarkView.ModelSortOrder.allCases
        XCTAssertEqual(cases.count, 4)
        XCTAssertTrue(cases.contains(.speedupDesc))
        XCTAssertTrue(cases.contains(.speedupAsc))
        XCTAssertTrue(cases.contains(.nameAsc))
        XCTAssertTrue(cases.contains(.compileTimeDesc))
    }

    func testModelSortOrderRawValues() {
        XCTAssertEqual(CompilerBenchmarkView.ModelSortOrder.speedupDesc.rawValue, "Speedup (High)")
        XCTAssertEqual(CompilerBenchmarkView.ModelSortOrder.speedupAsc.rawValue, "Speedup (Low)")
        XCTAssertEqual(CompilerBenchmarkView.ModelSortOrder.nameAsc.rawValue, "Name (A-Z)")
        XCTAssertEqual(CompilerBenchmarkView.ModelSortOrder.compileTimeDesc.rawValue, "Compile Time")
    }

    // MARK: - ViewState

    func testViewStateEquatable() {
        XCTAssertEqual(CompilerBenchmarkView.ViewState.idle, CompilerBenchmarkView.ViewState.idle)
        XCTAssertEqual(CompilerBenchmarkView.ViewState.loading, CompilerBenchmarkView.ViewState.loading)
        XCTAssertEqual(CompilerBenchmarkView.ViewState.loaded, CompilerBenchmarkView.ViewState.loaded)
        XCTAssertEqual(
            CompilerBenchmarkView.ViewState.error("test"),
            CompilerBenchmarkView.ViewState.error("test")
        )
        XCTAssertNotEqual(
            CompilerBenchmarkView.ViewState.error("a"),
            CompilerBenchmarkView.ViewState.error("b")
        )
        XCTAssertNotEqual(
            CompilerBenchmarkView.ViewState.idle,
            CompilerBenchmarkView.ViewState.loading
        )
    }

    // MARK: - Filtered Records Integration

    func testFilteredRecordsAllFilters() {
        // This test verifies the filtering logic by checking the computed property
        // through the view's public interface. Since filteredRecords depends on @State
        // which cannot be set externally, we test the underlying filter logic directly.
        let records = [
            makeRecord(name: "model_a", compiler: "inductor", suite: "torchbench", speedup: 1.2, accuracy: "pass"),
            makeRecord(name: "model_b", compiler: "inductor_no_cudagraphs", suite: "huggingface", speedup: 0.9, accuracy: "pass"),
            makeRecord(name: "model_c", compiler: "inductor", suite: "torchbench", speedup: 1.5, accuracy: "pass"),
        ]

        // Simulate filtering for suite="torchbench"
        let suiteFiltered = records.filter { $0.suite == "torchbench" }
        XCTAssertEqual(suiteFiltered.count, 2)

        // Simulate filtering for search="model_a"
        let searchFiltered = records.filter { $0.name.lowercased().contains("model_a") }
        XCTAssertEqual(searchFiltered.count, 1)
    }

    func testModelsByCompilerGrouping() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let records = [
            makeRecord(name: "m1", compiler: "inductor", suite: "torchbench", speedup: 1.2, accuracy: "pass"),
            makeRecord(name: "m2", compiler: "inductor", suite: "torchbench", speedup: 1.3, accuracy: "pass"),
            makeRecord(name: "m3", compiler: "inductor_no_cudagraphs", suite: "torchbench", speedup: 1.1, accuracy: "pass"),
        ]

        var result: [String: [String: CompilerPerformanceRecord]] = [:]
        for record in records {
            let compiler = view.displayNameForCompiler(record.compiler)
            if result[compiler] == nil { result[compiler] = [:] }
            result[compiler]?[record.name] = record
        }

        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result["cudagraphs"]?.count, 2)
        XCTAssertEqual(result["default"]?.count, 1)
    }

    // MARK: - Edge Cases

    func testComputeSummarySingleRecord() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let records = [
            makeRecord(name: "only_model", speedup: 1.30, accuracy: "pass", compilationLatency: 25.0, compressionRatio: 0.92),
        ]

        let stats = view.computeSummaryForCompiler("single", records: records)

        XCTAssertEqual(stats.passrate, 100.0, accuracy: 0.001)
        XCTAssertEqual(stats.geomean, 1.30, accuracy: 0.001)
        XCTAssertEqual(stats.compileTime, 25.0, accuracy: 0.001)
        XCTAssertEqual(stats.memoryRatio, 0.92, accuracy: 0.001)
    }

    func testComputeSummaryAllSkipped() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let records = [
            makeRecord(name: "m1", speedup: 1.5, accuracy: "eager_fail"),
            makeRecord(name: "m2", speedup: 1.2, accuracy: "model_fail"),
        ]

        let stats = view.computeSummaryForCompiler("test", records: records)

        // No passing records (accuracy is not "pass" or "pass_due_to_skip")
        XCTAssertEqual(stats.passrate, 0.0, accuracy: 0.001)
        // Geomean still computed from speedups
        let expectedGeomean = exp((log(1.5) + log(1.2)) / 2.0)
        XCTAssertEqual(stats.geomean, expectedGeomean, accuracy: 0.001)
    }

    func testTruncateModelNameEmptyString() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        XCTAssertEqual(view.truncateModelName(""), "")
    }

    func testTruncateModelNameSingleChar() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        XCTAssertEqual(view.truncateModelName("a"), "a")
    }

    func testSpeedupColorExactlyOne() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        // 1.0 is >= 0.95 and < 1.05, so neutral
        let color = view.speedupColor(1.0)
        XCTAssertEqual(color, .primary)
    }

    func testSpeedupColorVeryHighSpeedup() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let color = view.speedupColor(10.0)
        XCTAssertEqual(color, AppColors.success)
    }

    func testSpeedupColorVeryLowSpeedup() {
        let view = CompilerBenchmarkView(benchmarkId: nil)
        let color = view.speedupColor(0.01)
        XCTAssertEqual(color, AppColors.failure)
    }

    // MARK: - Helpers

    private func makeRecord(
        name: String = "test_model",
        compiler: String = "inductor",
        suite: String = "torchbench",
        speedup: Double? = nil,
        accuracy: String = "pass",
        compilationLatency: Double? = nil,
        compressionRatio: Double? = nil,
        peakMemory: Double? = nil
    ) -> CompilerPerformanceRecord {
        CompilerPerformanceRecord(
            name: name,
            compiler: compiler,
            suite: suite,
            speedup: speedup,
            accuracy: accuracy,
            compilationLatency: compilationLatency,
            compressionRatio: compressionRatio,
            peakMemory: peakMemory
        )
    }
}
