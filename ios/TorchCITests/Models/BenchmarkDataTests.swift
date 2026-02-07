import XCTest
@testable import TorchCI

final class BenchmarkDataTests: XCTestCase {

    // MARK: - BenchmarkDataPoint.changePercent

    func testChangePercentPositive() {
        let point = makeBenchmarkDataPoint(value: 120.0, baseline: 100.0)

        XCTAssertNotNil(point.changePercent)
        XCTAssertEqual(point.changePercent!, 20.0, accuracy: 0.001)
    }

    func testChangePercentNegative() {
        let point = makeBenchmarkDataPoint(value: 80.0, baseline: 100.0)

        XCTAssertNotNil(point.changePercent)
        XCTAssertEqual(point.changePercent!, -20.0, accuracy: 0.001)
    }

    func testChangePercentZeroChange() {
        let point = makeBenchmarkDataPoint(value: 100.0, baseline: 100.0)

        XCTAssertNotNil(point.changePercent)
        XCTAssertEqual(point.changePercent!, 0.0, accuracy: 0.001)
    }

    func testChangePercentZeroBaseline() {
        let point = makeBenchmarkDataPoint(value: 50.0, baseline: 0.0)

        // Division by zero -- should return nil
        XCTAssertNil(point.changePercent)
    }

    func testChangePercentNilBaseline() {
        let point = makeBenchmarkDataPoint(value: 50.0, baseline: nil)

        XCTAssertNil(point.changePercent)
    }

    func testChangePercentLargeIncrease() {
        let point = makeBenchmarkDataPoint(value: 300.0, baseline: 100.0)

        XCTAssertNotNil(point.changePercent)
        XCTAssertEqual(point.changePercent!, 200.0, accuracy: 0.001)
    }

    func testChangePercentSmallFractional() {
        let point = makeBenchmarkDataPoint(value: 1.05, baseline: 1.00)

        XCTAssertNotNil(point.changePercent)
        XCTAssertEqual(point.changePercent!, 5.0, accuracy: 0.001)
    }

    // MARK: - BenchmarkDataPoint.isRegression

    func testIsRegressionBelowThreshold() {
        // speedup < 0.95 is a regression
        let point = makeBenchmarkDataPoint(value: 100.0, baseline: nil, speedup: 0.90)

        XCTAssertTrue(point.isRegression)
    }

    func testIsRegressionAtExactThreshold() {
        // speedup == 0.95 is NOT a regression (< 0.95 is required)
        let point = makeBenchmarkDataPoint(value: 100.0, baseline: nil, speedup: 0.95)

        XCTAssertFalse(point.isRegression)
    }

    func testIsRegressionAboveThreshold() {
        let point = makeBenchmarkDataPoint(value: 100.0, baseline: nil, speedup: 1.05)

        XCTAssertFalse(point.isRegression)
    }

    func testIsRegressionNilSpeedup() {
        let point = makeBenchmarkDataPoint(value: 100.0, baseline: nil, speedup: nil)

        XCTAssertFalse(point.isRegression)
    }

    func testIsRegressionJustBelowThreshold() {
        let point = makeBenchmarkDataPoint(value: 100.0, baseline: nil, speedup: 0.9499)

        XCTAssertTrue(point.isRegression)
    }

    func testIsRegressionDeepRegression() {
        let point = makeBenchmarkDataPoint(value: 100.0, baseline: nil, speedup: 0.50)

        XCTAssertTrue(point.isRegression)
    }

    // MARK: - BenchmarkDataPoint.id

    func testBenchmarkDataPointId() {
        let point = makeBenchmarkDataPoint(
            name: "resnet50",
            metric: "compile_time_ms",
            value: 150.0,
            baseline: nil
        )

        XCTAssertEqual(point.id, "resnet50-compile_time_ms")
    }

    func testBenchmarkDataPointIdNilMetric() {
        let point = makeBenchmarkDataPoint(
            name: "bert-base",
            metric: nil,
            value: 100.0,
            baseline: nil
        )

        XCTAssertEqual(point.id, "bert-base-")
    }

    // MARK: - BenchmarkDataPoint decoding from JSON

