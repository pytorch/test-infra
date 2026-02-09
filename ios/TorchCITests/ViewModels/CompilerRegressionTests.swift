import XCTest
@testable import TorchCI

final class CompilerRegressionTests: XCTestCase {

    // MARK: - RegressionDetailItem.changePercent

    func testChangePercentPositiveRegression() {
        let item = makeDetailItem(baselineValue: 100.0, latestValue: 125.0)

        XCTAssertNotNil(item.changePercent)
        XCTAssertEqual(item.changePercent!, 25.0, accuracy: 0.001)
    }

    func testChangePercentNegativeImprovement() {
        let item = makeDetailItem(baselineValue: 100.0, latestValue: 80.0)

        XCTAssertNotNil(item.changePercent)
        XCTAssertEqual(item.changePercent!, -20.0, accuracy: 0.001)
    }

    func testChangePercentNoChange() {
        let item = makeDetailItem(baselineValue: 50.0, latestValue: 50.0)

        XCTAssertNotNil(item.changePercent)
        XCTAssertEqual(item.changePercent!, 0.0, accuracy: 0.001)
    }

    func testChangePercentZeroBaseline() {
        let item = makeDetailItem(baselineValue: 0.0, latestValue: 10.0)

        // Division by zero should return nil
        XCTAssertNil(item.changePercent)
    }

    func testChangePercentNilBaseline() {
        let json = """
        {
            "group_info": {"model": "test"},
            "baseline_point": null,
            "points": [{"commit": "abc", "value": 10.0}]
        }
        """
        let item: RegressionDetailItem = MockData.decode(json)

        XCTAssertNil(item.changePercent)
    }

    func testChangePercentNilLatestPoint() {
        let json = """
        {
            "group_info": {"model": "test"},
            "baseline_point": {"commit": "abc", "value": 10.0},
            "points": []
        }
        """
        let item: RegressionDetailItem = MockData.decode(json)

        // No latest point -> nil changePercent
        XCTAssertNil(item.changePercent)
    }

    func testChangePercentSmallFractionalChange() {
        let item = makeDetailItem(baselineValue: 1.0, latestValue: 1.005)

        XCTAssertNotNil(item.changePercent)
        XCTAssertEqual(item.changePercent!, 0.5, accuracy: 0.001)
    }

    func testChangePercentLargeRegression() {
        let item = makeDetailItem(baselineValue: 100.0, latestValue: 350.0)

        XCTAssertNotNil(item.changePercent)
        XCTAssertEqual(item.changePercent!, 250.0, accuracy: 0.001)
    }

    // MARK: - RegressionDetailItem.latestPoint

    func testLatestPointReturnsLastElement() {
        let json = """
        {
            "group_info": {"model": "test"},
            "baseline_point": {"commit": "base", "value": 10.0},
            "points": [
                {"commit": "first", "value": 11.0},
                {"commit": "second", "value": 12.0},
                {"commit": "third", "value": 13.0}
            ]
        }
        """
        let item: RegressionDetailItem = MockData.decode(json)

        XCTAssertEqual(item.latestPoint?.commit, "third")
        XCTAssertEqual(item.latestPoint?.value, 13.0)
    }

    func testLatestPointNilForEmptyPoints() {
        let json = """
        {
            "group_info": {"model": "test"},
            "baseline_point": {"commit": "base", "value": 10.0},
            "points": []
        }
        """
        let item: RegressionDetailItem = MockData.decode(json)

        XCTAssertNil(item.latestPoint)
    }

    func testLatestPointNilForNullPoints() {
        let json = """
        {
            "group_info": {"model": "test"},
            "baseline_point": {"commit": "base", "value": 10.0},
            "points": null
        }
        """
        let item: RegressionDetailItem = MockData.decode(json)

        XCTAssertNil(item.latestPoint)
    }

    // MARK: - RegressionDetailItem.id

    func testIdFromGroupInfoSortedByKey() {
        let json = """
        {
            "group_info": {"model": "resnet50", "compiler": "inductor", "metric": "speedup"},
            "baseline_point": null,
            "points": null
        }
        """
        let item: RegressionDetailItem = MockData.decode(json)

        // Keys sorted alphabetically: compiler, metric, model
        XCTAssertEqual(item.id, "compiler:inductor,metric:speedup,model:resnet50")
    }

    func testIdEmptyGroupInfo() {
        let json = """
        {
            "group_info": {},
            "baseline_point": null,
            "points": null
        }
        """
        let item: RegressionDetailItem = MockData.decode(json)

        XCTAssertEqual(item.id, "")
    }

