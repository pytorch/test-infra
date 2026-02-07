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

// MARK: - HUD Endpoints
extension APIEndpoint {
    static func hud(repoOwner: String, repoName: String, branch: String, page: Int, perPage: Int = 50) -> APIEndpoint {
        APIEndpoint(
            path: "/api/hud/\(repoOwner)/\(repoName)/\(branch)/\(page)",
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

    /// Helper to compute ISO 8601 startTime/stopTime from a number of lookback days.
    /// Returns times with milliseconds like "2026-02-01T00:00:00.000".
    static func timeRange(days: Int) -> (startTime: String, stopTime: String) {
        let now = Date()
        let start = Calendar.current.date(byAdding: .day, value: -days, to: now) ?? now
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS"
        formatter.timeZone = TimeZone(identifier: "UTC")
        return (startTime: formatter.string(from: start), stopTime: formatter.string(from: now))
    }
}

// MARK: - Test Endpoints
extension APIEndpoint {
    static func searchTests(name: String? = nil, suite: String? = nil, file: String? = nil, page: Int = 1) -> APIEndpoint {
        var items: [URLQueryItem] = [URLQueryItem(name: "page", value: "\(page)")]
        if let name { items.append(URLQueryItem(name: "name", value: name)) }
        if let suite { items.append(URLQueryItem(name: "suite", value: suite)) }
        if let file { items.append(URLQueryItem(name: "file", value: file)) }
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
        let body: [String: Any] = [
            "name": name,
            "query_params": queryParams,
        ]
        let data = try? JSONSerialization.data(withJSONObject: body)
        return APIEndpoint(path: "/api/benchmark/list_metadata", method: .POST, body: data, timeout: 60)
    }

    /// Fetch benchmark time series. The API requires POST with `name`, `query_params`, and `response_formats`.
    static func benchmarkTimeSeries(
        name: String,
        queryParams: [String: Any],
        responseFormats: [String] = ["time_series"]
    ) -> APIEndpoint {
        let body: [String: Any] = [
            "name": name,
            "query_params": queryParams,
            "response_formats": responseFormats,
        ]
        let data = try? JSONSerialization.data(withJSONObject: body)
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
        let body: [String: Any] = [
            "report_id": reportId,
            "limit": limit,
        ]
        let data = try? JSONSerialization.data(withJSONObject: body)
        return APIEndpoint(
            path: "/api/benchmark/list_regression_summary_reports",
            method: .POST,
            body: data,
            timeout: 60
        )
    }

    /// Get a single regression summary report by ID. The API requires POST with `id` in the JSON body.
    static func regressionReport(id: String) -> APIEndpoint {
        let body: [String: Any] = ["id": id]
        let data = try? JSONSerialization.data(withJSONObject: body)
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
        APIEndpoint(path: "/api/hud/\(repoOwner)/\(repoName)/\(branch)/\(page)")
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
        let jsonData = try? JSONSerialization.data(withJSONObject: queryParams)
        let jsonString = jsonData.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        let encodedParams = jsonString.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ""

        return APIEndpoint(
            path: "/api/job_annotation/\(repoOwner)/\(repoName)/failures/\(encodedParams)",
            timeout: 60
        )
    }
}

// MARK: - Autorevert Endpoints
extension APIEndpoint {
    static func autorevertMetrics(startTime: String, stopTime: String) -> APIEndpoint {
        APIEndpoint(
            path: "/api/autorevert/metrics",
            queryItems: [
                URLQueryItem(name: "startTime", value: startTime),
                URLQueryItem(name: "stopTime", value: stopTime),
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
        let data = try? JSONSerialization.data(withJSONObject: body)
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
        let data = try? JSONSerialization.data(withJSONObject: ["sessionId": sessionId])
        return APIEndpoint(path: "/api/torchagent-share", method: .POST, body: data)
    }

    static func torchAgentCheckPermissions() -> APIEndpoint {
        APIEndpoint(path: "/api/torchagent-check-permissions")
    }

    static func torchAgentFeedback(sessionId: String, feedback: Int) -> APIEndpoint {
        let data = try? JSONSerialization.data(withJSONObject: [
            "sessionId": sessionId,
            "feedback": feedback,
        ] as [String: Any])
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
        APIEndpoint(path: "/api/list_utilization_metadata_info/\(workflowId)")
    }

    static func jobUtilization(workflowId: String, jobId: String, attempt: String) -> APIEndpoint {
        APIEndpoint(path: "/api/job_utilization/\(workflowId)/\(jobId)/\(attempt)")
    }
}

// MARK: - Misc Endpoints
extension APIEndpoint {
    static func issuesByLabel(label: String) -> APIEndpoint {
        APIEndpoint(path: "/api/issue/\(label)")
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
