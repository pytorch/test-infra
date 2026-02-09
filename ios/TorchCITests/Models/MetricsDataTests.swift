import XCTest
@testable import TorchCI

final class MetricsDataTests: XCTestCase {

    // MARK: - KPIData

    func testKPITrendPercentage() {
        let kpi = KPIData(name: "test", current: 120, previous: 100, target: nil, unit: nil)
        XCTAssertEqual(kpi.trendPercentage ?? 0, 20.0, accuracy: 0.01)
    }

    func testKPITrendPercentageNegative() {
        let kpi = KPIData(name: "test", current: 80, previous: 100, target: nil, unit: nil)
        XCTAssertEqual(kpi.trendPercentage ?? 0, -20.0, accuracy: 0.01)
    }

    func testKPITrendPercentageNilPrevious() {
        let kpi = KPIData(name: "test", current: 100, previous: nil, target: nil, unit: nil)
        XCTAssertNil(kpi.trendPercentage)
    }

    func testKPITrendPercentageZeroPrevious() {
        let kpi = KPIData(name: "test", current: 100, previous: 0, target: nil, unit: nil)
        XCTAssertNil(kpi.trendPercentage)
    }

    func testKPIIsImprovingLowerIsBetter() {
        let improving = KPIData(name: "t", current: 5, previous: 10, target: nil, unit: nil, lowerIsBetter: true)
        XCTAssertTrue(improving.isImproving)

        let worsening = KPIData(name: "t", current: 15, previous: 10, target: nil, unit: nil, lowerIsBetter: true)
        XCTAssertFalse(worsening.isImproving)
    }

    func testKPIIsImprovingHigherIsBetter() {
        let improving = KPIData(name: "t", current: 15, previous: 10, target: nil, unit: nil, lowerIsBetter: false)
        XCTAssertTrue(improving.isImproving)

        let worsening = KPIData(name: "t", current: 5, previous: 10, target: nil, unit: nil, lowerIsBetter: false)
        XCTAssertFalse(worsening.isImproving)
    }

    func testKPIIsImprovingNoPrevious() {
        let kpi = KPIData(name: "t", current: 100, previous: nil, target: nil, unit: nil)
        XCTAssertTrue(kpi.isImproving) // Defaults to true when no previous
    }

    // MARK: - ReliabilityData

    func testReliabilityFailureRate() {
        let json = """
        {"workflow_name": "pull", "total_jobs": 200, "failed_jobs": 10, "broken_trunk": 3, "flaky": 5, "infra": 2}
        """
        let data: ReliabilityData = MockData.decode(json)

        XCTAssertEqual(data.failureRate, 5.0, accuracy: 0.01) // 10/200 * 100
        XCTAssertEqual(data.workflowName, "pull")
        XCTAssertEqual(data.id, "pull")
    }

    func testReliabilityFailureRateZeroTotal() {
        let json = """
        {"workflow_name": "empty", "total_jobs": 0, "failed_jobs": 0}
        """
        let data: ReliabilityData = MockData.decode(json)

        XCTAssertEqual(data.failureRate, 0)
    }

    func testReliabilityNilOptionals() {
        let json = """
        {"workflow_name": "test", "total_jobs": 100, "failed_jobs": 5}
        """
        let data: ReliabilityData = MockData.decode(json)

        XCTAssertNil(data.brokenTrunk)
        XCTAssertNil(data.flaky)
        XCTAssertNil(data.infra)
    }

    // MARK: - TimeSeriesDataPoint

    func testTimeSeriesDecodesGranularityBucket() {
        let json = """
        {"granularity_bucket": "2025-01-15", "value": 42.5}
        """
        let point: TimeSeriesDataPoint = MockData.decode(json)

        XCTAssertEqual(point.granularity_bucket, "2025-01-15")
        XCTAssertEqual(point.value, 42.5)
        XCTAssertNil(point.seriesName)
    }

    func testTimeSeriesDecodesBucketKey() {
        let json = """
        {"bucket": "2025-01-15", "count": 100}
        """
        let point: TimeSeriesDataPoint = MockData.decode(json)

        XCTAssertEqual(point.granularity_bucket, "2025-01-15")
        XCTAssertEqual(point.value, 100)
    }

    func testTimeSeriesDecodesTimeKey() {
        let json = """
        {"time": "2025-01-15T10:00:00Z", "total": 55.5}
        """
        let point: TimeSeriesDataPoint = MockData.decode(json)

        XCTAssertEqual(point.granularity_bucket, "2025-01-15T10:00:00Z")
        XCTAssertEqual(point.value, 55.5)
    }

    func testTimeSeriesDecodesWeekKey() {
        let json = """
        {"week": "2025-W03", "percentage": 12.5}
        """
        let point: TimeSeriesDataPoint = MockData.decode(json)

        XCTAssertEqual(point.granularity_bucket, "2025-W03")
        XCTAssertEqual(point.value, 12.5)
    }

    func testTimeSeriesDecodesDayKey() {
        let json = """
        {"day": "2025-01-15", "count": 42}
        """
        let point: TimeSeriesDataPoint = MockData.decode(json)

        XCTAssertEqual(point.granularity_bucket, "2025-01-15")
        XCTAssertEqual(point.value, 42)
    }

    func testTimeSeriesDecodesCustomValue() {
        let json = """
        {"granularity_bucket": "2025-01-15", "custom": 99.9}
        """
        let point: TimeSeriesDataPoint = MockData.decode(json)

        XCTAssertEqual(point.value, 99.9)
    }