    func testIdNilGroupInfo() {
        let json = """
        {
            "group_info": null,
            "baseline_point": null,
            "points": null
        }
        """
        let item: RegressionDetailItem = MockData.decode(json)

        XCTAssertEqual(item.id, "")
    }

    // MARK: - RegressionPoint decoding

    func testRegressionPointFullDecoding() {
        let json = """
        {
            "commit": "abc123def456",
            "value": 1.45,
            "timestamp": "2025-01-20T10:00:00Z",
            "branch": "main",
            "workflow_id": "w-12345"
        }
        """
        let point: RegressionPoint = MockData.decode(json)

        XCTAssertEqual(point.commit, "abc123def456")
        XCTAssertEqual(point.value, 1.45)
        XCTAssertEqual(point.timestamp, "2025-01-20T10:00:00Z")
        XCTAssertEqual(point.branch, "main")
        XCTAssertEqual(point.workflowId, "w-12345")
    }

    func testRegressionPointNilOptionals() {
        let json = """
        {
            "commit": null,
            "value": null,
            "timestamp": null,
            "branch": null,
            "workflow_id": null
        }
        """
        let point: RegressionPoint = MockData.decode(json)

        XCTAssertNil(point.commit)
        XCTAssertNil(point.value)
        XCTAssertNil(point.timestamp)
        XCTAssertNil(point.branch)
        XCTAssertNil(point.workflowId)
    }

    // MARK: - RegressionReportDetails decoding

    func testRegressionReportDetailsWithBothArrays() {
        let json = """
        {
            "regression": [
                {
                    "group_info": {"model": "resnet50"},
                    "baseline_point": {"commit": "a", "value": 1.0},
                    "points": [{"commit": "b", "value": 1.5}]
                }
            ],
            "suspicious": [
                {
                    "group_info": {"model": "bert"},
                    "baseline_point": {"commit": "c", "value": 2.0},
                    "points": [{"commit": "d", "value": 2.3}]
                },
                {
                    "group_info": {"model": "vit"},
                    "baseline_point": {"commit": "e", "value": 3.0},
                    "points": [{"commit": "f", "value": 3.1}]
                }
            ]
        }
        """
        let details: RegressionReportDetails = MockData.decode(json)

        XCTAssertEqual(details.regression?.count, 1)
        XCTAssertEqual(details.suspicious?.count, 2)
        XCTAssertEqual(details.regression?[0].groupInfo?["model"], "resnet50")
        XCTAssertEqual(details.suspicious?[0].groupInfo?["model"], "bert")
        XCTAssertEqual(details.suspicious?[1].groupInfo?["model"], "vit")
    }

    func testRegressionReportDetailsNullArrays() {
        let json = """
        {
            "regression": null,
            "suspicious": null
        }
        """
        let details: RegressionReportDetails = MockData.decode(json)

        XCTAssertNil(details.regression)
        XCTAssertNil(details.suspicious)
    }

    // MARK: - RegressionReportListResponse decoding

    func testRegressionReportListResponseDecoding() {
        let json = """
        {
            "reports": [
                {
                    "id": "r1",
                    "report_id": "compiler_precompute",
                    "regression_count": 5,
                    "total_count": 100
                },
                {
                    "id": "r2",
                    "report_id": "compiler_precompute",
                    "regression_count": 2,
                    "total_count": 80
                }
            ],
            "next_cursor": "cursor-abc"
        }
        """
        let response: RegressionReportListResponse = MockData.decode(json)

        XCTAssertEqual(response.reports?.count, 2)
        XCTAssertEqual(response.reports?[0].id, "r1")
        XCTAssertEqual(response.reports?[1].id, "r2")
        XCTAssertEqual(response.nextCursor, "cursor-abc")
    }

    func testRegressionReportListResponseEmpty() {
        let json = """
        {
            "reports": [],
            "next_cursor": null
        }
        """
        let response: RegressionReportListResponse = MockData.decode(json)

        XCTAssertEqual(response.reports?.count, 0)
        XCTAssertNil(response.nextCursor)
    }

    func testRegressionReportListResponseNullReports() {
        let json = """
        {
            "reports": null,
            "next_cursor": null
        }
        """
        let response: RegressionReportListResponse = MockData.decode(json)

        XCTAssertNil(response.reports)
    }

    // MARK: - RegressionReport with full details decoding

