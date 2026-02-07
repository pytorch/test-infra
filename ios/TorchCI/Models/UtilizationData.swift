import Foundation

/// Model for a single item from the `/api/list_util_reports/` response `metadata_list`.
/// The server returns fields like `group_key`, `total_runs`, and a `metrics` dict.
struct UtilizationReport: Decodable, Identifiable {
    let name: String
    let parentGroup: String?
    let timeGroup: String?
    let totalJobs: Int?
    let metrics: [String: Double]?

    var id: String { name }

    enum CodingKeys: String, CodingKey {
        case name = "group_key"
        case parentGroup = "parent_group"
        case timeGroup = "time_group"
        case totalJobs = "total_runs"
        case metrics
    }

    /// Extract avg CPU from the metrics dict (key is typically "cpu_avg" or "cpu_p90")
    var avgCpu: Double? {
        metrics?["cpu_avg"] ?? metrics?["cpu_p90"]
    }

    /// Extract avg memory from the metrics dict
    var avgMemory: Double? {
        metrics?["memory_avg"] ?? metrics?["memory_p90"]
    }

    var cpuFormatted: String {
        guard let cpu = avgCpu else { return "N/A" }
        return String(format: "%.1f%%", cpu)
    }

    var memoryFormatted: String {
        guard let mem = avgMemory else { return "N/A" }
        return String(format: "%.1f%%", mem)
    }
}

struct JobUtilization: Decodable {
    let workflowId: String?
    let jobId: String?
    let attempt: String?
    let cpuTimeSeries: [UtilizationPoint]?
    let memoryTimeSeries: [UtilizationPoint]?
    let diskTimeSeries: [UtilizationPoint]?

    enum CodingKeys: String, CodingKey {
        case workflowId = "workflow_id"
        case jobId = "job_id"
        case attempt
        case cpuTimeSeries = "cpu_time_series"
        case memoryTimeSeries = "memory_time_series"
        case diskTimeSeries = "disk_time_series"
    }
}

struct UtilizationPoint: Decodable, Identifiable {
    let time: String
    let value: Double

    var id: String { time }
}

struct UtilizationMetadataInfo: Decodable, Identifiable {
    let workflowId: String
    let jobId: String
    let attempt: String
    let jobName: String?
    let time: String?

    var id: String { "\(workflowId)-\(jobId)-\(attempt)" }

    enum CodingKeys: String, CodingKey {
        case attempt, time
        case workflowId = "workflow_id"
        case jobId = "job_id"
        case jobName = "job_name"
    }
}

/// Wrapper for the `/api/list_util_reports/{group_by}` response.
/// The server returns `{ group_key, metadata_list, min_time, max_time }`.
struct UtilizationReportResponse: Decodable {
    let groupKey: String?
    let metadataList: [UtilizationReport]?

    enum CodingKeys: String, CodingKey {
        case groupKey = "group_key"
        case metadataList = "metadata_list"
    }
}

struct FailureSearchResult: Decodable {
    let jobs: [JobData]?
}

/// Model for the `/api/failure` response.
/// The server returns `{ jobCount: {}, totalCount: N, samples: [] }`.
struct SimilarFailureResult: Decodable {
    let totalCount: Int?
    let jobCount: [String: Int]?
    let samples: [JobData]?
}
