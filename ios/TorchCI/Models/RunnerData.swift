import Foundation

struct RunnersResponse: Decodable {
    let groups: [RunnerGroup]
    let totalRunners: Int?

    enum CodingKeys: String, CodingKey {
        case groups
        case totalRunners = "total_runners"
    }
}

struct RunnerGroup: Decodable, Identifiable {
    /// The group label from the server (the API returns "label", not "name")
    let name: String
    let totalCount: Int
    let idleCount: Int
    let busyCount: Int
    let offlineCount: Int
    let runners: [Runner]

    var id: String { name }

    var onlineCount: Int { idleCount + busyCount }

    enum CodingKeys: String, CodingKey {
        case name = "label"
        case totalCount
        case idleCount
        case busyCount
        case offlineCount
        case runners
    }

    /// Convenience initializer for local construction (e.g. search filtering)
    init(name: String, runners: [Runner]) {
        self.name = name
        self.totalCount = runners.count
        self.idleCount = runners.filter { $0.isOnline && !$0.isBusy }.count
        self.busyCount = runners.filter(\.isBusy).count
        self.offlineCount = runners.filter { !$0.isOnline }.count
        self.runners = runners
    }
}

struct Runner: Decodable, Identifiable {
    let id: Int
    let name: String
    let os: String?
    let status: String?
    let busy: Bool?
    let labels: [RunnerLabel]?

    var isOnline: Bool { status == "online" }
    var isBusy: Bool { busy == true }

    var statusDisplay: String {
        if !isOnline { return "Offline" }
        if isBusy { return "Busy" }
        return "Idle"
    }

    var statusColor: String {
        if !isOnline { return "gray" }
        if isBusy { return "orange" }
        return "green"
    }
}

struct RunnerLabel: Decodable, Identifiable {
    let labelId: Int?
    let name: String
    let type: String?

    var id: String { labelId.map { "\($0)" } ?? name }

    enum CodingKeys: String, CodingKey {
        case labelId = "id"
        case name
        case type
    }
}