    func testRegressionReportWithFilters() {
        let json = """
        {
            "id": "r-filters",
            "report_id": "compiler_precompute",
            "filters": {
                "suite": ["torchbench", "huggingface"],
                "compiler": ["inductor"],
                "mode": ["inference", "training"]
            }
        }
        """
        let report: RegressionReport = MockData.decode(json)

        XCTAssertEqual(report.filters?["suite"]?.count, 2)
        XCTAssertEqual(report.filters?["compiler"]?.count, 1)
        XCTAssertEqual(report.filters?["mode"]?.count, 2)
        XCTAssertTrue(report.filters?["suite"]?.contains("torchbench") ?? false)
    }

    func testRegressionReportAllCounts() {
        let json = """
        {
            "id": "r-counts",
            "regression_count": 10,
            "insufficient_data_count": 5,
            "suspected_regression_count": 3,
            "total_count": 200
        }
        """
        let report: RegressionReport = MockData.decode(json)

        XCTAssertEqual(report.regressionCount, 10)
        XCTAssertEqual(report.insufficientDataCount, 5)
        XCTAssertEqual(report.suspectedRegressionCount, 3)
        XCTAssertEqual(report.totalCount, 200)
    }

    // MARK: - Severity classification logic

    func testSeverityCriticalThreshold() {
        // Critical: abs(changePercent) >= 20
        let criticalItem = makeDetailItem(baselineValue: 100.0, latestValue: 120.0) // +20%
        XCTAssertEqual(criticalItem.changePercent!, 20.0, accuracy: 0.001)
        XCTAssertTrue(abs(criticalItem.changePercent!) >= 20)

        let justBelowCritical = makeDetailItem(baselineValue: 100.0, latestValue: 119.9) // +19.9%
        XCTAssertTrue(abs(justBelowCritical.changePercent!) < 20)
    }

    func testSeverityWarningThreshold() {
        // Warning: abs(changePercent) >= 10 && < 20
        let warningItem = makeDetailItem(baselineValue: 100.0, latestValue: 115.0) // +15%
        let change = abs(warningItem.changePercent!)
        XCTAssertTrue(change >= 10 && change < 20)
    }

    func testSeverityMinorThreshold() {
        // Minor: abs(changePercent) < 10
        let minorItem = makeDetailItem(baselineValue: 100.0, latestValue: 105.0) // +5%
        XCTAssertTrue(abs(minorItem.changePercent!) < 10)
    }

    func testSeverityNegativeRegression() {
        // Negative changes should also classify by absolute value
        let negativeCritical = makeDetailItem(baselineValue: 100.0, latestValue: 75.0) // -25%
        XCTAssertTrue(abs(negativeCritical.changePercent!) >= 20)
    }

    // MARK: - RegressionDetailItem with rich groupInfo

    func testGroupInfoWithMultipleKeys() {
        let json = """
        {
            "group_info": {
                "model": "BERT_pytorch",
                "metric": "compilation_latency",
                "compiler": "inductor",
                "suite": "torchbench",
                "dtype": "float32",
                "device": "cuda",
                "mode": "inference"
            },
            "baseline_point": {"commit": "abc", "value": 10.0},
            "points": [{"commit": "def", "value": 12.0}]
        }
        """
        let item: RegressionDetailItem = MockData.decode(json)

        XCTAssertEqual(item.groupInfo?["model"], "BERT_pytorch")
        XCTAssertEqual(item.groupInfo?["metric"], "compilation_latency")
        XCTAssertEqual(item.groupInfo?["compiler"], "inductor")
        XCTAssertEqual(item.groupInfo?["suite"], "torchbench")
        XCTAssertEqual(item.groupInfo?["dtype"], "float32")
        XCTAssertEqual(item.groupInfo?["device"], "cuda")
        XCTAssertEqual(item.groupInfo?["mode"], "inference")

        // Verify changePercent: (12.0 - 10.0) / 10.0 * 100 = 20.0
        XCTAssertEqual(item.changePercent!, 20.0, accuracy: 0.001)
    }

    // MARK: - RegressionDetailItem with multiple points

    func testChangePercentUsesLastPoint() {
        let json = """
        {
            "group_info": {"model": "test"},
            "baseline_point": {"commit": "base", "value": 100.0},
            "points": [
                {"commit": "p1", "value": 110.0},
                {"commit": "p2", "value": 120.0},
                {"commit": "p3", "value": 130.0}
            ]
        }
        """
        let item: RegressionDetailItem = MockData.decode(json)

        // Should use last point (130.0) for changePercent: (130 - 100) / 100 * 100 = 30.0
        XCTAssertEqual(item.changePercent!, 30.0, accuracy: 0.001)
        XCTAssertEqual(item.latestPoint?.commit, "p3")
    }

