import XCTest
@testable import TorchCI

final class DurationFormatterTests: XCTestCase {

    // MARK: - Zero and Negative

    func testZeroSeconds() {
        XCTAssertEqual(DurationFormatter.format(0), "0s")
    }

    func testNegativeSeconds() {
        XCTAssertEqual(DurationFormatter.format(-1), "0s")
        XCTAssertEqual(DurationFormatter.format(-100), "0s")
    }

    // MARK: - Seconds Only

    func testOneSecond() {
        XCTAssertEqual(DurationFormatter.format(1), "1s")
    }

    func testFiftyNineSeconds() {
        XCTAssertEqual(DurationFormatter.format(59), "59s")
    }

    // MARK: - Minutes and Seconds

    func testOneMinute() {
        XCTAssertEqual(DurationFormatter.format(60), "1m 0s")
    }

    func testOneMinuteThirtySeconds() {
        XCTAssertEqual(DurationFormatter.format(90), "1m 30s")
    }

    func testFiftyNineMinutes() {
        XCTAssertEqual(DurationFormatter.format(3599), "59m 59s")
    }

    // MARK: - Hours

    func testOneHour() {
        XCTAssertEqual(DurationFormatter.format(3600), "1h 0m")
    }

    func testOneHourThirtyMinutes() {
        XCTAssertEqual(DurationFormatter.format(5400), "1h 30m")
    }

    func testTwentyFourHours() {
        XCTAssertEqual(DurationFormatter.format(86400), "24h 0m")
    }

    func testLargeDuration() {
        // 48 hours + 30 minutes
        XCTAssertEqual(DurationFormatter.format(174600), "48h 30m")
    }

    // MARK: - Compact Mode

    func testCompactZero() {
        XCTAssertEqual(DurationFormatter.format(0, compact: true), "0s")
    }

    func testCompactSeconds() {
        XCTAssertEqual(DurationFormatter.format(45, compact: true), "45s")
    }

    func testCompactMinutes() {
        // Compact mode omits seconds for minute-level durations
        XCTAssertEqual(DurationFormatter.format(90, compact: true), "1m")
    }

    func testCompactHoursAndMinutes() {
        XCTAssertEqual(DurationFormatter.format(5400, compact: true), "1h 30m")
    }

    func testCompactHoursOnly() {
        // Exactly 2 hours, compact should show "2h" without minutes
        XCTAssertEqual(DurationFormatter.format(7200, compact: true), "2h")
    }

    func testCompactHoursWithMinutes() {
        // 2 hours and 15 minutes
        XCTAssertEqual(DurationFormatter.format(8100, compact: true), "2h 15m")
    }
}