    func testTimeSeriesDecodesP50Value() {
        let json = """
        {"granularity_bucket": "2025-01-15", "p50": 33.3}
        """
        let point: TimeSeriesDataPoint = MockData.decode(json)

        XCTAssertEqual(point.value, 33.3)
    }

    func testTimeSeriesDecodesDurationSec() {
        let json = """
        {"granularity_bucket": "2025-01-15", "duration_sec": 3600}
        """
        let point: TimeSeriesDataPoint = MockData.decode(json)

        XCTAssertEqual(point.value, 3600)
    }

    func testTimeSeriesDecodesStringEncodedValue() {
        let json = """
        {"granularity_bucket": "2025-01-15", "value": "42.5"}
        """
        let point: TimeSeriesDataPoint = MockData.decode(json)

        XCTAssertEqual(point.value, 42.5)
    }

    func testTimeSeriesDecodesIntValue() {
        let json = """
        {"granularity_bucket": "2025-01-15", "count": 42}
        """
        let point: TimeSeriesDataPoint = MockData.decode(json)

        XCTAssertEqual(point.value, 42)
    }

    func testTimeSeriesDecodesSeriesName() {
        let json = """
        {"granularity_bucket": "2025-01-15", "value": 10, "name": "Total"}
        """
        let point: TimeSeriesDataPoint = MockData.decode(json)

        XCTAssertEqual(point.seriesName, "Total")
        XCTAssertEqual(point.id, "2025-01-15Total")
    }

    func testTimeSeriesDecodesCodeAsSeriesName() {
        let json = """
        {"granularity_bucket": "2025-01-15", "value": 10, "code": "SEG_FAULT"}
        """
        let point: TimeSeriesDataPoint = MockData.decode(json)

        XCTAssertEqual(point.seriesName, "SEG_FAULT")
    }

    func testTimeSeriesNoValueReturnsNil() {
        let json = """
        {"granularity_bucket": "2025-01-15"}
        """
        let point: TimeSeriesDataPoint = MockData.decode(json)

        XCTAssertNil(point.value)
    }

    func testTimeSeriesEmptyBucketDefaultsToEmpty() {
        let json = """
        {"value": 10}
        """
        let point: TimeSeriesDataPoint = MockData.decode(json)

        XCTAssertEqual(point.granularity_bucket, "")
    }

    func testTimeSeriesDateParsing() {
        let isoPoint = TimeSeriesDataPoint(granularity_bucket: "2025-01-15T10:30:00Z", value: 1)
        XCTAssertNotNil(isoPoint.date)

        let dateOnlyPoint = TimeSeriesDataPoint(granularity_bucket: "2025-01-15", value: 1)
        XCTAssertNotNil(dateOnlyPoint.date)

        let isoFractional = TimeSeriesDataPoint(granularity_bucket: "2025-01-15T10:30:00.123Z", value: 1)
        XCTAssertNotNil(isoFractional.date)
    }

    func testTimeSeriesDirectInit() {
        let point = TimeSeriesDataPoint(granularity_bucket: "2025-01-01", value: 42.0, seriesName: "test")
        XCTAssertEqual(point.granularity_bucket, "2025-01-01")
        XCTAssertEqual(point.value, 42.0)
        XCTAssertEqual(point.seriesName, "test")
    }

    // MARK: - TimeGranularity

    func testTimeGranularityDisplayName() {
        XCTAssertEqual(TimeGranularity.hour.displayName, "Hour")
        XCTAssertEqual(TimeGranularity.day.displayName, "Day")
        XCTAssertEqual(TimeGranularity.week.displayName, "Week")
    }

    func testTimeGranularityRawValue() {
        XCTAssertEqual(TimeGranularity.hour.rawValue, "hour")
        XCTAssertEqual(TimeGranularity.day.rawValue, "day")
        XCTAssertEqual(TimeGranularity.week.rawValue, "week")
    }

    // MARK: - TimeRange Presets

    func testTimeRangePresets() {
        XCTAssertEqual(TimeRange.presets.count, 7)
        XCTAssertEqual(TimeRange.presets.first?.id, "1d")
        XCTAssertEqual(TimeRange.presets.last?.id, "180d")
    }

    func testTimeRangePresetDays() {
        let preset14d = TimeRange.presets.first { $0.id == "14d" }
        XCTAssertEqual(preset14d?.days, 14)
        XCTAssertEqual(preset14d?.label, "2 Weeks")
    }

    // MARK: - MetricSummary

    func testMetricSummaryDecoding() {
        let json = """
        {"name": "TTRS P50", "value": 25.5, "unit": "min", "trend": -5.2}
        """
        let summary: MetricSummary = MockData.decode(json)

        XCTAssertEqual(summary.name, "TTRS P50")
        XCTAssertEqual(summary.value, 25.5)
        XCTAssertEqual(summary.unit, "min")
        XCTAssertEqual(summary.trend, -5.2)
    }

    // MARK: - Value Priority Order

    func testTimeSeriesValuePriorityCustomOverCount() {
        // When both "custom" and "count" are present, "custom" should win
        let json = """
        {"granularity_bucket": "2025-01-15", "custom": 99.9, "count": 42}
        """
        let point: TimeSeriesDataPoint = MockData.decode(json)

        XCTAssertEqual(point.value, 99.9) // custom wins over count
    }

    func testTimeSeriesValuePriorityValueOverAll() {
        // "value" key takes highest priority
        let json = """
        {"granularity_bucket": "2025-01-15", "value": 1.0, "custom": 2.0, "count": 3.0}
        """
        let point: TimeSeriesDataPoint = MockData.decode(json)

        XCTAssertEqual(point.value, 1.0)
    }
}
