import Foundation

enum HTTPMethod: String, Sendable {
    case GET, POST, PUT, DELETE
}

struct APIEndpoint: Sendable {
    let path: String
    let method: HTTPMethod
    let queryItems: [URLQueryItem]?
    let body: Data?
    let timeout: TimeInterval

    init(
        path: String,
        method: HTTPMethod = .GET,
        queryItems: [URLQueryItem]? = nil,
        body: Data? = nil,
        timeout: TimeInterval = 30
    ) {
        self.path = path
        self.method = method
        self.queryItems = queryItems
        self.body = body
        self.timeout = timeout
    }
}

// MARK: - JSON Body Helper
extension APIEndpoint {
    /// Serialize a dictionary to JSON Data, asserting in debug builds on failure.
    static func jsonBody(_ object: [String: Any]) -> Data? {
        do {
            return try JSONSerialization.data(withJSONObject: object)
        } catch {
            assertionFailure("APIEndpoint: JSON body serialization failed: \(error)")
            return nil
        }
    }
}

// MARK: - HUD Endpoints
extension APIEndpoint {
    /// Percent-encode a value for use as a single URL path segment (encodes `/` as `%2F`).
    private static func encodePath(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove("/")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    static func hud(repoOwner: String, repoName: String, branch: String, page: Int, perPage: Int = 30) -> APIEndpoint {
        APIEndpoint(
            path: "/api/hud/\(repoOwner)/\(repoName)/\(encodePath(branch))/\(page)",
            queryItems: [URLQueryItem(name: "per_page", value: "\(perPage)")]
        )
    }

    static func commit(repoOwner: String, repoName: String, sha: String) -> APIEndpoint {
        APIEndpoint(path: "/api/\(repoOwner)/\(repoName)/commit/\(sha)")
    }

    static func pullRequest(repoOwner: String, repoName: String, prNumber: Int) -> APIEndpoint {
        APIEndpoint(path: "/api/\(repoOwner)/\(repoName)/pull/\(prNumber)")
    }
}

// MARK: - Metrics Endpoints
extension APIEndpoint {
    /// Build a clickhouse query endpoint using the correct format:
    /// GET /api/clickhouse/{queryName}?parameters={URL_ENCODED_JSON}
    ///
    /// All parameters are serialized as a single JSON object and passed
    /// via the `parameters` query item.
    static func clickhouseQuery(name: String, parameters: [String: Any] = [:]) -> APIEndpoint {
        var queryItems: [URLQueryItem] = []
        if !parameters.isEmpty {
            if let jsonData = try? JSONSerialization.data(withJSONObject: parameters, options: [.sortedKeys]),
               let jsonString = String(data: jsonData, encoding: .utf8) {
                queryItems.append(URLQueryItem(name: "parameters", value: jsonString))
            }
        }
        // Encode slashes in nested query names so the Next.js [queryName] route
        // receives the full name as a single path segment.
        // e.g. "build_time_metrics/overall" → "build_time_metrics%2Foverall"
        let encodedName = name.replacingOccurrences(of: "/", with: "%2F")
        return APIEndpoint(
            path: "/api/clickhouse/\(encodedName)",
            queryItems: queryItems.isEmpty ? nil : queryItems,
            timeout: 60
        )
    }

    nonisolated(unsafe) private static let isoMillisFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS"
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    /// Helper to compute ISO 8601 startTime/stopTime from a number of lookback days.
    /// Returns times with milliseconds like "2026-02-01T00:00:00.000".
    static func timeRange(days: Int) -> (startTime: String, stopTime: String) {
        let now = Date()
        let start = Calendar.current.date(byAdding: .day, value: -days, to: now) ?? now
        return (startTime: isoMillisFormatter.string(from: start), stopTime: isoMillisFormatter.string(from: now))
    }
}

// MARK: - Test Endpoints
extension APIEndpoint {
    static func searchTests(name: String? = nil, suite: String? = nil, file: String? = nil, page: Int = 1) -> APIEndpoint {
        // The server wraps each parameter with %...% wildcards for LIKE matching.
        // If a parameter is missing from the query string, the server reads it as
        // the literal string "undefined" and searches for "%undefined%" which matches
        // nothing.  Always send empty string so the server gets "%%" (match all).
        let items: [URLQueryItem] = [
            URLQueryItem(name: "name", value: name ?? ""),
            URLQueryItem(name: "suite", value: suite ?? ""),
            URLQueryItem(name: "file", value: file ?? ""),
            URLQueryItem(name: "page", value: "\(page)"),
        ]
        return APIEndpoint(path: "/api/flaky-tests/search", queryItems: items)
    }