    // MARK: - RegressionReportViewModel

    func testViewModelLoadReportSuccess() async {
        let mockClient = MockAPIClient()
        let viewModel = await RegressionReportViewModel(apiClient: mockClient)

        let reportJSON = """
        {
            "id": "test-report",
            "report_id": "compiler_precompute",
            "status": "regression",
            "regression_count": 2,
            "total_count": 50,
            "details": {
                "regression": [
                    {
                        "group_info": {"model": "resnet50", "metric": "speedup"},
                        "baseline_point": {"commit": "a", "value": 1.0},
                        "points": [{"commit": "b", "value": 1.3}]
                    },
                    {
                        "group_info": {"model": "bert", "metric": "compile_time"},
                        "baseline_point": {"commit": "c", "value": 5.0},
                        "points": [{"commit": "d", "value": 6.5}]
                    }
                ],
                "suspicious": []
            }
        }
        """
        mockClient.setResponse(reportJSON, for: "/api/benchmark/get_regression_summary_report")

        await viewModel.loadReport(id: "test-report")

        let state = await viewModel.state
        let report = await viewModel.report
        XCTAssertEqual(state, .loaded)
        XCTAssertNotNil(report)
        XCTAssertEqual(report?.id, "test-report")
        XCTAssertEqual(report?.details?.regression?.count, 2)
    }

    func testViewModelLoadReportError() async {
        let mockClient = MockAPIClient()
        let viewModel = await RegressionReportViewModel(apiClient: mockClient)

        mockClient.setError(APIError.notFound, for: "/api/benchmark/get_regression_summary_report")

        await viewModel.loadReport(id: "bad-report")

        let state = await viewModel.state
        let report = await viewModel.report
        switch state {
        case .error:
            break // expected
        default:
            XCTFail("Expected error state, got \(state)")
        }
        XCTAssertNil(report)
    }

    func testViewModelFilterItems() async {
        let mockClient = MockAPIClient()
        let viewModel = await RegressionReportViewModel(apiClient: mockClient)

        let reportJSON = """
        {
            "id": "filter-test",
            "details": {
                "regression": [
                    {
                        "group_info": {"model": "resnet50", "suite": "torchbench"},
                        "baseline_point": {"commit": "a", "value": 1.0},
                        "points": [{"commit": "b", "value": 1.3}]
                    },
                    {
                        "group_info": {"model": "bert", "suite": "huggingface"},
                        "baseline_point": {"commit": "c", "value": 2.0},
                        "points": [{"commit": "d", "value": 2.5}]
                    },
                    {
                        "group_info": {"model": "vit", "suite": "torchbench"},
                        "baseline_point": {"commit": "e", "value": 3.0},
                        "points": [{"commit": "f", "value": 3.2}]
                    }
                ],
                "suspicious": []
            }
        }
        """
        mockClient.setResponse(reportJSON, for: "/api/benchmark/get_regression_summary_report")

        await viewModel.loadReport(id: "filter-test")

        // No filters -> all items
        let allItems = await viewModel.filteredRegressionItems
        XCTAssertEqual(allItems.count, 3)

        // Filter by suite=torchbench -> 2 items
        await viewModel.updateFilter(key: "suite", value: "torchbench")
        let filteredItems = await viewModel.filteredRegressionItems
        XCTAssertEqual(filteredItems.count, 2)

        // Clear filter -> back to all
        await viewModel.updateFilter(key: "suite", value: nil)
        let clearedItems = await viewModel.filteredRegressionItems
        XCTAssertEqual(clearedItems.count, 3)
    }

    func testViewModelFilterSuspiciousItems() async {
        let mockClient = MockAPIClient()
        let viewModel = await RegressionReportViewModel(apiClient: mockClient)

        let reportJSON = """
        {
            "id": "suspicious-test",
            "details": {
                "regression": [],
                "suspicious": [
                    {
                        "group_info": {"model": "mobilenet", "compiler": "inductor"},
                        "baseline_point": {"commit": "a", "value": 1.0},
                        "points": [{"commit": "b", "value": 1.1}]
                    },
                    {
                        "group_info": {"model": "efficientnet", "compiler": "aot_eager"},
                        "baseline_point": {"commit": "c", "value": 2.0},
                        "points": [{"commit": "d", "value": 2.2}]
                    }
                ]
            }
        }
        """
        mockClient.setResponse(reportJSON, for: "/api/benchmark/get_regression_summary_report")

        await viewModel.loadReport(id: "suspicious-test")

        let allSuspicious = await viewModel.filteredSuspiciousItems
        XCTAssertEqual(allSuspicious.count, 2)

        await viewModel.updateFilter(key: "compiler", value: "inductor")
        let filteredSuspicious = await viewModel.filteredSuspiciousItems
        XCTAssertEqual(filteredSuspicious.count, 1)
        XCTAssertEqual(filteredSuspicious.first?.groupInfo?["model"], "mobilenet")
    }

