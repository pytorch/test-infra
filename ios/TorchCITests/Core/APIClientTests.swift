import XCTest
@testable import TorchCI

// MARK: - URLProtocol Mock

private final class MockURLProtocol: URLProtocol {

    /// Handler that returns (response, data) or throws for a given request.
    nonisolated(unsafe) static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.requestHandler else {
            client?.urlProtocolDidFinishLoading(self)
            return
        }

        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

// MARK: - Tests

final class APIClientTests: XCTestCase {

    private var session: URLSession!
    private var client: APIClient!
    private let baseURL = URL(string: "https://hud.pytorch.org")!

    override func setUp() {
        super.setUp()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        session = URLSession(configuration: config)
        client = APIClient(session: session, baseURL: baseURL)
    }

    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        session = nil
        client = nil
        super.tearDown()
    }

    // MARK: - URL Construction

    func testHUDEndpointURLConstruction() async throws {
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1,
            perPage: 50
        )

        var capturedURL: URL?
        MockURLProtocol.requestHandler = { request in
            capturedURL = request.url
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            let body = #"{"shaGrid":[],"jobNames":[]}"#
            return (response, Data(body.utf8))
        }

        let _: HUDResponse = try await client.fetch(endpoint)

        let url = try XCTUnwrap(capturedURL)
        XCTAssertEqual(url.host, "hud.pytorch.org")
        XCTAssertTrue(url.path.contains("/api/hud/pytorch/pytorch/main/1"))
    }

    func testCommitEndpointURLConstruction() async throws {
        let endpoint = APIEndpoint.commit(
            repoOwner: "pytorch",
            repoName: "pytorch",
            sha: "abc123"
        )

        var capturedURL: URL?
        MockURLProtocol.requestHandler = { request in
            capturedURL = request.url
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data("{}".utf8))
        }

        let _: [String: String] = try await client.fetch(endpoint)

        let url = try XCTUnwrap(capturedURL)
        XCTAssertTrue(url.path.contains("/api/pytorch/pytorch/commit/abc123"))
    }

    func testPullRequestEndpointURLConstruction() async throws {
        let endpoint = APIEndpoint.pullRequest(
            repoOwner: "pytorch",
            repoName: "pytorch",
            prNumber: 42
        )

        var capturedURL: URL?
        MockURLProtocol.requestHandler = { request in
            capturedURL = request.url
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data("{}".utf8))
        }

        let _: [String: String] = try await client.fetch(endpoint)

        let url = try XCTUnwrap(capturedURL)
        XCTAssertTrue(url.path.contains("/api/pytorch/pytorch/pull/42"))
    }

    // MARK: - Query Parameters

    func testQueryParametersAreEncoded() async throws {
        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 2,
            perPage: 25
        )

        var capturedURL: URL?
        MockURLProtocol.requestHandler = { request in
            capturedURL = request.url
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            let body = #"{"shaGrid":[],"jobNames":[]}"#
            return (response, Data(body.utf8))
        }

        let _: HUDResponse = try await client.fetch(endpoint)

        let url = try XCTUnwrap(capturedURL)
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let queryItems = try XCTUnwrap(components?.queryItems)

        let perPageItem = queryItems.first { $0.name == "per_page" }
        XCTAssertEqual(perPageItem?.value, "25")
    }

    func testSearchTestsQueryParametersEncoding() async throws {
        let endpoint = APIEndpoint.searchTests(name: "test_add", suite: "torch", page: 3)

        var capturedURL: URL?
        MockURLProtocol.requestHandler = { request in
            capturedURL = request.url
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            let body = #"{"tests":[],"total_count":0,"page":3}"#
            return (response, Data(body.utf8))
        }

        let _: TestSearchResponse = try await client.fetch(endpoint)

        let url = try XCTUnwrap(capturedURL)
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let queryItems = try XCTUnwrap(components?.queryItems)

        let names = Set(queryItems.map(\.name))
        XCTAssertTrue(names.contains("name"))
        XCTAssertTrue(names.contains("suite"))
        XCTAssertTrue(names.contains("page"))

        XCTAssertEqual(queryItems.first { $0.name == "name" }?.value, "test_add")
        XCTAssertEqual(queryItems.first { $0.name == "suite" }?.value, "torch")
        XCTAssertEqual(queryItems.first { $0.name == "page" }?.value, "3")
    }

    // MARK: - HTTP Error Status Codes

    func testUnauthorizedReturnsUnauthorizedError() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 401,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }

        let endpoint = APIEndpoint(path: "/api/test")
        do {
            let _: [String: String] = try await client.fetch(endpoint)
            XCTFail("Expected unauthorized error to be thrown")
        } catch let error as APIError {
            if case .unauthorized = error {
                // expected
            } else {
                XCTFail("Expected .unauthorized but got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func testNotFoundReturnsNotFoundError() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 404,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }

        let endpoint = APIEndpoint(path: "/api/nonexistent")
        do {
            let _: [String: String] = try await client.fetch(endpoint)
            XCTFail("Expected notFound error to be thrown")
        } catch let error as APIError {
            if case .notFound = error {
                // expected
            } else {
                XCTFail("Expected .notFound but got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func testServerErrorReturnsServerError() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 500,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }

        let endpoint = APIEndpoint(path: "/api/broken")
        do {
            let _: [String: String] = try await client.fetch(endpoint)
            XCTFail("Expected serverError to be thrown")
        } catch let error as APIError {
            if case .serverError(let code) = error {
                XCTAssertEqual(code, 500)
            } else {
                XCTFail("Expected .serverError(500) but got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func test502ReturnsServerError() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 502,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }

        let endpoint = APIEndpoint(path: "/api/gateway")
        do {
            let _: [String: String] = try await client.fetch(endpoint)
            XCTFail("Expected serverError to be thrown")
        } catch let error as APIError {
            if case .serverError(let code) = error {
                XCTAssertEqual(code, 502)
            } else {
                XCTFail("Expected .serverError(502) but got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - Successful JSON Decoding

    func testSuccessfulJSONDecoding() async throws {
        let json = #"""
        {
            "shaGrid": [
                {
                    "sha": "abc123def",
                    "commitTitle": "Fix build",
                    "jobs": []
                }
            ],
            "jobNames": ["build", "test"]
        }
        """#

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, Data(json.utf8))
        }

        let endpoint = APIEndpoint.hud(
            repoOwner: "pytorch",
            repoName: "pytorch",
            branch: "main",
            page: 1
        )
        let result: HUDResponse = try await client.fetch(endpoint)

        XCTAssertEqual(result.shaGrid.count, 1)
        XCTAssertEqual(result.shaGrid.first?.sha, "abc123def")
        XCTAssertEqual(result.shaGrid.first?.commitTitle, "Fix build")
        XCTAssertEqual(result.jobNames, ["build", "test"])
    }

    func testDecodingTestSearchResponse() async throws {
        let json = #"""
        {
            "tests": [
                {
                    "name": "test_add",
                    "suite": "torch",
                    "invoked_times": 100,
                    "failed_times": 5,
                    "flaky_rate": 0.05
                }
            ],
            "total_count": 1,
            "page": 1
        }
        """#

        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(json.utf8))
        }

        let endpoint = APIEndpoint.searchTests(name: "test_add", page: 1)
        let result: TestSearchResponse = try await client.fetch(endpoint)

        XCTAssertEqual(result.tests.count, 1)
        XCTAssertEqual(result.tests.first?.name, "test_add")
        XCTAssertEqual(result.tests.first?.suite, "torch")
        XCTAssertEqual(result.count, 1)
    }

    // MARK: - Auth Token in Headers

    func testAcceptHeaderIsSet() async throws {
        var capturedRequest: URLRequest?
        MockURLProtocol.requestHandler = { request in
            capturedRequest = request
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data("{}".utf8))
        }

        let endpoint = APIEndpoint(path: "/api/test")
        let _: [String: String] = try await client.fetch(endpoint)

        let request = try XCTUnwrap(capturedRequest)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
    }

    func testHTTPMethodIsSetCorrectly() async throws {
        var capturedRequest: URLRequest?
        MockURLProtocol.requestHandler = { request in
            capturedRequest = request
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data("{}".utf8))
        }

        let endpoint = APIEndpoint(path: "/api/test", method: .POST, body: Data("{}".utf8))
        let _: [String: String] = try await client.fetch(endpoint)

        let request = try XCTUnwrap(capturedRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    }

    func testTimeoutIsSetFromEndpoint() async throws {
        var capturedRequest: URLRequest?
        MockURLProtocol.requestHandler = { request in
            capturedRequest = request
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data("{}".utf8))
        }

        let endpoint = APIEndpoint(path: "/api/test", timeout: 90)
        let _: [String: String] = try await client.fetch(endpoint)

        let request = try XCTUnwrap(capturedRequest)
        XCTAssertEqual(request.timeoutInterval, 90)
    }

    // MARK: - fetchRaw

    func testFetchRawReturnsRawData() async throws {
        let rawBody = "raw response body"
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(rawBody.utf8))
        }

        let endpoint = APIEndpoint(path: "/api/raw")
        let data = try await client.fetchRaw(endpoint)

        let resultString = String(data: data, encoding: .utf8)
        XCTAssertEqual(resultString, rawBody)
    }

    func testFetchRawThrowsOnHTTPError() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 403,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data())
        }

        let endpoint = APIEndpoint(path: "/api/forbidden")
        do {
            _ = try await client.fetchRaw(endpoint)
            XCTFail("Expected forbidden error")
        } catch let error as APIError {
            if case .forbidden = error {
                // expected
            } else {
                XCTFail("Expected .forbidden but got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }
}