    static func testFailures(name: String, suite: String) -> APIEndpoint {
        APIEndpoint(
            path: "/api/flaky-tests/failures",
            queryItems: [
                URLQueryItem(name: "name", value: name),
                URLQueryItem(name: "suite", value: suite),
            ]
        )
    }

    static func test3dStats(name: String, suite: String, file: String, jobFilter: String = "") -> APIEndpoint {
        var items: [URLQueryItem] = [
            URLQueryItem(name: "name", value: name),
            URLQueryItem(name: "suite", value: suite),
            URLQueryItem(name: "file", value: file),
        ]
        if !jobFilter.isEmpty {
            items.append(URLQueryItem(name: "jobFilter", value: jobFilter))
        }
        return APIEndpoint(path: "/api/flaky-tests/3dStats", queryItems: items)
    }

    static func disabledTests() -> APIEndpoint {
        APIEndpoint(path: "/api/flaky-tests/getDisabledTestsAndJobs")
    }

    static func fileReport(startDate: Int, endDate: Int) -> APIEndpoint {
        APIEndpoint(
            path: "/api/flaky-tests/fileReport",
            queryItems: [
                URLQueryItem(name: "startDate", value: "\(startDate)"),
                URLQueryItem(name: "endDate", value: "\(endDate)"),
            ],
            timeout: 120
        )
    }

}

// MARK: - Benchmark Endpoints
extension APIEndpoint {
    /// List benchmark metadata. The API requires POST with `name` and `query_params` in the JSON body.
    static func benchmarkList(name: String, queryParams: [String: Any]) -> APIEndpoint {
        let data = jsonBody([
            "name": name,
            "query_params": queryParams,
        ])
        return APIEndpoint(path: "/api/benchmark/list_metadata", method: .POST, body: data, timeout: 60)
    }

    /// Fetch benchmark time series. The API requires POST with `name`, `query_params`, and `response_formats`.
    static func benchmarkTimeSeries(
        name: String,
        queryParams: [String: Any],
        responseFormats: [String] = ["time_series"]
    ) -> APIEndpoint {
        let data = jsonBody([
            "name": name,
            "query_params": queryParams,
            "response_formats": responseFormats,
        ])
        return APIEndpoint(path: "/api/benchmark/get_time_series", method: .POST, body: data, timeout: 60)
    }

    /// Fetch benchmark group data. This endpoint uses query string parameters validated by Zod.
    static func benchmarkGroupData(params: [String: String]) -> APIEndpoint {
        APIEndpoint(
            path: "/api/benchmark/group_data",
            queryItems: params.map { URLQueryItem(name: $0.key, value: $0.value) },
            timeout: 60
        )
    }

    /// List regression summary reports. The API requires POST with `report_id` in the JSON body.
    static func regressionReports(reportId: String, limit: Int = 10) -> APIEndpoint {
        let data = jsonBody([
            "report_id": reportId,
            "limit": limit,
        ])
        return APIEndpoint(
            path: "/api/benchmark/list_regression_summary_reports",
            method: .POST,
            body: data,
            timeout: 60
        )
    }

    /// Get a single regression summary report by ID. The API requires POST with `id` in the JSON body.
    static func regressionReport(id: String) -> APIEndpoint {
        let data = jsonBody(["id": id])
        return APIEndpoint(
            path: "/api/benchmark/get_regression_summary_report",
            method: .POST,
            body: data,
            timeout: 60
        )
    }
}

// MARK: - Failure & Search Endpoints
extension APIEndpoint {
    static func searchFailures(
        query: String,
        startDate: String? = nil,
        endDate: String? = nil
    ) -> APIEndpoint {
        var items: [URLQueryItem] = [URLQueryItem(name: "failure", value: query)]
        if let startDate { items.append(URLQueryItem(name: "startDate", value: startDate)) }
        if let endDate { items.append(URLQueryItem(name: "endDate", value: endDate)) }
        return APIEndpoint(path: "/api/search", queryItems: items, timeout: 60)
    }

