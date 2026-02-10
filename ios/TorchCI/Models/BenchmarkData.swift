import Foundation

struct BenchmarkMetadata: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let description: String?
    let suites: [String]?
    let lastUpdated: String?

    enum CodingKeys: String, CodingKey {
        case id, name, description, suites
        case lastUpdated = "last_updated"
    }
}

struct BenchmarkTimeSeriesPoint: Decodable, Identifiable, Sendable {
    let commit: String
    let commitDate: String?
    let value: Double
    let metric: String?
    let model: String?

    var id: String { "\(commit)-\(metric ?? "")-\(model ?? "")" }

    enum CodingKeys: String, CodingKey {
        case commit, value, metric, model
        case commitDate = "commit_date"
    }

    init(commit: String, commitDate: String?, value: Double, metric: String?, model: String?) {
        self.commit = commit
        self.commitDate = commitDate
        self.value = value
        self.metric = metric
        self.model = model
    }
}

struct BenchmarkGroupData: Decodable, Sendable {
    let data: [BenchmarkDataPoint]
    let metadata: BenchmarkGroupMetadata?

    init(data: [BenchmarkDataPoint], metadata: BenchmarkGroupMetadata?) {
        self.data = data
        self.metadata = metadata
    }
}

struct BenchmarkDataPoint: Decodable, Identifiable, Sendable {
    let name: String
    let metric: String?
    let value: Double
    let baseline: Double?
    let speedup: Double?
    let status: String?

    var id: String { "\(name)-\(metric ?? "")" }

    var changePercent: Double? {
        guard let baseline, baseline != 0 else { return nil }
        return ((value - baseline) / baseline) * 100
    }

    var isRegression: Bool {
        guard let speedup else { return false }
        return speedup < 0.95
    }

    init(name: String, metric: String?, value: Double, baseline: Double?, speedup: Double?, status: String?) {
        self.name = name
        self.metric = metric
        self.value = value
        self.baseline = baseline
        self.speedup = speedup
        self.status = status
    }
}

struct BenchmarkGroupMetadata: Decodable, Sendable {
    let suite: String?
    let compiler: String?
    let mode: String?
    let dtype: String?
    let device: String?
    let branch: String?
    let commit: String?
}

struct RegressionReport: Decodable, Identifiable, Sendable {
    let id: String
    let reportId: String?
    let createdAt: String?
    let lastRecordTs: String?
    let lastRecordCommit: String?
    let type: String?
    let status: String?
    let repo: String?
    let regressionCount: Int?
    let insufficientDataCount: Int?
    let suspectedRegressionCount: Int?
    let totalCount: Int?
    let details: RegressionReportDetails?
    let filters: [String: [String]]?

    enum CodingKeys: String, CodingKey {
        case id
        case reportId = "report_id"
        case createdAt = "created_at"
        case lastRecordTs = "last_record_ts"
        case lastRecordCommit = "last_record_commit"
        case type, status, repo
        case regressionCount = "regression_count"
        case insufficientDataCount = "insufficient_data_count"
        case suspectedRegressionCount = "suspected_regression_count"
        case totalCount = "total_count"
        case details, filters
    }
}

struct RegressionReportDetails: Decodable, Sendable {
    let regression: [RegressionDetailItem]?
    let suspicious: [RegressionDetailItem]?
}

struct RegressionDetailItem: Decodable, Identifiable, Sendable {
    let groupInfo: [String: String]?
    let baselinePoint: RegressionPoint?
    let points: [RegressionPoint]?

    var id: String {
        let info = groupInfo?.sorted(by: { $0.key < $1.key })
            .map { "\($0.key):\($0.value)" }
            .joined(separator: ",") ?? ""
        return info
    }

    var latestPoint: RegressionPoint? {
        points?.last
    }

    var changePercent: Double? {
        guard let baseline = baselinePoint?.value,
              let latest = latestPoint?.value,
              baseline != 0 else { return nil }
        return ((latest - baseline) / baseline) * 100
    }

    enum CodingKeys: String, CodingKey {
        case groupInfo = "group_info"
        case baselinePoint = "baseline_point"
        case points
    }
}

struct RegressionPoint: Decodable, Sendable {
    let commit: String?
    let value: Double?
    let timestamp: String?
    let branch: String?
    let workflowId: String?

    enum CodingKeys: String, CodingKey {
        case commit, value, timestamp, branch
        case workflowId = "workflow_id"
    }
}

// MARK: - API Response Wrappers

/// Response from POST /api/benchmark/get_time_series
/// The API returns `{ data: { time_series: [...] }, time_range: {...}, total_raw_rows: N }`.
/// Each time_series entry is a group with `group_info`, `data` array, etc.
struct BenchmarkTimeSeriesResponse: Decodable, Sendable {
    let data: BenchmarkTimeSeriesResponseData?
    let timeRange: BenchmarkTimeRange?
    let totalRawRows: Int?

