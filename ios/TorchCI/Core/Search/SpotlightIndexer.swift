import CoreSpotlight
import Foundation
import MobileCoreServices
import UniformTypeIdentifiers

/// Indexes commits and PRs into CoreSpotlight so they appear in system Spotlight search.
/// When the user taps a Spotlight result, the app receives a deep link that can be routed
/// to the appropriate detail view.
@MainActor
final class SpotlightIndexer: ObservableObject {

    // MARK: - Singleton

    static let shared = SpotlightIndexer()

    // MARK: - Constants

    /// Domain identifiers used to group indexed items for bulk management.
    enum Domain {
        static let commits = "com.torchci.commits"
        static let pullRequests = "com.torchci.pullrequests"
    }

    /// Activity types for `NSUserActivity` continuations.
    enum ActivityType {
        static let viewCommit = "com.torchci.viewCommit"
        static let viewPR = "com.torchci.viewPR"
    }

    /// Keys embedded in the `userInfo` dictionary of each searchable item.
    enum UserInfoKey {
        static let sha = "sha"
        static let repoOwner = "repoOwner"
        static let repoName = "repoName"
        static let prNumber = "prNumber"
        static let itemType = "itemType"
    }

    enum ItemType: String {
        case commit
        case pullRequest
    }

    /// Maximum number of recently indexed items to keep per domain.
    private static let maxIndexedItems = 200

    // MARK: - Published State

    /// Set of SHAs currently indexed, for quick lookups.
    @Published private(set) var indexedCommitSHAs: Set<String> = []
    @Published private(set) var indexedPRNumbers: Set<Int> = []

    // MARK: - Private

    private let searchableIndex: CSSearchableIndex

    private init(searchableIndex: CSSearchableIndex = .default()) {
        self.searchableIndex = searchableIndex
    }

    // MARK: - Index a Commit

    /// Call this when the user views a commit detail screen. The commit data will be
    /// indexed in CoreSpotlight so it shows up in iOS Spotlight search.
    func indexCommit(
        sha: String,
        title: String?,
        author: String?,
        prNumber: Int?,
        repoOwner: String,
        repoName: String,
        date: Date? = nil
    ) {
        let uniqueID = commitUniqueID(sha: sha, repoOwner: repoOwner, repoName: repoName)

        let attributeSet = CSSearchableItemAttributeSet(contentType: .text)
        attributeSet.title = title ?? "Commit \(sha.prefix(7))"
        attributeSet.contentDescription = buildCommitDescription(
            sha: sha,
            author: author,
            prNumber: prNumber,
            repoOwner: repoOwner,
            repoName: repoName
        )
        attributeSet.identifier = uniqueID
        attributeSet.domainIdentifier = Domain.commits

        // Searchable keywords
        var keywords = [sha, String(sha.prefix(7)), repoName, repoOwner]
        if let author { keywords.append(author) }
        if let title { keywords.append(contentsOf: title.split(separator: " ").map(String.init)) }
        if let prNumber { keywords.append("#\(prNumber)") }
        attributeSet.keywords = keywords

        // Timestamps
        if let date {
            attributeSet.contentCreationDate = date
            attributeSet.contentModificationDate = date
        }

        // Thumbnail hint
        attributeSet.thumbnailData = nil // The system will use the app icon

        let item = CSSearchableItem(
            uniqueIdentifier: uniqueID,
            domainIdentifier: Domain.commits,
            attributeSet: attributeSet
        )
        // Expire after 30 days to keep the index fresh
        item.expirationDate = Date().addingTimeInterval(30 * 24 * 60 * 60)

        searchableIndex.indexSearchableItems([item]) { [weak self] error in
            if let error {
                print("[SpotlightIndexer] Failed to index commit \(sha.prefix(7)): \(error.localizedDescription)")
            } else {
                Task { @MainActor in
                    self?.indexedCommitSHAs.insert(sha)
                    self?.pruneOldItemsIfNeeded(domain: Domain.commits)
                }
            }
        }
    }