    func testBenchmarkDataPointDecoding() {
        let json = """
        {
            "name": "torchbench_resnet50",
            "metric": "speedup",
            "value": 1.45,
            "baseline": 1.40,
            "speedup": 1.036,
            "status": "pass"
        }
        """

        let point: BenchmarkDataPoint = MockData.decode(json)

        XCTAssertEqual(point.name, "torchbench_resnet50")
        XCTAssertEqual(point.metric, "speedup")
        XCTAssertEqual(point.value, 1.45, accuracy: 0.001)
        XCTAssertEqual(point.baseline, 1.40, accuracy: 0.001)
        XCTAssertEqual(point.speedup, 1.036, accuracy: 0.001)
        XCTAssertEqual(point.status, "pass")
        XCTAssertFalse(point.isRegression)
    }

    func testBenchmarkDataPointDecodingNilOptionals() {
        let json = """
        {
            "name": "custom_model",
            "metric": null,
            "value": 42.0,
            "baseline": null,
            "speedup": null,
            "status": null
        }
        """

        let point: BenchmarkDataPoint = MockData.decode(json)

        XCTAssertEqual(point.name, "custom_model")
        XCTAssertNil(point.metric)
        XCTAssertEqual(point.value, 42.0, accuracy: 0.001)
        XCTAssertNil(point.baseline)
        XCTAssertNil(point.speedup)
        XCTAssertNil(point.status)
        XCTAssertNil(point.changePercent)
        XCTAssertFalse(point.isRegression)
    }

    // MARK: - BenchmarkGroupData decoding

    func testBenchmarkGroupDataDecoding() {
        let json = """
        {
            "data": [
                {
                    "name": "torchbench_resnet50",
                    "metric": "speedup",
                    "value": 1.45,
                    "baseline": 1.40,
                    "speedup": 1.036,
                    "status": "pass"
                },
                {
                    "name": "torchbench_bert_base",
                    "metric": "speedup",
                    "value": 0.85,
                    "baseline": 1.00,
                    "speedup": 0.85,
                    "status": "fail"
                }
            ],
            "metadata": {
                "suite": "torchbench",
                "compiler": "inductor",
                "mode": "inference",
                "dtype": "float32",
                "device": "cuda",
                "branch": "main",
                "commit": "abc123def"
            }
        }
        """

        let group: BenchmarkGroupData = MockData.decode(json)

        XCTAssertEqual(group.data.count, 2)
        XCTAssertNotNil(group.metadata)
        XCTAssertEqual(group.metadata?.suite, "torchbench")
        XCTAssertEqual(group.metadata?.compiler, "inductor")
        XCTAssertEqual(group.metadata?.mode, "inference")
        XCTAssertEqual(group.metadata?.dtype, "float32")
        XCTAssertEqual(group.metadata?.device, "cuda")
        XCTAssertEqual(group.metadata?.branch, "main")
        XCTAssertEqual(group.metadata?.commit, "abc123def")

        // First point should not be a regression (speedup 1.036 >= 0.95)
        XCTAssertFalse(group.data[0].isRegression)

        // Second point should be a regression (speedup 0.85 < 0.95)
        XCTAssertTrue(group.data[1].isRegression)
    }

    func testBenchmarkGroupDataNilMetadata() {
        let json = """
        {
            "data": [],
            "metadata": null
        }
        """

        let group: BenchmarkGroupData = MockData.decode(json)

        XCTAssertTrue(group.data.isEmpty)
        XCTAssertNil(group.metadata)
    }

    // MARK: - RegressionItem.changePercent

    func testRegressionItemChangePercentPositive() {
        let item = makeRegressionItem(oldValue: 100.0, newValue: 150.0)

        XCTAssertEqual(item.changePercent, 50.0, accuracy: 0.001)
    }

    func testRegressionItemChangePercentNegative() {
        let item = makeRegressionItem(oldValue: 200.0, newValue: 150.0)

        XCTAssertEqual(item.changePercent, -25.0, accuracy: 0.001)
    }

    func testRegressionItemChangePercentZeroOldValue() {
        let item = makeRegressionItem(oldValue: 0.0, newValue: 100.0)

        // Division by zero -- should return 0
        XCTAssertEqual(item.changePercent, 0.0, accuracy: 0.001)
    }

    func testRegressionItemChangePercentNoChange() {
        let item = makeRegressionItem(oldValue: 42.0, newValue: 42.0)

        XCTAssertEqual(item.changePercent, 0.0, accuracy: 0.001)
    }

