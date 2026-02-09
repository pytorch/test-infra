import XCTest
@testable import TorchCI

final class PRDataTests: XCTestCase {

    // MARK: - PRResponse

    func testPRResponseDecoding() {
        let json = """
        {
            "title": "Fix flaky test",
            "body": "This PR fixes a flaky test in distributed module.",
            "shas": [
                {"sha": "abc1234567890", "title": "Initial commit"},
                {"sha": "def0987654321", "title": "Address review"}
            ]
        }
        """
        let response: PRResponse = MockData.decode(json)

        XCTAssertEqual(response.title, "Fix flaky test")
        XCTAssertEqual(response.body, "This PR fixes a flaky test in distributed module.")
        XCTAssertEqual(response.shas?.count, 2)
    }

    func testPRResponseCommits() {
        let json = """
        {
            "title": "Test",
            "body": null,
            "shas": [
                {"sha": "abc1234", "title": "First"},
                {"sha": "def5678", "title": "Second"}
            ]
        }
        """
        let response: PRResponse = MockData.decode(json)

        XCTAssertEqual(response.commits.count, 2)
        XCTAssertEqual(response.commits.first?.sha, "abc1234")
        XCTAssertEqual(response.commits.first?.title, "First")
        XCTAssertNil(response.commits.first?.time) // time is always nil from shas
    }

    func testPRResponseCommitsNilShas() {
        let json = """
        {"title": "Test", "body": null, "shas": null}
        """
        let response: PRResponse = MockData.decode(json)

        XCTAssertTrue(response.commits.isEmpty)
    }

    func testPRResponseHeadSha() {
        let json = """
        {
            "title": "Test",
            "body": null,
            "shas": [
                {"sha": "first", "title": "A"},
                {"sha": "last", "title": "B"}
            ]
        }
        """
        let response: PRResponse = MockData.decode(json)

        XCTAssertEqual(response.headSha, "last") // Last sha
    }

    func testPRResponseHeadShaNilShas() {
        let json = """
        {"title": "Test", "body": null, "shas": null}
        """
        let response: PRResponse = MockData.decode(json)

        XCTAssertNil(response.headSha)
    }

    func testPRResponseBranchInfo() {
        let json = """
        {
            "title": "Test",
            "body": null,
            "shas": [],
            "head_ref": "feature-branch",
            "base_ref": "main"
        }
        """
        let response: PRResponse = MockData.decode(json)

        XCTAssertEqual(response.branchInfo, "feature-branch → main")
    }

    func testPRResponseBranchInfoNilRefs() {
        let json = """
        {"title": "Test", "body": null, "shas": []}
        """
        let response: PRResponse = MockData.decode(json)

        XCTAssertNil(response.branchInfo)
    }

    func testPRResponseHasMetadata() {
        // No metadata
        let noMeta: PRResponse = MockData.decode("""
        {"title": "Test", "body": null, "shas": []}
        """)
        XCTAssertFalse(noMeta.hasMetadata)

        // With state
        let withState: PRResponse = MockData.decode("""
        {"title": "Test", "body": null, "shas": [], "state": "open"}
        """)
        XCTAssertTrue(withState.hasMetadata)

        // With author
        let withAuthor: PRResponse = MockData.decode("""
        {"title": "Test", "body": null, "shas": [], "author": {"login": "user"}}
        """)
        XCTAssertTrue(withAuthor.hasMetadata)
    }

    func testPRResponseOptionalFields() {
        let json = """
        {
            "title": "Test",
            "body": null,
            "shas": [],
            "state": "closed",
            "number": 12345,
            "created_at": "2025-01-15T10:00:00Z",
            "updated_at": "2025-01-16T10:00:00Z",
            "merged_at": "2025-01-16T11:00:00Z",
            "closed_at": null,
            "head_ref": "feat",
            "base_ref": "main"
        }
        """
        let response: PRResponse = MockData.decode(json)

        XCTAssertEqual(response.state, "closed")
        XCTAssertEqual(response.number, 12345)
        XCTAssertEqual(response.createdAt, "2025-01-15T10:00:00Z")
        XCTAssertEqual(response.updatedAt, "2025-01-16T10:00:00Z")
        XCTAssertEqual(response.mergedAt, "2025-01-16T11:00:00Z")
        XCTAssertNil(response.closedAt)
    }

    // MARK: - PRCommit

    func testPRCommitShortSha() {
        let commit = PRCommit(sha: "abc1234567890def", title: "Test", time: nil)

        XCTAssertEqual(commit.shortSha, "abc1234")
        XCTAssertEqual(commit.id, "abc1234567890def")
    }

    func testPRCommitShortShaShort() {
        let commit = PRCommit(sha: "abc", title: nil, time: nil)

        XCTAssertEqual(commit.shortSha, "abc") // Prefix of 7 but only 3 chars
    }

    // MARK: - PRShaInfo

    func testPRShaInfoDecoding() {
        let json = """
        {"sha": "abc1234", "title": "My commit"}
        """
        let info: PRShaInfo = MockData.decode(json)

        XCTAssertEqual(info.sha, "abc1234")
        XCTAssertEqual(info.title, "My commit")
        XCTAssertEqual(info.id, "abc1234")
    }

    func testPRShaInfoNilTitle() {
        let json = """
        {"sha": "abc1234", "title": null}
        """
        let info: PRShaInfo = MockData.decode(json)

        XCTAssertNil(info.title)
    }
}