    // MARK: - Index a Pull Request

    /// Call this when the user views a PR detail screen.
    func indexPR(
        prNumber: Int,
        title: String?,
        author: String?,
        state: String?,
        repoOwner: String,
        repoName: String,
        headSha: String? = nil
    ) {
        let uniqueID = prUniqueID(prNumber: prNumber, repoOwner: repoOwner, repoName: repoName)

        let attributeSet = CSSearchableItemAttributeSet(contentType: .text)
        attributeSet.title = title ?? "PR #\(prNumber)"
        attributeSet.contentDescription = buildPRDescription(
            prNumber: prNumber,
            author: author,
            state: state,
            repoOwner: repoOwner,
            repoName: repoName
        )
        attributeSet.identifier = uniqueID
        attributeSet.domainIdentifier = Domain.pullRequests

        // Searchable keywords
        var keywords = [
            "#\(prNumber)",
            "\(prNumber)",
            "PR",
            repoName,
            repoOwner,
        ]
        if let author { keywords.append(author) }
        if let title { keywords.append(contentsOf: title.split(separator: " ").map(String.init)) }
        if let headSha {
            keywords.append(headSha)
            keywords.append(String(headSha.prefix(7)))
        }
        attributeSet.keywords = keywords

        attributeSet.contentModificationDate = Date()

        let item = CSSearchableItem(
            uniqueIdentifier: uniqueID,
            domainIdentifier: Domain.pullRequests,
            attributeSet: attributeSet
        )
        item.expirationDate = Date().addingTimeInterval(30 * 24 * 60 * 60)

        searchableIndex.indexSearchableItems([item]) { [weak self] error in
            if let error {
                print("[SpotlightIndexer] Failed to index PR #\(prNumber): \(error.localizedDescription)")
            } else {
                Task { @MainActor in
                    self?.indexedPRNumbers.insert(prNumber)
                }
            }
        }
    }

    // MARK: - Index Multiple Commits (Batch)

    /// Batch-index an array of HUD rows. Useful when the user loads the main HUD grid.
    func indexHUDRows(_ rows: [HUDRow], repoOwner: String, repoName: String) {
        let items: [CSSearchableItem] = rows.compactMap { row in
            let uniqueID = commitUniqueID(sha: row.sha, repoOwner: repoOwner, repoName: repoName)

            let attributeSet = CSSearchableItemAttributeSet(contentType: .text)
            attributeSet.title = row.commitTitle ?? "Commit \(row.shortSha)"
            attributeSet.contentDescription = buildCommitDescription(
                sha: row.sha,
                author: row.author,
                prNumber: row.prNumber,
                repoOwner: repoOwner,
                repoName: repoName
            )
            attributeSet.identifier = uniqueID
            attributeSet.domainIdentifier = Domain.commits

            var keywords = [row.sha, row.shortSha, repoName]
            if let author = row.author { keywords.append(author) }
            if let prNumber = row.prNumber { keywords.append("#\(prNumber)") }
            attributeSet.keywords = keywords

            if let date = row.commitDate {
                attributeSet.contentCreationDate = date
                attributeSet.contentModificationDate = date
            }

            let item = CSSearchableItem(
                uniqueIdentifier: uniqueID,
                domainIdentifier: Domain.commits,
                attributeSet: attributeSet
            )
            item.expirationDate = Date().addingTimeInterval(30 * 24 * 60 * 60)
            return item
        }

        guard !items.isEmpty else { return }

        searchableIndex.indexSearchableItems(items) { [weak self] error in
            if let error {
                print("[SpotlightIndexer] Batch index failed: \(error.localizedDescription)")
            } else {
                Task { @MainActor in
                    for row in rows {
                        self?.indexedCommitSHAs.insert(row.sha)
                    }
                }
            }
        }
    }

    // MARK: - Remove Items