    func testRegressionItemChangePercentSmallDelta() {
        let item = makeRegressionItem(oldValue: 1000.0, newValue: 1005.0)

        XCTAssertEqual(item.changePercent, 0.5, accuracy: 0.001)
    }

    // MARK: - RegressionItem.id

    func testRegressionItemId() {
        let item = makeRegressionItem(
            model: "resnet50",
            metric: "compile_time_ms",
            oldValue: 100.0,
            newValue: 120.0
        )

        XCTAssertEqual(item.id, "resnet50-compile_time_ms")
    }

    // MARK: - RegressionItem decoding from JSON

    func testRegressionItemDecoding() {
        let json = """
        {
            "model": "BERT_pytorch",
            "metric": "compilation_latency",
            "old_value": 12.5,
            "new_value": 15.8,
            "delta": 3.3
        }
        """

        let item: RegressionItem = MockData.decode(json)

        XCTAssertEqual(item.model, "BERT_pytorch")
        XCTAssertEqual(item.metric, "compilation_latency")
        XCTAssertEqual(item.oldValue, 12.5, accuracy: 0.001)
        XCTAssertEqual(item.newValue, 15.8, accuracy: 0.001)
        XCTAssertEqual(item.delta, 3.3, accuracy: 0.001)
        XCTAssertEqual(item.changePercent, 26.4, accuracy: 0.1)
    }

    func testRegressionItemDecodingNilDelta() {
        let json = """
        {
            "model": "timm_vision_transformer",
            "metric": "accuracy",
            "old_value": 0.95,
            "new_value": 0.93,
            "delta": null
        }
        """

        let item: RegressionItem = MockData.decode(json)

        XCTAssertNil(item.delta)
        // changePercent should still work: (0.93 - 0.95) / 0.95 * 100 = -2.105...
        XCTAssertEqual(item.changePercent, -2.105, accuracy: 0.01)
    }

    // MARK: - RegressionReport decoding

    func testRegressionReportDecoding() {
        let json = """
        {
            "id": "report-2025-01-20",
            "report_id": "compiler_regression",
            "created_at": "2025-01-20T08:00:00Z",
            "last_record_ts": "2025-01-20T07:55:00Z",
            "last_record_commit": "abc123def456789",
            "type": "benchmark",
            "status": "regression",
            "repo": "pytorch/pytorch",
            "regression_count": 3,
            "insufficient_data_count": 1,
            "suspected_regression_count": 2,
            "total_count": 6,
            "details": {
                "regression": [
                    {
                        "group_info": {"model": "resnet50", "metric": "speedup"},
                        "baseline_point": {"commit": "aaa111", "value": 1.40, "timestamp": "2025-01-19T00:00:00Z", "branch": "main", "workflow_id": "w1"},
                        "points": [
                            {"commit": "bbb222", "value": 1.20, "timestamp": "2025-01-20T00:00:00Z", "branch": "main", "workflow_id": "w2"}
                        ]
                    }
                ],
                "suspicious": [
                    {
                        "group_info": {"model": "BERT_pytorch", "metric": "compilation_latency"},
                        "baseline_point": {"commit": "ccc333", "value": 12.5, "timestamp": "2025-01-19T00:00:00Z", "branch": "main", "workflow_id": "w3"},
                        "points": [
                            {"commit": "ddd444", "value": 15.0, "timestamp": "2025-01-20T00:00:00Z", "branch": "main", "workflow_id": "w4"}
                        ]
                    }
                ]
            },
            "filters": {"suite": ["torchbench", "huggingface"]}
        }
        """

        let report: RegressionReport = MockData.decode(json)

        XCTAssertEqual(report.id, "report-2025-01-20")
        XCTAssertEqual(report.reportId, "compiler_regression")
        XCTAssertEqual(report.createdAt, "2025-01-20T08:00:00Z")
        XCTAssertEqual(report.status, "regression")
        XCTAssertEqual(report.repo, "pytorch/pytorch")
        XCTAssertEqual(report.regressionCount, 3)
        XCTAssertEqual(report.totalCount, 6)
        XCTAssertEqual(report.details?.regression?.count, 1)
        XCTAssertEqual(report.details?.suspicious?.count, 1)

        let firstRegression = report.details!.regression![0]
        XCTAssertEqual(firstRegression.groupInfo?["model"], "resnet50")
        // (1.20 - 1.40) / 1.40 * 100 = -14.285...
        XCTAssertNotNil(firstRegression.changePercent)
        XCTAssertEqual(firstRegression.changePercent!, -14.285, accuracy: 0.01)
    }

