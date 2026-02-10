import Foundation
import SwiftUI
import Combine

@MainActor
final class RunnersViewModel: ObservableObject {
    // MARK: - Types

    enum ViewState: Equatable {
        case idle
        case loading
        case loaded
        case error(String)

        static func == (lhs: ViewState, rhs: ViewState) -> Bool {
            switch (lhs, rhs) {
            case (.idle, .idle), (.loading, .loading), (.loaded, .loaded):
                return true
            case let (.error(a), .error(b)):
                return a == b
            default:
                return false
            }
        }
    }

    // MARK: - State

    @Published var state: ViewState = .idle
    @Published var response: RunnersResponse?
    @Published var selectedOrg: String = "pytorch"
    @Published var searchFilter: String = ""
    @Published var expandedGroups: Set<String> = []
    @Published var sortOrder: SortOrder = .alphabetical
    @Published var statusFilter: StatusFilter = .all
    @Published var lastRefreshed: Date?

    // MARK: - Configuration

    static let orgs: [String] = ["pytorch", "meta-pytorch"]

    enum SortOrder {
        case alphabetical
        case count
    }

    enum StatusFilter: String, CaseIterable {
        case all
        case idle
        case busy
        case offline

        var label: String {
            switch self {
            case .all: return "Total"
            case .idle: return "Idle"
            case .busy: return "Busy"
            case .offline: return "Offline"
            }
        }
    }

    // MARK: - Dependencies

    private let apiClient: APIClientProtocol
    private var refreshTimer: Timer?

    // MARK: - Computed

    var groups: [RunnerGroup] {
        response?.groups ?? []
    }

    var filteredGroups: [RunnerGroup] {
        var filtered = groups

        // Apply search filter
        if !searchFilter.isEmpty {
            let lowered = searchFilter.lowercased()
            filtered = filtered.compactMap { group in
                let matchesGroupName = group.name.lowercased().contains(lowered)
                let matchingRunners = group.runners.filter { runner in
                    runner.name.lowercased().contains(lowered)
                    || (runner.os ?? "").lowercased().contains(lowered)
                    || (runner.labels ?? []).contains { $0.name.lowercased().contains(lowered) }
                    || String(runner.id).contains(lowered)
                }

                if matchesGroupName && matchingRunners.isEmpty {
                    return group // Group name matches but no individual runners do - show all
                } else if !matchingRunners.isEmpty {
                    return RunnerGroup(name: group.name, runners: matchingRunners)
                }
                return nil
            }
        }

        // Apply status filter
        if statusFilter != .all {
            filtered = filtered.compactMap { group in
                let matchingRunners = group.runners.filter { runner in
                    switch statusFilter {
                    case .idle: return runner.isOnline && !runner.isBusy
                    case .busy: return runner.isBusy
                    case .offline: return !runner.isOnline
                    case .all: return true
                    }
                }
                guard !matchingRunners.isEmpty else { return nil }
                return RunnerGroup(name: group.name, runners: matchingRunners)
            }
        }

        // Apply sorting
        return filtered.sorted { a, b in
            // "unknown" group always goes last
            if a.name == "unknown" && b.name != "unknown" { return false }
            if a.name != "unknown" && b.name == "unknown" { return true }

            switch sortOrder {
            case .alphabetical:
                return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
            case .count:
                return a.totalCount > b.totalCount
            }
        }
    }

    var totalRunners: Int {
        response?.totalRunners ?? groups.reduce(0) { $0 + $1.runners.count }
    }

    var onlineCount: Int {
        groups.reduce(0) { $0 + $1.onlineCount }
    }

    var idleCount: Int {
        groups.reduce(0) { $0 + $1.idleCount }
    }

    var busyCount: Int {
        groups.reduce(0) { $0 + $1.busyCount }
    }

    var offlineCount: Int {
        groups.reduce(0) { $0 + $1.offlineCount }
    }

    var isLoading: Bool {
        state == .loading
    }

    // MARK: - Init

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    func stopTimer() {
        refreshTimer?.invalidate()
        refreshTimer = nil
    }

    // MARK: - Actions

    func loadData() async {
        if state != .loaded {
            state = .loading
        }
        do {
            let endpoint = APIEndpoint.runners(org: selectedOrg)
            let result: RunnersResponse = try await apiClient.fetch(endpoint)
            response = result
            lastRefreshed = Date()
            state = .loaded
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    func refresh() async {
        await loadData()
    }

    func selectOrg(_ org: String) {
        guard org != selectedOrg else { return }
        selectedOrg = org
        response = nil
        expandedGroups = []
        Task { await loadData() }
    }

    func toggleGroup(_ group: RunnerGroup) {
        if expandedGroups.contains(group.id) {
            expandedGroups.remove(group.id)
        } else {
            expandedGroups.insert(group.id)
        }
    }

    func isGroupExpanded(_ group: RunnerGroup) -> Bool {
        // Auto-expand groups when search is active and they have few runners
        if !searchFilter.isEmpty && group.runners.count <= 10 {
            return true
        }
        return expandedGroups.contains(group.id)
    }

    func toggleStatusFilter(_ filter: StatusFilter) {
        if statusFilter == filter {
            statusFilter = .all
        } else {
            statusFilter = filter
        }
    }

    func count(for filter: StatusFilter) -> Int {
        switch filter {
        case .all: return totalRunners
        case .idle: return idleCount
        case .busy: return busyCount
        case .offline: return offlineCount
        }
    }

    func expandAll() {
        expandedGroups = Set(filteredGroups.map(\.id))
    }

    func collapseAll() {
        expandedGroups = []
    }

    // MARK: - Auto Refresh

    func startAutoRefresh() {
        stopAutoRefresh()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.state != .loading else { return }
                await self.loadData()
            }
        }
    }

    func stopAutoRefresh() {
        refreshTimer?.invalidate()
        refreshTimer = nil
    }
}