    /// Remove a specific commit from the Spotlight index.
    func deindexCommit(sha: String, repoOwner: String, repoName: String) {
        let uniqueID = commitUniqueID(sha: sha, repoOwner: repoOwner, repoName: repoName)
        searchableIndex.deleteSearchableItems(withIdentifiers: [uniqueID]) { [weak self] error in
            if error == nil {
                Task { @MainActor in
                    self?.indexedCommitSHAs.remove(sha)
                }
            }
        }
    }

    /// Remove all commits from the Spotlight index.
    func deindexAllCommits() {
        searchableIndex.deleteSearchableItems(withDomainIdentifiers: [Domain.commits]) { [weak self] error in
            if error == nil {
                Task { @MainActor in
                    self?.indexedCommitSHAs.removeAll()
                }
            }
        }
    }

    /// Remove all PR items from the Spotlight index.
    func deindexAllPRs() {
        searchableIndex.deleteSearchableItems(withDomainIdentifiers: [Domain.pullRequests]) { [weak self] error in
            if error == nil {
                Task { @MainActor in
                    self?.indexedPRNumbers.removeAll()
                }
            }
        }
    }

    /// Remove everything this app has indexed from Spotlight.
    func deindexAll() {
        searchableIndex.deleteAllSearchableItems { [weak self] error in
            if error == nil {
                Task { @MainActor in
                    self?.indexedCommitSHAs.removeAll()
                    self?.indexedPRNumbers.removeAll()
                }
            }
        }
    }

    // MARK: - Handle Spotlight Search Result

    /// A parsed deep link destination from a Spotlight result.
    enum DeepLink: Equatable {
        case commit(sha: String, repoOwner: String, repoName: String)
        case pullRequest(prNumber: Int, repoOwner: String, repoName: String)
    }

    /// Parse a `NSUserActivity` from a Spotlight continuation into a deep link.
    /// Returns `nil` if the activity is not a Spotlight search result from this app.
    static func parseSpotlightActivity(_ activity: NSUserActivity) -> DeepLink? {
        // CoreSpotlight search continuation
        if activity.activityType == CSSearchableItemActionType {
            guard let uniqueID = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String else {
                return nil
            }
            return parseUniqueID(uniqueID)
        }

        // NSUserActivity continuation (e.g., Handoff / Siri Shortcuts)
        if activity.activityType == ActivityType.viewCommit {
            guard let sha = activity.userInfo?[UserInfoKey.sha] as? String,
                  let repoOwner = activity.userInfo?[UserInfoKey.repoOwner] as? String,
                  let repoName = activity.userInfo?[UserInfoKey.repoName] as? String
            else { return nil }
            return .commit(sha: sha, repoOwner: repoOwner, repoName: repoName)
        }

        if activity.activityType == ActivityType.viewPR {
            guard let prNumber = activity.userInfo?[UserInfoKey.prNumber] as? Int,
                  let repoOwner = activity.userInfo?[UserInfoKey.repoOwner] as? String,
                  let repoName = activity.userInfo?[UserInfoKey.repoName] as? String
            else { return nil }
            return .pullRequest(prNumber: prNumber, repoOwner: repoOwner, repoName: repoName)
        }

        return nil
    }

    // MARK: - NSUserActivity Helpers

    /// Create an `NSUserActivity` for a commit, suitable for Handoff and Siri Shortcuts.
    static func makeCommitActivity(
        sha: String,
        title: String?,
        repoOwner: String,
        repoName: String
    ) -> NSUserActivity {
        let activity = NSUserActivity(activityType: ActivityType.viewCommit)
        activity.title = title ?? "View Commit \(sha.prefix(7))"
        activity.isEligibleForSearch = true
        activity.isEligibleForPrediction = true
        activity.isEligibleForHandoff = false

        activity.userInfo = [
            UserInfoKey.sha: sha,
            UserInfoKey.repoOwner: repoOwner,
            UserInfoKey.repoName: repoName,
            UserInfoKey.itemType: ItemType.commit.rawValue,
        ]

        let attributes = CSSearchableItemAttributeSet(contentType: .text)
        attributes.title = title ?? "Commit \(sha.prefix(7))"
        attributes.contentDescription = "\(repoOwner)/\(repoName) - \(sha.prefix(7))"
        activity.contentAttributeSet = attributes

        return activity
    }