    func testRegressionReportNilOptionals() {
        let json = """
        {
            "id": "report-empty",
            "report_id": null,
            "created_at": null,
            "status": null,
            "repo": null,
            "regression_count": null,
            "total_count": null,
            "details": null,
            "filters": null
        }
        """

        let report: RegressionReport = MockData.decode(json)

        XCTAssertEqual(report.id, "report-empty")
        XCTAssertNil(report.reportId)
        XCTAssertNil(report.createdAt)
        XCTAssertNil(report.status)
        XCTAssertNil(report.details)
    }

    // MARK: - BenchmarkMetadata decoding

    func testBenchmarkMetadataDecoding() {
        let json = """
        {
            "id": "torchbench-v2",
            "name": "TorchBench",
            "description": "PyTorch model benchmarks",
            "suites": ["torchbench", "huggingface", "timm_models"],
            "last_updated": "2025-01-20T12:00:00Z"
        }
        """

        let metadata: BenchmarkMetadata = MockData.decode(json)

        XCTAssertEqual(metadata.id, "torchbench-v2")
        XCTAssertEqual(metadata.name, "TorchBench")
        XCTAssertEqual(metadata.description, "PyTorch model benchmarks")
        XCTAssertEqual(metadata.suites, ["torchbench", "huggingface", "timm_models"])
        XCTAssertEqual(metadata.lastUpdated, "2025-01-20T12:00:00Z")
    }

    // MARK: - BenchmarkTimeSeriesPoint decoding

    func testBenchmarkTimeSeriesPointDecoding() {
        let json = """
        {
            "commit": "abc123def456",
            "commit_date": "2025-01-20T10:00:00Z",
            "value": 1.45,
            "metric": "speedup",
            "model": "resnet50"
        }
        """

        let point: BenchmarkTimeSeriesPoint = MockData.decode(json)

        XCTAssertEqual(point.commit, "abc123def456")
        XCTAssertEqual(point.commitDate, "2025-01-20T10:00:00Z")
        XCTAssertEqual(point.value, 1.45, accuracy: 0.001)
        XCTAssertEqual(point.metric, "speedup")
        XCTAssertEqual(point.model, "resnet50")
        XCTAssertEqual(point.id, "abc123def456-speedup-resnet50")
    }

    func testBenchmarkTimeSeriesPointIdNilFields() {
        let json = """
        {
            "commit": "xyz789",
            "commit_date": null,
            "value": 2.0,
            "metric": null,
            "model": null
        }
        """

        let point: BenchmarkTimeSeriesPoint = MockData.decode(json)

        XCTAssertEqual(point.id, "xyz789--")
    }

    // MARK: - Helpers

    private func makeBenchmarkDataPoint(
        name: String = "test_model",
        metric: String? = "speedup",
        value: Double,
        baseline: Double?,
        speedup: Double? = nil
    ) -> BenchmarkDataPoint {
        let baselineStr = baseline.map { "\($0)" } ?? "null"
        let speedupStr = speedup.map { "\($0)" } ?? "null"
        let metricStr = metric.map { "\"\($0)\"" } ?? "null"

        let json = """
        {
            "name": "\(name)",
            "metric": \(metricStr),
            "value": \(value),
            "baseline": \(baselineStr),
            "speedup": \(speedupStr),
            "status": null
        }
        """
        return MockData.decode(json)
    }

    private func makeRegressionItem(
        model: String = "test_model",
        metric: String = "speedup",
        oldValue: Double,
        newValue: Double,
        delta: Double? = nil
    ) -> RegressionItem {
        let deltaStr = delta.map { "\($0)" } ?? "null"

        let json = """
        {
            "model": "\(model)",
            "metric": "\(metric)",
            "old_value": \(oldValue),
            "new_value": \(newValue),
            "delta": \(deltaStr)
        }
        """
        return MockData.decode(json)
    }
}