    static func similarFailures(name: String, jobName: String? = nil, failureCaptures: [String] = []) -> APIEndpoint {
        var items: [URLQueryItem] = [URLQueryItem(name: "name", value: name)]
        if let jobName { items.append(URLQueryItem(name: "jobName", value: jobName)) }
        // The server expects failureCaptures as a JSON-encoded array string
        let capturesJSON = (try? JSONSerialization.data(withJSONObject: failureCaptures))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        items.append(URLQueryItem(name: "failureCaptures", value: capturesJSON))
        return APIEndpoint(path: "/api/failure", queryItems: items)
    }

    static func failedJobs(repoOwner: String, repoName: String, branch: String, page: Int) -> APIEndpoint {
        APIEndpoint(path: "/api/hud/\(repoOwner)/\(repoName)/\(encodePath(branch))/\(page)")
    }

    /// Fetch failed jobs with their annotations. Query params should include:
    /// - branch: String
    /// - repo: "owner/name"
    /// - startTime: ISO 8601 timestamp with milliseconds
    /// - stopTime: ISO 8601 timestamp with milliseconds
    static func failedJobsWithAnnotations(
        repoOwner: String,
        repoName: String,
        queryParams: [String: Any]
    ) -> APIEndpoint {
        // Encode the query params as JSON
        let jsonData = try? JSONSerialization.data(withJSONObject: queryParams, options: .sortedKeys)
        let jsonString = jsonData.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        // Must encode ALL special characters including / so the JSON blob is a single path segment
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/{}\":,")
        let encodedParams = jsonString.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""

        return APIEndpoint(
            path: "/api/job_annotation/\(repoOwner)/\(repoName)/failures/\(encodedParams)",
            timeout: 60
        )
    }

    /// Submit a job annotation to the backend.
    ///
    /// The server endpoint is POST `/api/job_annotation/{repoOwner}/{repoName}/{annotation}`.
    /// The body is a JSON array of job ID integers to annotate.
    /// Pass `"null"` as annotation to remove the annotation.
    static func annotateJobs(
        repoOwner: String,
        repoName: String,
        annotation: String,
        jobIds: [Int]
    ) -> APIEndpoint {
        let body = try? JSONSerialization.data(withJSONObject: jobIds)
        return APIEndpoint(
            path: "/api/job_annotation/\(repoOwner)/\(repoName)/\(annotation)",
            method: .POST,
            body: body,
            timeout: 30
        )
    }

    /// Fetch existing annotations for specific job IDs.
    ///
    /// The server endpoint is GET `/api/job_annotation/{repoOwner}/{repoName}/annotations/{jobIds}`.
    /// The `jobIds` path segment is a JSON-encoded array of job ID integers.
    static func fetchAnnotations(
        repoOwner: String,
        repoName: String,
        jobIds: [Int]
    ) -> APIEndpoint {
        let jsonData = try? JSONSerialization.data(withJSONObject: jobIds)
        let jsonString = jsonData.flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/[]")
        let encodedIds = jsonString.addingPercentEncoding(withAllowedCharacters: allowed) ?? "[]"
        return APIEndpoint(
            path: "/api/job_annotation/\(repoOwner)/\(repoName)/annotations/\(encodedIds)",
            timeout: 30
        )
    }
}

// MARK: - Autorevert Endpoints
extension APIEndpoint {
    static func autorevertMetrics(startTime: String, stopTime: String) -> APIEndpoint {
        let workflowNames = "[\"Lint\",\"pull\",\"trunk\",\"linux-aarch64\"]"
        return APIEndpoint(
            path: "/api/autorevert/metrics",
            queryItems: [
                URLQueryItem(name: "startTime", value: startTime),
                URLQueryItem(name: "stopTime", value: stopTime),
                URLQueryItem(name: "workflowNames", value: workflowNames),
            ]
        )
    }
}

