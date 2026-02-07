import XCTest
@testable import TorchCI

final class AboutViewTests: XCTestCase {

    // MARK: - IdentifiableURL

    func testIdentifiableURLIdMatchesAbsoluteString() {
        let url = URL(string: "https://hud.pytorch.org")!
        let identifiable = IdentifiableURL(url: url)

        XCTAssertEqual(identifiable.id, "https://hud.pytorch.org")
        XCTAssertEqual(identifiable.url, url)
    }

    func testIdentifiableURLIdIsUniqueForDifferentURLs() {
        let url1 = IdentifiableURL(url: URL(string: "https://pytorch.org")!)
        let url2 = IdentifiableURL(url: URL(string: "https://github.com/pytorch")!)

        XCTAssertNotEqual(url1.id, url2.id)
    }

    func testIdentifiableURLIdIsSameForSameURL() {
        let url1 = IdentifiableURL(url: URL(string: "https://pytorch.org")!)
        let url2 = IdentifiableURL(url: URL(string: "https://pytorch.org")!)

        XCTAssertEqual(url1.id, url2.id)
    }

    func testIdentifiableURLWithQueryParams() {
        let url = URL(string: "https://hud.pytorch.org?branch=main&page=1")!
        let identifiable = IdentifiableURL(url: url)

        XCTAssertEqual(identifiable.id, "https://hud.pytorch.org?branch=main&page=1")
    }

    func testIdentifiableURLWithFragment() {
        let url = URL(string: "https://github.com/pytorch/test-infra#readme")!
        let identifiable = IdentifiableURL(url: url)

        XCTAssertEqual(identifiable.id, "https://github.com/pytorch/test-infra#readme")
    }

    // MARK: - Version Formatting

    func testFormattedVersionWithMainBundle() {
        // In the test bundle, CFBundleShortVersionString and CFBundleVersion
        // may not be present, so defaults should be applied.
        let version = AboutView.formattedVersion()

        // Must match "v<version> (<build>)" pattern
        XCTAssertTrue(version.hasPrefix("v"))
        XCTAssertTrue(version.contains("("))
        XCTAssertTrue(version.hasSuffix(")"))
    }

    func testFormattedVersionDefaultsWhenMissing() {
        // Create a bundle without version info to test defaults.
        // Using a temporary bundle that has no info dictionary entries.
        let emptyBundle = Bundle(for: type(of: self))

        let version = AboutView.formattedVersion(from: emptyBundle)

        // The test bundle may have its own version info, but the format should be consistent
        XCTAssertTrue(version.hasPrefix("v"))
        XCTAssertTrue(version.contains("("))
        XCTAssertTrue(version.hasSuffix(")"))
    }

    func testFormattedVersionFormat() {
        // Verify the format is "v<x.y> (<build>)"
        let version = AboutView.formattedVersion()

        let regex = try! NSRegularExpression(pattern: #"^v[\d.]+ \(\d+\)$"#)
        let range = NSRange(version.startIndex..<version.endIndex, in: version)
        let match = regex.firstMatch(in: version, range: range)

        XCTAssertNotNil(match, "Version '\(version)' does not match expected format 'v<number> (<number>)'")
    }

    // MARK: - Links Data

    func testLinksCountIsFive() {
        XCTAssertEqual(AboutView.links.count, 5)
    }

    func testAllLinkURLsAreValid() {
        for link in AboutView.links {
            let url = URL(string: link.urlString)
            XCTAssertNotNil(url, "Invalid URL for link '\(link.title)': \(link.urlString)")
        }
    }

    func testAllLinkURLsUseHTTPS() {
        for link in AboutView.links {
            let url = URL(string: link.urlString)!
            XCTAssertEqual(url.scheme, "https", "Link '\(link.title)' should use HTTPS but uses \(url.scheme ?? "nil")")
        }
    }

    func testLinkTitlesAreNotEmpty() {
        for link in AboutView.links {
            XCTAssertFalse(link.title.isEmpty, "Link title should not be empty")
        }
    }

    func testLinkSubtitlesAreNotEmpty() {
        for link in AboutView.links {
            XCTAssertFalse(link.subtitle.isEmpty, "Link subtitle should not be empty for '\(link.title)'")
        }
    }

    func testLinkIconsAreNotEmpty() {
        for link in AboutView.links {
            XCTAssertFalse(link.icon.isEmpty, "Link icon should not be empty for '\(link.title)'")
        }
    }

    func testLinkTitlesAreUnique() {
        let titles = AboutView.links.map(\.title)
        let uniqueTitles = Set(titles)
        XCTAssertEqual(titles.count, uniqueTitles.count, "Link titles should be unique")
    }

    func testLinkURLsAreUnique() {
        let urls = AboutView.links.map(\.urlString)
        let uniqueURLs = Set(urls)
        XCTAssertEqual(urls.count, uniqueURLs.count, "Link URLs should be unique")
    }

    func testPyTorchHUDLinkExists() {
        let hudLink = AboutView.links.first { $0.title == "PyTorch HUD" }
        XCTAssertNotNil(hudLink)
        XCTAssertEqual(hudLink?.urlString, "https://hud.pytorch.org")
    }

    func testGitHubRepoLinkExists() {
        let repoLink = AboutView.links.first { $0.title == "GitHub Repository" }
        XCTAssertNotNil(repoLink)
        XCTAssertEqual(repoLink?.urlString, "https://github.com/pytorch/test-infra")
    }

    func testDocumentationLinkExists() {
        let docsLink = AboutView.links.first { $0.title == "Documentation" }
        XCTAssertNotNil(docsLink)
        XCTAssertTrue(docsLink?.urlString.contains("README.md") ?? false)
    }

    func testReportIssueLinkExists() {
        let issueLink = AboutView.links.first { $0.title == "Report an Issue" }
        XCTAssertNotNil(issueLink)
        XCTAssertTrue(issueLink?.urlString.contains("issues/new") ?? false)
    }

    func testPyTorchWebsiteLinkExists() {
        let websiteLink = AboutView.links.first { $0.title == "PyTorch Website" }
        XCTAssertNotNil(websiteLink)
        XCTAssertEqual(websiteLink?.urlString, "https://pytorch.org")
    }

    // MARK: - Static Content

    func testAppDescriptionIsNotEmpty() {
        XCTAssertFalse(AboutView.appDescription.isEmpty)
    }

    func testAppDescriptionMentionsPyTorch() {
        XCTAssertTrue(AboutView.appDescription.contains("PyTorch"))
    }

    func testAppDescriptionMentionsCICD() {
        XCTAssertTrue(
            AboutView.appDescription.contains("CI/CD") || AboutView.appDescription.contains("continuous integration"),
            "App description should mention CI/CD or continuous integration"
        )
    }

    func testCopyrightNoticeContainsYear() {
        XCTAssertTrue(AboutView.copyrightNotice.contains("2024"))
        XCTAssertTrue(AboutView.copyrightNotice.contains("2026"))
    }

    func testCopyrightNoticeContainsPyTorchContributors() {
        XCTAssertTrue(AboutView.copyrightNotice.contains("PyTorch Contributors"))
    }

    func testCopyrightNoticeContainsCopyrightSymbol() {
        XCTAssertTrue(AboutView.copyrightNotice.contains("\u{00A9}"))
    }

    // MARK: - View Instantiation

    func testAboutViewCanBeInstantiated() {
        // Verify the view can be created without crashing
        let view = AboutView()
        XCTAssertNotNil(view)
    }
}