    /// Create an `NSUserActivity` for a PR, suitable for Handoff and Siri Shortcuts.
    static func makePRActivity(
        prNumber: Int,
        title: String?,
        repoOwner: String,
        repoName: String
    ) -> NSUserActivity {
        let activity = NSUserActivity(activityType: ActivityType.viewPR)
        activity.title = title ?? "View PR #\(prNumber)"
        activity.isEligibleForSearch = true
        activity.isEligibleForPrediction = true
        activity.isEligibleForHandoff = false

        activity.userInfo = [
            UserInfoKey.prNumber: prNumber,
            UserInfoKey.repoOwner: repoOwner,
            UserInfoKey.repoName: repoName,
            UserInfoKey.itemType: ItemType.pullRequest.rawValue,
        ]

        let attributes = CSSearchableItemAttributeSet(contentType: .text)
        attributes.title = title ?? "PR #\(prNumber)"
        attributes.contentDescription = "\(repoOwner)/\(repoName) - PR #\(prNumber)"
        activity.contentAttributeSet = attributes

        return activity
    }

    // MARK: - Private Helpers

    /// Build a unique identifier for a commit in the format:
    /// `commit:<repoOwner>/<repoName>:<sha>`
    private func commitUniqueID(sha: String, repoOwner: String, repoName: String) -> String {
        "commit:\(repoOwner)/\(repoName):\(sha)"
    }

    /// Build a unique identifier for a PR in the format:
    /// `pr:<repoOwner>/<repoName>:<number>`
    private func prUniqueID(prNumber: Int, repoOwner: String, repoName: String) -> String {
        "pr:\(repoOwner)/\(repoName):\(prNumber)"
    }

    /// Parse a unique identifier string back into a `DeepLink`.
    private static func parseUniqueID(_ uniqueID: String) -> DeepLink? {
        let parts = uniqueID.split(separator: ":", maxSplits: 2).map(String.init)
        guard parts.count == 3 else { return nil }

        let type = parts[0]
        let repoParts = parts[1].split(separator: "/").map(String.init)
        guard repoParts.count == 2 else { return nil }
        let repoOwner = repoParts[0]
        let repoName = repoParts[1]
        let value = parts[2]

        switch type {
        case "commit":
            return .commit(sha: value, repoOwner: repoOwner, repoName: repoName)
        case "pr":
            guard let prNumber = Int(value) else { return nil }
            return .pullRequest(prNumber: prNumber, repoOwner: repoOwner, repoName: repoName)
        default:
            return nil
        }
    }

    /// Build a human-readable description for a commit Spotlight entry.
    private func buildCommitDescription(
        sha: String,
        author: String?,
        prNumber: Int?,
        repoOwner: String,
        repoName: String
    ) -> String {
        var parts: [String] = ["\(repoOwner)/\(repoName)"]
        parts.append("SHA: \(sha.prefix(7))")
        if let author {
            parts.append("Author: \(author)")
        }
        if let prNumber {
            parts.append("PR #\(prNumber)")
        }
        return parts.joined(separator: " | ")
    }

    /// Build a human-readable description for a PR Spotlight entry.
    private func buildPRDescription(
        prNumber: Int,
        author: String?,
        state: String?,
        repoOwner: String,
        repoName: String
    ) -> String {
        var parts: [String] = ["\(repoOwner)/\(repoName)"]
        parts.append("PR #\(prNumber)")
        if let author {
            parts.append("Author: \(author)")
        }
        if let state {
            parts.append("State: \(state.capitalized)")
        }
        return parts.joined(separator: " | ")
    }

