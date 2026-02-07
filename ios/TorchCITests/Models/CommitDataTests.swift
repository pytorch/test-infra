import XCTest
@testable import TorchCI

final class CommitDataTests: XCTestCase {

    // MARK: - CommitInfo decoding

    func testCommitInfoDecoding() {
        let json = """
        {
            "sha": "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
            "title": "Add torch.compile support for custom ops (#99001)",
            "body": "This PR adds torch.compile support.",
            "author": {
                "login": "compiler-dev",
                "avatar_url": "https://avatars.githubusercontent.com/u/12345678",
                "url": "https://github.com/compiler-dev"
            },
            "commitDate": "2025-01-20T14:30:00Z",
            "prNumber": 99001,
            "diffNum": "D12345678"
        }
        """

        let commit: CommitInfo = MockData.decode(json)

        XCTAssertEqual(commit.sha, "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3")
        XCTAssertEqual(commit.title, "Add torch.compile support for custom ops (#99001)")
        XCTAssertEqual(commit.body, "This PR adds torch.compile support.")
        XCTAssertEqual(commit.prNumber, 99001)
        XCTAssertEqual(commit.diffNum, "D12345678")
        XCTAssertEqual(commit.author?.login, "compiler-dev")
        XCTAssertEqual(commit.author?.avatarUrl, "https://avatars.githubusercontent.com/u/12345678")
        XCTAssertEqual(commit.author?.url, "https://github.com/compiler-dev")
    }

    func testCommitInfoNilOptionals() {
        let json = """
        {
            "sha": "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
            "title": null,
            "body": null,
            "author": null,
            "commitDate": null,
            "prNumber": null,
            "diffNum": null
        }
        """

        let commit: CommitInfo = MockData.decode(json)

        XCTAssertEqual(commit.sha, "aaaa1111bbbb2222cccc3333dddd4444eeee5555")
        XCTAssertNil(commit.title)
        XCTAssertNil(commit.body)
        XCTAssertNil(commit.author)
        XCTAssertNil(commit.commitDate)
        XCTAssertNil(commit.prNumber)
        XCTAssertNil(commit.diffNum)
    }

    // MARK: - shortSha

    func testShortSha() {
        let json = """
        {
            "sha": "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
            "title": null,
            "body": null,
            "author": null,
            "commitDate": null,
            "prNumber": null,
            "diffNum": null
        }
        """

        let commit: CommitInfo = MockData.decode(json)

        XCTAssertEqual(commit.shortSha, "d4e5f6a")
        XCTAssertEqual(commit.shortSha.count, 7)
    }

    func testShortShaWithShortInput() {
        let json = """
        {
            "sha": "abc",
            "title": null,
            "body": null,
            "author": null,
            "commitDate": null,
            "prNumber": null,
            "diffNum": null
        }
        """

        let commit: CommitInfo = MockData.decode(json)

        // prefix(7) on a 3-char string returns the whole string
        XCTAssertEqual(commit.shortSha, "abc")
    }

    // MARK: - id (Identifiable)

    func testCommitInfoId() {
        let json = """
        {
            "sha": "1234567890abcdef1234567890abcdef12345678",
            "title": null,
            "body": null,
            "author": null,
            "commitDate": null,
            "prNumber": null,
            "diffNum": null
        }
        """

        let commit: CommitInfo = MockData.decode(json)

        XCTAssertEqual(commit.id, commit.sha)
    }

    // MARK: - date parsing

    func testDateParsingValidISO8601() {
        let json = """
        {
            "sha": "abcdef1234567890abcdef1234567890abcdef12",
            "title": null,
            "body": null,
            "author": null,
            "commitDate": "2025-01-20T14:30:00Z",
            "prNumber": null,
            "diffNum": null
        }
        """

        let commit: CommitInfo = MockData.decode(json)

        XCTAssertNotNil(commit.date)

        // Verify the parsed date components
        let calendar = Calendar(identifier: .gregorian)
        let components = calendar.dateComponents(in: TimeZone(identifier: "UTC")!, from: commit.date!)
        XCTAssertEqual(components.year, 2025)
        XCTAssertEqual(components.month, 1)
        XCTAssertEqual(components.day, 20)
        XCTAssertEqual(components.hour, 14)
        XCTAssertEqual(components.minute, 30)
    }

