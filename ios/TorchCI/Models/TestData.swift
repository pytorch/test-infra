import Foundation

// MARK: - Search API Response
// GET /api/flaky-tests/search?name=...&suite=...&file=...&page=...&per_page=...
// Returns: { count: number, tests: [...] }

struct TestSearchResponse: Decodable {
    let count: Int
    let tests: [TestResult]
}

struct TestResult: Decodable, Identifiable {
    let name: String
    let classname: String
    let file: String
    let invokingFile: String
    let lastRun: String

    var id: String { "\(name)-\(classname)" }

    /// The classname serves as the test suite name
    var suite: String { classname }

    enum CodingKeys: String, CodingKey {
        case name, classname, file
        case invokingFile = "invoking_file"
        case lastRun = "last_run"
    }
}

// MARK: - Failures API Response
// GET /api/flaky-tests/failures?name=...&suite=...
// Returns: JobData[] (flat array, camelCase fields)

struct TestFailure: Decodable, Identifiable {
    let jobName: String?
    let conclusion: String?
    let time: String?
    let sha: String?
    let branch: String?
    let htmlUrl: String?
    let logUrl: String?
    let failureLines: [String]?
    let failureCaptures: [String]?

    var id: String { "\(sha ?? "")-\(jobName ?? "")-\(time ?? "")" }

    /// Build a traceback string from failureLines
    var traceback: String? {
        guard let lines = failureLines, !lines.isEmpty else { return nil }
        return lines.joined(separator: "\n")
    }
}

// MARK: - Disabled Tests API Response
// GET /api/flaky-tests/getDisabledTestsAndJobs
// Requires authorization header matching FLAKY_TEST_BOT_KEY
// Returns: { disabledTests: { [testName]: [issueNumber, url, platforms] }, disabledJobs: {...}, unstableJobs: {...} }

struct DisabledTestsAPIResponse: Decodable {
    let disabledTests: [String: DisabledTestEntry]

    struct DisabledTestEntry: Decodable {
        let issueNumber: String
        let issueUrl: String
        let platforms: [String]

        init(from decoder: Decoder) throws {
            // The API returns each entry as a tuple array: [issueNumber, url, [platforms]]
            var container = try decoder.unkeyedContainer()
            self.issueNumber = try container.decode(String.self)
            self.issueUrl = try container.decode(String.self)
            self.platforms = try container.decode([String].self)
        }
    }
}

struct DisabledTest: Identifiable {
    let testName: String
    let issueNumber: Int?
    let issueUrl: String?
    let platforms: [String]?
    let assignee: String?
    let updatedAt: String?
    let labels: [String]?
    let body: String?

    var id: String { testName }

    /// Parse the test name into test + suite. Format is "TestSuite.test_name"
    var parsedTestName: String {
        if let dotIndex = testName.firstIndex(of: ".") {
            return String(testName[testName.index(after: dotIndex)...])
        }
        return testName
    }

    var suiteName: String? {
        if let dotIndex = testName.firstIndex(of: ".") {
            return String(testName[..<dotIndex])
        }
        return nil
    }

    var isTriaged: Bool {
        labels?.contains("triaged") ?? false
    }

    var isHighPriority: Bool {
        labels?.contains("high priority") ?? false
    }

    var testPath: String? {
        guard let body = body else { return nil }
        let regex = try? NSRegularExpression(pattern: "Test file path: `([^\\s]*)`")
        let nsRange = NSRange(body.startIndex..<body.endIndex, in: body)
        if let match = regex?.firstMatch(in: body, range: nsRange),
           let range = Range(match.range(at: 1), in: body) {
            return String(body[range])
        }
        return nil
    }

    var daysSinceUpdated: Int? {
        guard let updatedAt = updatedAt,
              let date = ISO8601DateFormatter().date(from: updatedAt) else {
            return nil
        }
        return Calendar.current.dateComponents([.day], from: date, to: Date()).day
    }
}

// MARK: - Status Changes API Response
// POST /api/flaky-tests/statusChanges
// Requires: sha1, sha2, files, jobs
// Returns: [{ name, classname, invoking_file, workflow_name, job_name, prev_status, new_status }]

struct TestStatusChange: Decodable, Identifiable {
    let name: String
    let classname: String
    let invokingFile: String
    let workflowName: String
    let jobName: String
    let prevStatus: String
    let newStatus: String

    var id: String { "\(jobName)-\(invokingFile)-\(classname)-\(name)" }

    enum CodingKeys: String, CodingKey {
        case name, classname
        case invokingFile = "invoking_file"
        case workflowName = "workflow_name"
        case jobName = "job_name"
        case prevStatus = "prev_status"
        case newStatus = "new_status"
    }
}

// MARK: - 3D Stats API Response
// GET /api/flaky-tests/3dStats?name=...&suite=...&file=...&jobFilter=...
// Returns: [{ hour: string, conclusions: { [key: string]: number } }]

struct Test3dStatsResponse: Decodable {
    let hour: String
    let conclusions: [String: Int]
}

struct TestTrendPoint: Identifiable {
    let hour: Date
    let failed: Int
    let flaky: Int
    let skipped: Int
    let success: Int
    let total: Int

    var id: String { hour.ISO8601Format() }

