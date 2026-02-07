import Foundation

/// A generic time series data point decoded from clickhouse query responses.
/// The clickhouse API returns JSON arrays of objects with varying field names
/// depending on the query. This model flexibly decodes common patterns:
/// - Time bucket: `granularity_bucket`, `bucket`, `time`, `date`, `week`
/// - Value: `value`, `count`, `total`, `percentage`, `avg`, `p50`, `p75`, `p90`, `red`
struct TimeSeriesDataPoint: Decodable, Identifiable {
    let granularity_bucket: String
    let value: Double?

    var id: String { granularity_bucket }

    var date: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: granularity_bucket) {
            return date
        }
        // Try without fractional seconds
        let fallback = ISO8601DateFormatter()
        if let date = fallback.date(from: granularity_bucket) {
            return date
        }
        // Try date-only format
        let dateOnly = DateFormatter()
        dateOnly.dateFormat = "yyyy-MM-dd"
        dateOnly.timeZone = TimeZone(identifier: "UTC")
        return dateOnly.date(from: granularity_bucket)
    }

    enum CodingKeys: String, CodingKey {
        // Time bucket keys
        case granularity_bucket
        case bucket
        case time
        case date
        case week
        case week_bucket
        case day
        case push_time
        case year_and_month
        // Value keys
        case value
        case count
        case total
        case percentage
        case avg
        case p50
        case p75
        case p90
        case red
        case num
        case metric
        case ttrs_mins
        case avg_tts
        case diff_hr
        case pr_count
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        // Decode time bucket - try multiple possible keys
        if let bucket = try container.decodeIfPresent(String.self, forKey: .granularity_bucket) {
            granularity_bucket = bucket
        } else if let bucket = try container.decodeIfPresent(String.self, forKey: .bucket) {
            granularity_bucket = bucket
        } else if let bucket = try container.decodeIfPresent(String.self, forKey: .time) {
            granularity_bucket = bucket
        } else if let bucket = try container.decodeIfPresent(String.self, forKey: .date) {
            granularity_bucket = bucket
        } else if let bucket = try container.decodeIfPresent(String.self, forKey: .week) {
            granularity_bucket = bucket
        } else if let bucket = try container.decodeIfPresent(String.self, forKey: .week_bucket) {
            granularity_bucket = bucket
        } else if let bucket = try container.decodeIfPresent(String.self, forKey: .day) {
            granularity_bucket = bucket
        } else if let bucket = try container.decodeIfPresent(String.self, forKey: .push_time) {
            granularity_bucket = bucket
        } else if let bucket = try container.decodeIfPresent(String.self, forKey: .year_and_month) {
            granularity_bucket = bucket
        } else {
            granularity_bucket = ""
        }

        // Decode value - try multiple possible keys, handling both Double and String representations
        if let v = Self.decodeDouble(container: container, key: .value) {
            value = v
        } else if let v = Self.decodeDouble(container: container, key: .count) {
            value = v
        } else if let v = Self.decodeDouble(container: container, key: .total) {
            value = v
        } else if let v = Self.decodeDouble(container: container, key: .percentage) {
            value = v
        } else if let v = Self.decodeDouble(container: container, key: .avg) {
            value = v
        } else if let v = Self.decodeDouble(container: container, key: .p50) {
            value = v
        } else if let v = Self.decodeDouble(container: container, key: .p75) {
            value = v
        } else if let v = Self.decodeDouble(container: container, key: .p90) {
            value = v
        } else if let v = Self.decodeDouble(container: container, key: .red) {
            value = v
        } else if let v = Self.decodeDouble(container: container, key: .num) {
            value = v
        } else if let v = Self.decodeDouble(container: container, key: .metric) {
            value = v
        } else if let v = Self.decodeDouble(container: container, key: .ttrs_mins) {
            value = v
        } else if let v = Self.decodeDouble(container: container, key: .avg_tts) {
            value = v
        } else if let v = Self.decodeDouble(container: container, key: .diff_hr) {
            value = v
        } else if let v = Self.decodeDouble(container: container, key: .pr_count) {
            value = v
        } else {
            value = nil
        }
    }

    /// Try to decode a Double from the given key, handling both numeric and string-encoded values.
    private static func decodeDouble(container: KeyedDecodingContainer<CodingKeys>, key: CodingKeys) -> Double? {
        if let v = try? container.decodeIfPresent(Double.self, forKey: key) {
            return v
        }
        if let s = try? container.decodeIfPresent(String.self, forKey: key), let v = Double(s) {
            return v
        }
        if let v = try? container.decodeIfPresent(Int.self, forKey: key) {
            return Double(v)
        }
        return nil
    }

    /// Direct initializer for previews and testing.
    init(granularity_bucket: String, value: Double?) {
        self.granularity_bucket = granularity_bucket
        self.value = value
    }
}

struct MetricSummary: Decodable {
    let name: String
    let value: Double
    let unit: String?
    let trend: Double?
}

struct KPIData: Decodable {
    let name: String
    let current: Double
    let previous: Double?
    let target: Double?
    let unit: String?
    let lowerIsBetter: Bool

    var trendPercentage: Double? {
        guard let previous, previous != 0 else { return nil }
        return ((current - previous) / previous) * 100
    }

    var isImproving: Bool {
        guard let previous else { return true }
        if lowerIsBetter {
            return current < previous
        } else {
            return current > previous
        }
    }