    func testDateParsingNilCommitDate() {
        let json = """
        {
            "sha": "abcdef1234567890abcdef1234567890abcdef12",
            "title": null,
            "body": null,
            "author": null,
            "commitDate": null,
            "prNumber": null,
            "diffNum": null
        }
        """

        let commit: CommitInfo = MockData.decode(json)

        XCTAssertNil(commit.date)
    }

    func testDateParsingInvalidString() {
        let json = """
        {
            "sha": "abcdef1234567890abcdef1234567890abcdef12",
            "title": null,
            "body": null,
            "author": null,
            "commitDate": "not-a-date",
            "prNumber": null,
            "diffNum": null
        }
        """

        let commit: CommitInfo = MockData.decode(json)

        // ISO8601DateFormatter cannot parse "not-a-date", so date should be nil.
        XCTAssertNil(commit.date)
    }

    // MARK: - AuthorInfo decoding

    func testAuthorInfoDecoding() {
        let json = """
        {
            "login": "pytorch-dev",
            "avatar_url": "https://avatars.githubusercontent.com/u/99999",
            "url": "https://github.com/pytorch-dev"
        }
        """

        let author: AuthorInfo = MockData.decode(json)

        XCTAssertEqual(author.login, "pytorch-dev")
        XCTAssertEqual(author.avatarUrl, "https://avatars.githubusercontent.com/u/99999")
        XCTAssertEqual(author.url, "https://github.com/pytorch-dev")
    }

    func testAuthorInfoAllNil() {
        let json = """
        {
            "login": null,
            "avatar_url": null,
            "url": null
        }
        """

        let author: AuthorInfo = MockData.decode(json)

        XCTAssertNil(author.login)
        XCTAssertNil(author.avatarUrl)
        XCTAssertNil(author.url)
    }

    // MARK: - Full CommitResponse

    func testCommitResponseFromMockData() {
        let response: CommitResponse = MockData.decode(MockData.commitResponseJSON)

        // Commit info
        XCTAssertEqual(response.commit.sha, "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3")
        XCTAssertEqual(response.commit.shortSha, "d4e5f6a")
        XCTAssertEqual(response.commit.title, "Add torch.compile support for custom ops (#99001)")
        XCTAssertEqual(response.commit.prNumber, 99001)
        XCTAssertEqual(response.commit.diffNum, "D12345678")
        XCTAssertNotNil(response.commit.date)
        XCTAssertEqual(response.commit.author?.login, "compiler-dev")

        // Jobs
        XCTAssertEqual(response.jobs.count, 4)

        // First job - success
        let buildJob = response.jobs[0]
        XCTAssertEqual(buildJob.workflowName, "pull")
        XCTAssertTrue(buildJob.isSuccess)
        XCTAssertFalse(buildJob.isFailure)
        XCTAssertEqual(buildJob.steps?.count, 2)

        // Second job - failure with previous_run
        let failedJob = response.jobs[1]
        XCTAssertTrue(failedJob.isFailure)
        XCTAssertEqual(failedJob.failureLines?.count, 1)
        XCTAssertNotNil(failedJob.previousRun)
        XCTAssertEqual(failedJob.previousRun?.conclusion, "success")

        // Third job - different workflow
        let winBuild = response.jobs[2]
        XCTAssertEqual(winBuild.workflowName, "trunk")
        XCTAssertEqual(winBuild.runnerGroup, "windows.4xlarge")

        // Fourth job - queued, no conclusion
        let queuedJob = response.jobs[3]
        XCTAssertNil(queuedJob.conclusion)
        XCTAssertEqual(queuedJob.status, "queued")
        XCTAssertFalse(queuedJob.isSuccess)
        XCTAssertFalse(queuedJob.isFailure)
    }

    func testCommitResponseWorkflowGrouping() {
        let response: CommitResponse = MockData.decode(MockData.commitResponseJSON)

        // Group jobs by workflow name
        let grouped = Dictionary(grouping: response.jobs, by: { $0.workflowName ?? "unknown" })

        XCTAssertEqual(grouped.keys.count, 2)
        XCTAssertEqual(grouped["pull"]?.count, 2)
        XCTAssertEqual(grouped["trunk"]?.count, 2)
    }
}