// MARK: - Runner Endpoints
extension APIEndpoint {
    static func runners(org: String) -> APIEndpoint {
        APIEndpoint(path: "/api/runners/\(org)")
    }
}

// MARK: - TorchAgent Endpoints
extension APIEndpoint {
    static func torchAgentQuery(query: String, sessionId: String?) -> APIEndpoint {
        var body: [String: Any] = ["query": query]
        if let sessionId { body["sessionId"] = sessionId }
        let data = jsonBody(body)
        return APIEndpoint(path: "/api/torchagent-api", method: .POST, body: data, timeout: 120)
    }

    static func torchAgentHistory() -> APIEndpoint {
        APIEndpoint(path: "/api/torchagent-get-history")
    }

    static func torchAgentChatHistory(sessionId: String) -> APIEndpoint {
        APIEndpoint(
            path: "/api/torchagent-get-chat-history",
            queryItems: [URLQueryItem(name: "sessionId", value: sessionId)]
        )
    }

    static func torchAgentShared(uuid: String) -> APIEndpoint {
        APIEndpoint(path: "/api/torchagent-get-shared/\(uuid)")
    }

    static func torchAgentShare(sessionId: String) -> APIEndpoint {
        let data = jsonBody(["sessionId": sessionId])
        return APIEndpoint(path: "/api/torchagent-share", method: .POST, body: data)
    }

    static func torchAgentCheckPermissions() -> APIEndpoint {
        APIEndpoint(path: "/api/torchagent-check-permissions")
    }

    static func torchAgentFeedback(sessionId: String, feedback: Int) -> APIEndpoint {
        let data = jsonBody([
            "sessionId": sessionId,
            "feedback": feedback,
        ])
        return APIEndpoint(path: "/api/torchagent-feedback", method: .POST, body: data)
    }
}

// MARK: - Utilization Endpoints
extension APIEndpoint {
    static func utilizationReport(groupBy: String) -> APIEndpoint {
        // The server expects repo, group_by, granularity, start_time, end_time, parent_group
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: "UTC")
        let today = formatter.string(from: Date())
        return APIEndpoint(
            path: "/api/list_util_reports/\(groupBy)",
            queryItems: [
                URLQueryItem(name: "repo", value: "pytorch/pytorch"),
                URLQueryItem(name: "group_by", value: groupBy),
                URLQueryItem(name: "granularity", value: "day"),
                URLQueryItem(name: "start_time", value: today),
                URLQueryItem(name: "end_time", value: today),
                URLQueryItem(name: "parent_group", value: ""),
            ]
        )
    }

    static func utilizationMetadata(workflowId: String) -> APIEndpoint {
        APIEndpoint(
            path: "/api/list_utilization_metadata_info/\(workflowId)",
            queryItems: [URLQueryItem(name: "includes_stats", value: "true")]
        )
    }

    static func jobUtilization(workflowId: String, jobId: String, attempt: String) -> APIEndpoint {
        APIEndpoint(path: "/api/job_utilization/\(workflowId)/\(jobId)/\(attempt)")
    }
}

// MARK: - Misc Endpoints
extension APIEndpoint {
    static func issuesByLabel(label: String) -> APIEndpoint {
        APIEndpoint(path: "/api/issue/\(encodePath(label))")
    }

    static func artifacts(repository: String? = nil, lookbackDays: Int = 7) -> APIEndpoint {
        var items: [URLQueryItem] = [URLQueryItem(name: "lookbackDays", value: "\(lookbackDays)")]
        if let repository { items.append(URLQueryItem(name: "repository", value: repository)) }
        return APIEndpoint(path: "/api/artifacts", queryItems: items)
    }

    static func workflowDispatch(repoOwner: String, repoName: String, workflow: String, sha: String) -> APIEndpoint {
        APIEndpoint(
            path: "/api/github/dispatch/\(repoOwner)/\(repoName)/\(workflow)/\(sha)",
            method: .POST
        )
    }
}