    init(hour: Date, conclusions: [String: Int]) {
        self.hour = hour
        self.failed = conclusions["failed"] ?? 0
        self.flaky = conclusions["flaky"] ?? 0
        self.skipped = conclusions["skipped"] ?? 0
        self.success = conclusions["success"] ?? 0
        self.total = conclusions.values.reduce(0, +)
    }
}

// MARK: - Disabled Tests Detailed Response (from clickhouse query)
// GET /api/clickhouse/disabled_tests
// The ClickHouse API returns a flat array of rows directly (not wrapped in {data: [...]})

// We decode the response as a plain array of DisabledTestDetail.
// The type alias keeps the intent clear for call sites.
typealias DisabledTestDetailsResponse = [DisabledTestDetail]

struct DisabledTestDetail: Decodable {
    let number: Int
    let name: String
    let assignee: String?
    let htmlUrl: String
    let updatedAt: String
    let labels: [String]
    let body: String

    enum CodingKeys: String, CodingKey {
        case number, name, assignee, labels, body
        case htmlUrl = "html_url"
        case updatedAt = "updated_at"
    }
}

// MARK: - Disabled Tests Historical Response
// GET /api/clickhouse/disabled_test_historical
// The ClickHouse API returns a flat array of rows directly (not wrapped in {data: [...]})

typealias DisabledTestHistoricalResponse = [DisabledTestHistoricalData]

struct DisabledTestHistoricalData: Decodable, Identifiable {
    nonisolated(unsafe) private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    private static let dateFormats = [
        "yyyy-MM-dd",
        "yyyy-MM-dd HH:mm:ss.SSS",
        "yyyy-MM-dd HH:mm:ss",
        "yyyy-MM-dd'T'HH:mm:ss.SSSZ",
        "yyyy-MM-dd'T'HH:mm:ss.SSS",
        "yyyy-MM-dd'T'HH:mm:ssZ",
    ]

    let day: String
    let count: Int
    let new: Int
    let deleted: Int

    var id: String { day }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        day = try container.decode(String.self, forKey: .day)
        // These fields come from LEFT JOINs and may be null
        count = try container.decodeIfPresent(Int.self, forKey: .count) ?? 0
        new = try container.decodeIfPresent(Int.self, forKey: .new) ?? 0
        deleted = try container.decodeIfPresent(Int.self, forKey: .deleted) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case day, count, new = "new", deleted
    }

    var date: Date? {
        let formatter = Self.dateFormatter
        // ClickHouse date_time_output_format=iso can return various formats:
        // "2024-01-15", "2024-01-15 00:00:00.000", "2024-01-15T00:00:00.000Z"
        for fmt in Self.dateFormats {
            formatter.dateFormat = fmt
            if let d = formatter.date(from: day) { return d }
        }
        // Fallback: try just extracting the date portion
        let prefix = String(day.prefix(10))
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: prefix)
    }
}

// MARK: - File Report API Response
// GET /api/flaky-tests/fileReport?startDate=...&endDate=...
// Returns: { results: [...], costInfo: [...], shas: [...], testOwnerLabels: [...] }

struct FileReportResponse: Decodable {
    let results: [FileReportResult]
    let costInfo: [CostInfo]
    let shas: [FileReportCommitSha]
    let testOwnerLabels: [TestOwnerLabel]
}

struct FileReportResult: Decodable, Identifiable {
    let file: String
    let workflowName: String
    let jobName: String
    let time: Double
    let count: Int
    let success: Int
    let skipped: Int
    let sha: String
    let label: String

    var id: String { "\(file)-\(jobName)-\(sha)" }
    var shortJobName: String { "\(workflowName) / \(jobName)" }
    var failures: Int { count - success - skipped }
    var successRate: Double {
        guard count > 0 else { return 0 }
        return Double(success) / Double(count)
    }

    enum CodingKeys: String, CodingKey {
        case file
        case workflowName = "workflow_name"
        case jobName = "job_name"
        case time, count, success, skipped, sha, label
    }
}

struct CostInfo: Decodable {
    let label: String
    let pricePerHour: Double

    enum CodingKeys: String, CodingKey {
        case label
        case pricePerHour = "price_per_hour"
    }
}

struct FileReportCommitSha: Decodable, Identifiable {
    let sha: String
    let pushDate: Int

    var id: String { sha }
    var date: Date { Date(timeIntervalSince1970: TimeInterval(pushDate)) }

    enum CodingKeys: String, CodingKey {
        case sha
        case pushDate = "push_date"
    }
}

struct TestOwnerLabel: Decodable {
    let file: String
    let ownerLabels: [String]

    enum CodingKeys: String, CodingKey {
        case file
        case ownerLabels = "owner_labels"
    }
}

// MARK: - Aggregated File Statistics
// Used for displaying per-file summary in the iOS app

struct FileStats: Identifiable {
    let file: String
    var totalTests: Int
    var successCount: Int
    var failureCount: Int
    var skippedCount: Int
    var totalDuration: TimeInterval
    var estimatedCost: Double
    var jobNames: Set<String>
    var ownerLabels: [String]

    var id: String { file }

    var successRate: Double {
        guard totalTests > 0 else { return 0 }
        return Double(successCount) / Double(totalTests)
    }

    var statusColor: String {
        if failureCount > 0 { return "red" }
        if skippedCount > 0 { return "orange" }
        return "green"
    }
}