    /// Prune old items from a domain if we have exceeded the maximum.
    /// This is a best-effort cleanup -- CoreSpotlight handles its own index limits,
    /// but we keep ours tidy as well.
    private func pruneOldItemsIfNeeded(domain: String) {
        // We rely on the 30-day expiration for automatic cleanup.
        // For in-memory tracking, cap the set size.
        if domain == Domain.commits && indexedCommitSHAs.count > Self.maxIndexedItems {
            // Remove the oldest entries (we don't track order, so just trim randomly).
            let excess = indexedCommitSHAs.count - Self.maxIndexedItems
            for _ in 0..<excess {
                if let first = indexedCommitSHAs.first {
                    indexedCommitSHAs.remove(first)
                }
            }
        }
        if domain == Domain.pullRequests && indexedPRNumbers.count > Self.maxIndexedItems {
            let excess = indexedPRNumbers.count - Self.maxIndexedItems
            for _ in 0..<excess {
                if let first = indexedPRNumbers.first {
                    indexedPRNumbers.remove(first)
                }
            }
        }
    }
}

// MARK: - View Extension for Spotlight Indexing

import SwiftUI

extension View {
    /// Automatically indexes a commit in Spotlight when this view appears,
    /// and sets up the `NSUserActivity` for search/prediction.
    func indexInSpotlight(
        sha: String,
        title: String?,
        author: String?,
        prNumber: Int?,
        repoOwner: String,
        repoName: String,
        date: Date? = nil
    ) -> some View {
        self
            .onAppear {
                SpotlightIndexer.shared.indexCommit(
                    sha: sha,
                    title: title,
                    author: author,
                    prNumber: prNumber,
                    repoOwner: repoOwner,
                    repoName: repoName,
                    date: date
                )
            }
            .userActivity(SpotlightIndexer.ActivityType.viewCommit) { activity in
                activity.title = title ?? "Commit \(sha.prefix(7))"
                activity.isEligibleForSearch = true
                activity.isEligibleForPrediction = true
                activity.userInfo = [
                    SpotlightIndexer.UserInfoKey.sha: sha,
                    SpotlightIndexer.UserInfoKey.repoOwner: repoOwner,
                    SpotlightIndexer.UserInfoKey.repoName: repoName,
                    SpotlightIndexer.UserInfoKey.itemType: SpotlightIndexer.ItemType.commit.rawValue,
                ]
                let attributes = CSSearchableItemAttributeSet(contentType: .text)
                attributes.title = title ?? "Commit \(sha.prefix(7))"
                attributes.contentDescription = "\(repoOwner)/\(repoName) - \(sha.prefix(7))"
                activity.contentAttributeSet = attributes
            }
    }

    /// Automatically indexes a PR in Spotlight when this view appears,
    /// and sets up the `NSUserActivity` for search/prediction.
    func indexPRInSpotlight(
        prNumber: Int,
        title: String?,
        author: String?,
        state: String?,
        repoOwner: String,
        repoName: String,
        headSha: String? = nil
    ) -> some View {
        self
            .onAppear {
                SpotlightIndexer.shared.indexPR(
                    prNumber: prNumber,
                    title: title,
                    author: author,
                    state: state,
                    repoOwner: repoOwner,
                    repoName: repoName,
                    headSha: headSha
                )
            }
            .userActivity(SpotlightIndexer.ActivityType.viewPR) { activity in
                activity.title = title ?? "PR #\(prNumber)"
                activity.isEligibleForSearch = true
                activity.isEligibleForPrediction = true
                activity.userInfo = [
                    SpotlightIndexer.UserInfoKey.prNumber: prNumber,
                    SpotlightIndexer.UserInfoKey.repoOwner: repoOwner,
                    SpotlightIndexer.UserInfoKey.repoName: repoName,
                    SpotlightIndexer.UserInfoKey.itemType: SpotlightIndexer.ItemType.pullRequest.rawValue,
                ]
                let attributes = CSSearchableItemAttributeSet(contentType: .text)
                attributes.title = title ?? "PR #\(prNumber)"
                attributes.contentDescription = "\(repoOwner)/\(repoName) - PR #\(prNumber)"
                activity.contentAttributeSet = attributes
            }
    }
}