    init(name: String, current: Double, previous: Double?, target: Double?, unit: String?, lowerIsBetter: Bool = true) {
        self.name = name
        self.current = current
        self.previous = previous
        self.target = target
        self.unit = unit
        self.lowerIsBetter = lowerIsBetter
    }
}

struct ReliabilityData: Decodable, Identifiable {
    let workflowName: String
    let totalJobs: Int
    let failedJobs: Int
    let brokenTrunk: Int?
    let flaky: Int?
    let infra: Int?

    var id: String { workflowName }

    var failureRate: Double {
        guard totalJobs > 0 else { return 0 }
        return Double(failedJobs) / Double(totalJobs) * 100
    }

    enum CodingKeys: String, CodingKey {
        case workflowName = "workflow_name"
        case totalJobs = "total_jobs"
        case failedJobs = "failed_jobs"
        case brokenTrunk = "broken_trunk"
        case flaky, infra
    }
}

struct AutorevertMetrics: Decodable {
    let summary: AutorevertSummary
    let weeklyMetrics: [WeeklyMetric]?
    let significantReverts: [SignificantRevert]?
    let falsePositives: FalsePositivesData?
}

struct AutorevertSummary: Decodable {
    let totalAutoreverts: Int?
    let truePositives: Int?
    let tpWithSignalRecovery: Int?
    let tpWithoutSignalRecovery: Int?
    let confirmedFalsePositives: Int?
    let falseNegatives: Int?
    let precision: Double?
    let recall: Double?
    let totalRevertRecoveries: Int?

    enum CodingKeys: String, CodingKey {
        case totalAutoreverts = "total_autoreverts"
        case truePositives = "true_positives"
        case tpWithSignalRecovery = "tp_with_signal_recovery"
        case tpWithoutSignalRecovery = "tp_without_signal_recovery"
        case confirmedFalsePositives = "confirmed_false_positives"
        case falseNegatives = "false_negatives"
        case precision, recall
        case totalRevertRecoveries = "total_revert_recoveries"
    }
}

struct WeeklyMetric: Decodable, Identifiable {
    let week: String
    let precision: Double?
    let recall: Double?
    let falsePositives: Int?
    let autorevertRecoveries: Int?
    let humanRevertRecoveries: Int?
    let nonRevertRecoveries: Int?

    var id: String { week }

    enum CodingKeys: String, CodingKey {
        case week, precision, recall
        case falsePositives = "false_positives"
        case autorevertRecoveries = "autorevert_recoveries"
        case humanRevertRecoveries = "human_revert_recoveries"
        case nonRevertRecoveries = "non_revert_recoveries"
    }
}

struct SignificantRevert: Decodable, Identifiable {
    let recoverySha: String
    let recoveryTime: String
    let signalKeys: [String]?
    let signalsFixed: Int
    let maxRedStreakLength: Int
    let revertedPrNumbers: [String]?
    let recoveryType: String
    let isAutorevert: Bool

    var id: String { recoverySha }

    var isTP: Bool { recoveryType == "autorevert_recovery" }
    var isFN: Bool { recoveryType == "human_revert_recovery" }

    enum CodingKeys: String, CodingKey {
        case recoverySha = "recovery_sha"
        case recoveryTime = "recovery_time"
        case signalKeys = "signal_keys"
        case signalsFixed = "signals_fixed"
        case maxRedStreakLength = "max_red_streak_length"
        case revertedPrNumbers = "reverted_pr_numbers"
        case recoveryType = "recovery_type"
        case isAutorevert = "is_autorevert"
    }
}

struct FalsePositivesData: Decodable {
    let candidatesChecked: Int
    let confirmed: [FalsePositive]?
    let legitReverts: [FalsePositive]?

    enum CodingKeys: String, CodingKey {
        case candidatesChecked = "candidates_checked"
        case confirmed
        case legitReverts = "legit_reverts"
    }
}

struct FalsePositive: Decodable, Identifiable {
    let revertedSha: String
    let autorevertTime: String
    let prNumber: String
    let commitsAfterRevert: Int
    let verificationStatus: String
    let verificationReason: String
    let sourceSignalKeys: [String]?

    var id: String { revertedSha }

    var isConfirmedFP: Bool { verificationStatus == "confirmed_fp" }

    enum CodingKeys: String, CodingKey {
        case revertedSha = "reverted_sha"
        case autorevertTime = "autorevert_time"
        case prNumber = "pr_number"
        case commitsAfterRevert = "commits_after_revert"
        case verificationStatus = "verification_status"
        case verificationReason = "verification_reason"
        case sourceSignalKeys = "source_signal_keys"
    }
}

enum TimeGranularity: String, CaseIterable {
    case hour, day, week

    var displayName: String { rawValue.capitalized }
}

struct TimeRange: Identifiable {
    let id: String
    let label: String
    let days: Int

    static let presets: [TimeRange] = [
        TimeRange(id: "1d", label: "1 Day", days: 1),
        TimeRange(id: "3d", label: "3 Days", days: 3),
        TimeRange(id: "7d", label: "1 Week", days: 7),
        TimeRange(id: "14d", label: "2 Weeks", days: 14),
        TimeRange(id: "30d", label: "1 Month", days: 30),
        TimeRange(id: "90d", label: "3 Months", days: 90),
        TimeRange(id: "180d", label: "6 Months", days: 180),
    ]
}