    enum CodingKeys: String, CodingKey {
        case data
        case timeRange = "time_range"
        case totalRawRows = "total_raw_rows"
    }

    /// Flatten the nested time series groups into a simple array of points for charting.
    var flattenedTimeSeries: [BenchmarkTimeSeriesPoint] {
        guard let groups = data?.timeSeries else { return [] }
        var points: [BenchmarkTimeSeriesPoint] = []
        for group in groups {
            let groupInfo = group.groupInfo ?? [:]
            let groupModel = groupInfo["model"] ?? groupInfo["name"]
            let groupMetric = groupInfo["metric"]
            for item in group.data ?? [] {
                let commit = item.string("commit")
                    ?? item.string("head_sha")
                    ?? ""
                let date = item.string("granularity_bucket")
                    ?? item.string("date")
                    ?? item.string("commit_date")
                let value: Double
                if let v = item.double("actual") {
                    value = v
                } else if let v = item.double("value") {
                    value = v
                } else {
                    continue
                }

                let pointModel = item.string("model") ?? groupModel
                let pointMetric = item.string("metric") ?? groupMetric

                points.append(BenchmarkTimeSeriesPoint(
                    commit: commit,
                    commitDate: date,
                    value: value,
                    metric: pointMetric,
                    model: pointModel
                ))
            }
        }
        return points
    }
}

struct BenchmarkTimeSeriesResponseData: Decodable, Sendable {
    let timeSeries: [BenchmarkTimeSeriesGroup]?

    enum CodingKeys: String, CodingKey {
        case timeSeries = "time_series"
    }
}

struct BenchmarkTimeSeriesGroup: Decodable, Sendable {
    let groupInfo: [String: String]?
    let data: [[String: AnyCodable]]?

    enum CodingKeys: String, CodingKey {
        case groupInfo = "group_info"
        case data
    }
}

struct BenchmarkTimeRange: Decodable, Sendable {
    let start: String?
    let end: String?
}

/// Response from POST /api/benchmark/list_metadata
/// The API returns `{ data: [...] }`.
struct BenchmarkMetadataResponse: Decodable, Sendable {
    let data: [BenchmarkFilterOption]?
}

struct BenchmarkFilterOption: Decodable, Identifiable, Sendable {
    let name: String?
    let values: [String]?

    var id: String { name ?? values?.joined(separator: ",") ?? "unknown" }
}

/// Response from POST /api/benchmark/list_regression_summary_reports
/// The API returns `{ reports: [...], next_cursor: ... }`.
struct RegressionReportListResponse: Decodable, Sendable {
    let reports: [RegressionReport]?
    let nextCursor: String?

    enum CodingKeys: String, CodingKey {
        case reports
        case nextCursor = "next_cursor"
    }
}

/// A type-erased Codable wrapper for heterogeneous JSON values in time series data arrays.
/// Marked @unchecked Sendable because `value` is set once during init and never mutated,
/// and only holds Sendable primitives (Int, Double, String, Bool, NSNull).
struct AnyCodable: Decodable, @unchecked Sendable {
    let value: Any

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let intVal = try? container.decode(Int.self) {
            value = intVal
        } else if let doubleVal = try? container.decode(Double.self) {
            value = doubleVal
        } else if let stringVal = try? container.decode(String.self) {
            value = stringVal
        } else if let boolVal = try? container.decode(Bool.self) {
            value = boolVal
        } else if container.decodeNil() {
            value = NSNull()
        } else {
            value = ""
        }
    }
}

// Typed accessors for [String: AnyCodable] dictionaries used in time series data.
extension Dictionary where Key == String, Value == AnyCodable {
    func string(_ key: String) -> String? {
        guard let codable = self[key] else { return nil }
        return codable.value as? String
    }

    func double(_ key: String) -> Double? {
        guard let codable = self[key] else { return nil }
        if let d = codable.value as? Double { return d }
        if let i = codable.value as? Int { return Double(i) }
        if let s = codable.value as? String { return Double(s) }
        return nil
    }
}

// MARK: - Regression Models

struct RegressionItem: Decodable, Identifiable, Sendable {
    let model: String
    let metric: String
    let oldValue: Double
    let newValue: Double
    let delta: Double?

    var id: String { "\(model)-\(metric)" }

    var changePercent: Double {
        guard oldValue != 0 else { return 0 }
        return ((newValue - oldValue) / oldValue) * 100
    }

    enum CodingKeys: String, CodingKey {
        case model, metric, delta
        case oldValue = "old_value"
        case newValue = "new_value"
    }
}
