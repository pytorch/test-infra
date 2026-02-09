import XCTest
@testable import TorchCI

final class UtilizationDataTests: XCTestCase {

    // MARK: - UtilizationReport

    func testUtilizationReportDecoding() {
        let json = """
        {
            "group_key": "pull",
            "parent_group": "pytorch",
            "time_group": "2025-01",
            "total_runs": 500,
            "metrics": {"cpu_avg": 65.5, "memory_avg": 45.2}
        }
        """
        let report: UtilizationReport = MockData.decode(json)

        XCTAssertEqual(report.name, "pull")
        XCTAssertEqual(report.id, "pull")
        XCTAssertEqual(report.parentGroup, "pytorch")
        XCTAssertEqual(report.timeGroup, "2025-01")
        XCTAssertEqual(report.totalJobs, 500)
        XCTAssertEqual(report.avgCpu, 65.5)
        XCTAssertEqual(report.avgMemory, 45.2)
    }

    func testUtilizationReportCPUFallbackToP90() {
        let json = """
        {
            "group_key": "test",
            "total_runs": 10,
            "metrics": {"cpu_p90": 80.0, "memory_p90": 55.0}
        }
        """
        let report: UtilizationReport = MockData.decode(json)

        XCTAssertEqual(report.avgCpu, 80.0) // Falls back to cpu_p90
        XCTAssertEqual(report.avgMemory, 55.0) // Falls back to memory_p90
    }

    func testUtilizationReportNilMetrics() {
        let json = """
        {
            "group_key": "test",
            "total_runs": 10,
            "metrics": null
        }
        """
        let report: UtilizationReport = MockData.decode(json)

        XCTAssertNil(report.avgCpu)
        XCTAssertNil(report.avgMemory)
        XCTAssertEqual(report.cpuFormatted, "N/A")
        XCTAssertEqual(report.memoryFormatted, "N/A")
    }

    func testUtilizationReportFormatted() {
        let json = """
        {
            "group_key": "test",
            "total_runs": 10,
            "metrics": {"cpu_avg": 75.123, "memory_avg": 42.789}
        }
        """
        let report: UtilizationReport = MockData.decode(json)

        XCTAssertEqual(report.cpuFormatted, "75.1%")
        XCTAssertEqual(report.memoryFormatted, "42.8%")
    }

    func testUtilizationReportNilOptionals() {
        let json = """
        {
            "group_key": "test",
            "parent_group": null,
            "time_group": null,
            "total_runs": null,
            "metrics": null
        }
        """
        let report: UtilizationReport = MockData.decode(json)

        XCTAssertNil(report.parentGroup)
        XCTAssertNil(report.timeGroup)
        XCTAssertNil(report.totalJobs)
    }

    // MARK: - UtilizationReportResponse

    func testUtilizationReportResponseDecoding() {
        let json = """
        {
            "group_key": "workflow_name",
            "metadata_list": [
                {"group_key": "pull", "total_runs": 100, "metrics": {"cpu_avg": 50}},
                {"group_key": "trunk", "total_runs": 200, "metrics": {"cpu_avg": 60}}
            ]
        }
        """
        let response: UtilizationReportResponse = MockData.decode(json)

        XCTAssertEqual(response.groupKey, "workflow_name")
        XCTAssertEqual(response.metadataList?.count, 2)
    }

    func testUtilizationReportResponseNilList() {
        let json = """
        {"group_key": "test", "metadata_list": null}
        """
        let response: UtilizationReportResponse = MockData.decode(json)

        XCTAssertNil(response.metadataList)
    }

    // MARK: - UtilizationPoint

    func testUtilizationPointDecoding() {
        let json = """
        {"time": "2025-01-15T10:00:00Z", "value": 75.5}
        """
        let point: UtilizationPoint = MockData.decode(json)

        XCTAssertEqual(point.time, "2025-01-15T10:00:00Z")
        XCTAssertEqual(point.value, 75.5)
        XCTAssertEqual(point.id, "2025-01-15T10:00:00Z")
    }

    // MARK: - UtilizationMetadataInfo

    func testUtilizationMetadataInfoDecoding() {
        let json = """
        {
            "workflow_id": "12345",
            "job_id": "67890",
            "attempt": "1",
            "job_name": "linux-build",
            "time": "2025-01-15T10:00:00Z"
        }
        """
        let info: UtilizationMetadataInfo = MockData.decode(json)

        XCTAssertEqual(info.workflowId, "12345")
        XCTAssertEqual(info.jobId, "67890")
        XCTAssertEqual(info.attempt, "1")
        XCTAssertEqual(info.jobName, "linux-build")
        XCTAssertEqual(info.time, "2025-01-15T10:00:00Z")
        XCTAssertEqual(info.id, "12345-67890-1")
    }

    // MARK: - JobUtilization

    func testJobUtilizationDecoding() {
        let json = """
        {
            "workflow_id": "12345",
            "job_id": "67890",
            "attempt": "1",
            "cpu_time_series": [{"time": "t1", "value": 50.0}],
            "memory_time_series": [{"time": "t1", "value": 30.0}],
            "disk_time_series": null
        }
        """
        let utilization: JobUtilization = MockData.decode(json)

        XCTAssertEqual(utilization.workflowId, "12345")
        XCTAssertEqual(utilization.cpuTimeSeries?.count, 1)
        XCTAssertEqual(utilization.memoryTimeSeries?.count, 1)
        XCTAssertNil(utilization.diskTimeSeries)
    }

    // MARK: - SimilarFailureResult

    func testSimilarFailureResultDecoding() {
        let json = """
        {
            "totalCount": 42,
            "jobCount": {"linux-build": 10, "win-build": 5},
            "samples": []
        }
        """
        let result: SimilarFailureResult = MockData.decode(json)

        XCTAssertEqual(result.totalCount, 42)
        XCTAssertEqual(result.jobCount?["linux-build"], 10)
        XCTAssertTrue(result.samples?.isEmpty ?? false)
    }

    // MARK: - FailureSearchResult

    func testFailureSearchResultDecoding() {
        let json = """
        {"jobs": []}
        """
        let result: FailureSearchResult = MockData.decode(json)

        XCTAssertTrue(result.jobs?.isEmpty ?? false)
    }

    func testFailureSearchResultNilJobs() {
        let json = """
        {"jobs": null}
        """
        let result: FailureSearchResult = MockData.decode(json)

        XCTAssertNil(result.jobs)
    }
}
