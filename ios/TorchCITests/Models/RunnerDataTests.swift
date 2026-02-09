import XCTest
@testable import TorchCI

final class RunnerDataTests: XCTestCase {

    // MARK: - Runner

    func testRunnerOnlineIdle() {
        let json = """
        {"id": 1, "name": "runner-1", "os": "linux", "status": "online", "busy": false, "labels": []}
        """
        let runner: Runner = MockData.decode(json)

        XCTAssertTrue(runner.isOnline)
        XCTAssertFalse(runner.isBusy)
        XCTAssertEqual(runner.statusDisplay, "Idle")
        XCTAssertEqual(runner.statusColor, "green")
    }

    func testRunnerOnlineBusy() {
        let json = """
        {"id": 2, "name": "runner-2", "os": "linux", "status": "online", "busy": true, "labels": []}
        """
        let runner: Runner = MockData.decode(json)

        XCTAssertTrue(runner.isOnline)
        XCTAssertTrue(runner.isBusy)
        XCTAssertEqual(runner.statusDisplay, "Busy")
        XCTAssertEqual(runner.statusColor, "orange")
    }

    func testRunnerOffline() {
        let json = """
        {"id": 3, "name": "runner-3", "os": "linux", "status": "offline", "busy": false, "labels": []}
        """
        let runner: Runner = MockData.decode(json)

        XCTAssertFalse(runner.isOnline)
        XCTAssertFalse(runner.isBusy)
        XCTAssertEqual(runner.statusDisplay, "Offline")
        XCTAssertEqual(runner.statusColor, "gray")
    }

    func testRunnerNilStatus() {
        let json = """
        {"id": 4, "name": "runner-4", "os": null, "status": null, "busy": null, "labels": null}
        """
        let runner: Runner = MockData.decode(json)

        XCTAssertFalse(runner.isOnline)
        XCTAssertFalse(runner.isBusy)
        XCTAssertEqual(runner.statusDisplay, "Offline")
        XCTAssertNil(runner.os)
    }

    func testRunnerLabels() {
        let json = """
        {
            "id": 5,
            "name": "runner-5",
            "os": "linux",
            "status": "online",
            "busy": false,
            "labels": [
                {"id": 1, "name": "linux.2xlarge", "type": "custom"},
                {"id": null, "name": "self-hosted", "type": "read-only"}
            ]
        }
        """
        let runner: Runner = MockData.decode(json)

        XCTAssertEqual(runner.labels?.count, 2)
        XCTAssertEqual(runner.labels?.first?.name, "linux.2xlarge")
        XCTAssertEqual(runner.labels?.first?.id, "1")
        XCTAssertEqual(runner.labels?.last?.id, "self-hosted") // Falls back to name when id is nil
    }

    // MARK: - RunnerGroup via JSON

    func testRunnerGroupDecoding() {
        let json = """
        {
            "label": "linux.2xlarge",
            "totalCount": 100,
            "idleCount": 60,
            "busyCount": 30,
            "offlineCount": 10,
            "runners": [
                {"id": 1, "name": "r1", "os": "linux", "status": "online", "busy": false, "labels": []}
            ]
        }
        """
        let group: RunnerGroup = MockData.decode(json)

        XCTAssertEqual(group.name, "linux.2xlarge")
        XCTAssertEqual(group.id, "linux.2xlarge")
        XCTAssertEqual(group.totalCount, 100)
        XCTAssertEqual(group.idleCount, 60)
        XCTAssertEqual(group.busyCount, 30)
        XCTAssertEqual(group.offlineCount, 10)
        XCTAssertEqual(group.onlineCount, 90) // idle + busy
        XCTAssertEqual(group.runners.count, 1)
    }

    // MARK: - RunnerGroup Convenience Init

    func testRunnerGroupConvenienceInit() {
        let runners = [
            makeRunner(id: 1, status: "online", busy: false),
            makeRunner(id: 2, status: "online", busy: true),
            makeRunner(id: 3, status: "online", busy: true),
            makeRunner(id: 4, status: "offline", busy: false),
        ]

        let group = RunnerGroup(name: "test-group", runners: runners)

        XCTAssertEqual(group.name, "test-group")
        XCTAssertEqual(group.totalCount, 4)
        XCTAssertEqual(group.idleCount, 1) // online and not busy
        XCTAssertEqual(group.busyCount, 2)
        XCTAssertEqual(group.offlineCount, 1)
        XCTAssertEqual(group.onlineCount, 3) // idle + busy
    }

    func testRunnerGroupConvenienceInitEmpty() {
        let group = RunnerGroup(name: "empty", runners: [])

        XCTAssertEqual(group.totalCount, 0)
        XCTAssertEqual(group.idleCount, 0)
        XCTAssertEqual(group.busyCount, 0)
        XCTAssertEqual(group.offlineCount, 0)
    }

    // MARK: - RunnersResponse

    func testRunnersResponseDecoding() {
        let json = """
        {
            "groups": [
                {
                    "label": "linux.2xlarge",
                    "totalCount": 50,
                    "idleCount": 30,
                    "busyCount": 15,
                    "offlineCount": 5,
                    "runners": []
                }
            ],
            "totalRunners": 50
        }
        """
        let response: RunnersResponse = MockData.decode(json)

        XCTAssertEqual(response.groups.count, 1)
        XCTAssertEqual(response.totalRunners, 50)
    }

    func testRunnersResponseNilTotal() {
        let json = """
        {
            "groups": [],
            "totalRunners": null
        }
        """
        let response: RunnersResponse = MockData.decode(json)

        XCTAssertNil(response.totalRunners)
        XCTAssertTrue(response.groups.isEmpty)
    }

    // MARK: - Helpers

    private func makeRunner(id: Int, status: String, busy: Bool) -> Runner {
        let json = """
        {"id": \(id), "name": "r-\(id)", "os": "linux", "status": "\(status)", "busy": \(busy), "labels": []}
        """
        return MockData.decode(json)
    }
}