    // MARK: - Edge cases

    func testRegressionDetailItemNilBaselineValue() {
        let json = """
        {
            "group_info": {"model": "test"},
            "baseline_point": {"commit": "abc", "value": null},
            "points": [{"commit": "def", "value": 10.0}]
        }
        """
        let item: RegressionDetailItem = MockData.decode(json)

        // Baseline value is nil -> changePercent should be nil
        XCTAssertNil(item.changePercent)
    }

    func testRegressionDetailItemNilLatestValue() {
        let json = """
        {
            "group_info": {"model": "test"},
            "baseline_point": {"commit": "abc", "value": 10.0},
            "points": [{"commit": "def", "value": null}]
        }
        """
        let item: RegressionDetailItem = MockData.decode(json)

        // Latest value is nil -> changePercent should be nil
        XCTAssertNil(item.changePercent)
    }

    func testRegressionReportMinimalFields() {
        let json = """
        {
            "id": "minimal"
        }
        """
        let report: RegressionReport = MockData.decode(json)

        XCTAssertEqual(report.id, "minimal")
        XCTAssertNil(report.reportId)
        XCTAssertNil(report.createdAt)
        XCTAssertNil(report.lastRecordTs)
        XCTAssertNil(report.lastRecordCommit)
        XCTAssertNil(report.type)
        XCTAssertNil(report.status)
        XCTAssertNil(report.repo)
        XCTAssertNil(report.regressionCount)
        XCTAssertNil(report.insufficientDataCount)
        XCTAssertNil(report.suspectedRegressionCount)
        XCTAssertNil(report.totalCount)
        XCTAssertNil(report.details)
        XCTAssertNil(report.filters)
    }

    // MARK: - API Endpoint tests

    func testRegressionReportsEndpoint() {
        let endpoint = APIEndpoint.regressionReports(reportId: "compiler_precompute")

        XCTAssertEqual(endpoint.path, "/api/benchmark/list_regression_summary_reports")
        XCTAssertEqual(endpoint.method, .POST)
        XCTAssertNotNil(endpoint.body)

        // Verify the body contains the report_id
        if let body = endpoint.body,
           let bodyDict = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            XCTAssertEqual(bodyDict["report_id"] as? String, "compiler_precompute")
            XCTAssertEqual(bodyDict["limit"] as? Int, 10)
        } else {
            XCTFail("Failed to parse endpoint body")
        }
    }

    func testRegressionReportEndpoint() {
        let endpoint = APIEndpoint.regressionReport(id: "test-id-123")

        XCTAssertEqual(endpoint.path, "/api/benchmark/get_regression_summary_report")
        XCTAssertEqual(endpoint.method, .POST)
        XCTAssertNotNil(endpoint.body)

        if let body = endpoint.body,
           let bodyDict = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            XCTAssertEqual(bodyDict["id"] as? String, "test-id-123")
        } else {
            XCTFail("Failed to parse endpoint body")
        }
    }

    func testRegressionReportsEndpointCustomLimit() {
        let endpoint = APIEndpoint.regressionReports(reportId: "test", limit: 25)

        if let body = endpoint.body,
           let bodyDict = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            XCTAssertEqual(bodyDict["limit"] as? Int, 25)
        } else {
            XCTFail("Failed to parse endpoint body")
        }
    }

    // MARK: - Helpers

    private func makeDetailItem(
        model: String = "test_model",
        metric: String = "speedup",
        baselineValue: Double,
        latestValue: Double
    ) -> RegressionDetailItem {
        let json = """
        {
            "group_info": {"model": "\(model)", "metric": "\(metric)"},
            "baseline_point": {"commit": "base123", "value": \(baselineValue), "timestamp": "2025-01-19T00:00:00Z", "branch": "main", "workflow_id": "w1"},
            "points": [{"commit": "latest456", "value": \(latestValue), "timestamp": "2025-01-20T00:00:00Z", "branch": "main", "workflow_id": "w2"}]
        }
        """
        return MockData.decode(json)
    }
}
