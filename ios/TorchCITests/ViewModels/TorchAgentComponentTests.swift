import XCTest
@testable import TorchCI

final class TorchAgentComponentTests: XCTestCase {

    // MARK: - StreamingIndicator.formatElapsedTime

    func testFormatElapsedTimeSeconds() {
        XCTAssertEqual(StreamingIndicator.formatElapsedTime(0), "0s")
        XCTAssertEqual(StreamingIndicator.formatElapsedTime(1), "1s")
        XCTAssertEqual(StreamingIndicator.formatElapsedTime(30), "30s")
        XCTAssertEqual(StreamingIndicator.formatElapsedTime(59), "59s")
    }

    func testFormatElapsedTimeMinutes() {
        XCTAssertEqual(StreamingIndicator.formatElapsedTime(60), "1m 0s")
        XCTAssertEqual(StreamingIndicator.formatElapsedTime(90), "1m 30s")
        XCTAssertEqual(StreamingIndicator.formatElapsedTime(125), "2m 5s")
        XCTAssertEqual(StreamingIndicator.formatElapsedTime(300), "5m 0s")
    }

    func testFormatElapsedTimeFractionalSeconds() {
        // Should floor to integer seconds
        XCTAssertEqual(StreamingIndicator.formatElapsedTime(12.5), "12s")
        XCTAssertEqual(StreamingIndicator.formatElapsedTime(59.9), "59s")
        XCTAssertEqual(StreamingIndicator.formatElapsedTime(60.7), "1m 0s")
    }

    // MARK: - StreamingIndicator.phaseLabel

    func testPhaseLabelDefault() {
        let indicator = StreamingIndicator(
            elapsedTime: 5,
            tokenCount: 0,
            thinkingContent: ""
        )
        XCTAssertEqual(indicator.phaseLabel, "Thinking")
    }

    func testPhaseLabelWithThinking() {
        let indicator = StreamingIndicator(
            elapsedTime: 5,
            tokenCount: 0,
            thinkingContent: "Some reasoning..."
        )
        XCTAssertEqual(indicator.phaseLabel, "Reasoning")
    }

    func testPhaseLabelWithTools() {
        let indicator = StreamingIndicator(
            elapsedTime: 5,
            tokenCount: 0,
            thinkingContent: "",
            toolCount: 2
        )
        XCTAssertEqual(indicator.phaseLabel, "Running tools")
    }

    func testPhaseLabelWithContent() {
        let indicator = StreamingIndicator(
            elapsedTime: 5,
            tokenCount: 100,
            thinkingContent: "reason",
            toolCount: 1,
            hasContent: true
        )
        // hasContent takes priority
        XCTAssertEqual(indicator.phaseLabel, "Generating response")
    }

    func testPhaseLabelToolsOverThinking() {
        // toolCount > 0 should show "Running tools" even if thinking is also present
        let indicator = StreamingIndicator(
            elapsedTime: 5,
            tokenCount: 0,
            thinkingContent: "thinking",
            toolCount: 1,
            hasContent: false
        )
        XCTAssertEqual(indicator.phaseLabel, "Running tools")
    }

    // MARK: - ChatMessageView.formatTimestamp

    func testFormatTimestampProducesNonEmptyString() {
        let date = Date()
        let result = ChatMessageView.formatTimestamp(date)
        XCTAssertFalse(result.isEmpty)
    }

    func testFormatTimestampConsistency() {
        // Same date should produce same string
        let date = Date(timeIntervalSince1970: 1700000000) // Fixed date
        let result1 = ChatMessageView.formatTimestamp(date)
        let result2 = ChatMessageView.formatTimestamp(date)
        XCTAssertEqual(result1, result2)
    }

    // MARK: - APIEndpoint Construction

    func testTorchAgentQueryEndpointWithoutSession() {
        let endpoint = APIEndpoint.torchAgentQuery(query: "test", sessionId: nil)

        XCTAssertEqual(endpoint.path, "/api/torchagent-api")
        XCTAssertEqual(endpoint.method, .POST)
        XCTAssertEqual(endpoint.timeout, 120)
        XCTAssertNotNil(endpoint.body)

        // Verify body contains the query
        if let body = endpoint.body,
           let dict = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            XCTAssertEqual(dict["query"] as? String, "test")
            XCTAssertNil(dict["sessionId"])
        } else {
            XCTFail("Expected valid JSON body")
        }
    }

    func testTorchAgentQueryEndpointWithSession() {
        let endpoint = APIEndpoint.torchAgentQuery(
            query: "follow up",
            sessionId: "sess-123"
        )

        if let body = endpoint.body,
           let dict = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            XCTAssertEqual(dict["query"] as? String, "follow up")
            XCTAssertEqual(dict["sessionId"] as? String, "sess-123")
        } else {
            XCTFail("Expected valid JSON body")
        }
    }

    func testTorchAgentHistoryEndpoint() {
        let endpoint = APIEndpoint.torchAgentHistory()
        XCTAssertEqual(endpoint.path, "/api/torchagent-get-history")
        XCTAssertEqual(endpoint.method, .GET)
    }

    func testTorchAgentChatHistoryEndpoint() {
        let endpoint = APIEndpoint.torchAgentChatHistory(sessionId: "sess-abc")
        XCTAssertEqual(endpoint.path, "/api/torchagent-get-chat-history")
        XCTAssertEqual(endpoint.queryItems?.first?.name, "sessionId")
        XCTAssertEqual(endpoint.queryItems?.first?.value, "sess-abc")
    }

    func testTorchAgentSharedEndpoint() {
        let endpoint = APIEndpoint.torchAgentShared(uuid: "uuid-xyz")
        XCTAssertEqual(endpoint.path, "/api/torchagent-get-shared/uuid-xyz")
        XCTAssertEqual(endpoint.method, .GET)
    }

    func testTorchAgentShareEndpoint() {
        let endpoint = APIEndpoint.torchAgentShare(sessionId: "sess-share")
        XCTAssertEqual(endpoint.path, "/api/torchagent-share")
        XCTAssertEqual(endpoint.method, .POST)

        if let body = endpoint.body,
           let dict = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            XCTAssertEqual(dict["sessionId"] as? String, "sess-share")
        } else {
            XCTFail("Expected valid JSON body")
        }
    }

    func testTorchAgentCheckPermissionsEndpoint() {
        let endpoint = APIEndpoint.torchAgentCheckPermissions()
        XCTAssertEqual(endpoint.path, "/api/torchagent-check-permissions")
        XCTAssertEqual(endpoint.method, .GET)
    }

    func testTorchAgentFeedbackEndpoint() {
        let endpoint = APIEndpoint.torchAgentFeedback(
            sessionId: "sess-fb",
            feedback: 1
        )
        XCTAssertEqual(endpoint.path, "/api/torchagent-feedback")
        XCTAssertEqual(endpoint.method, .POST)

        if let body = endpoint.body,
           let dict = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            XCTAssertEqual(dict["sessionId"] as? String, "sess-fb")
            XCTAssertEqual(dict["feedback"] as? Int, 1)
        } else {
            XCTFail("Expected valid JSON body")
        }
    }

    func testTorchAgentFeedbackEndpointNegative() {
        let endpoint = APIEndpoint.torchAgentFeedback(
            sessionId: "sess-neg",
            feedback: -1
        )

        if let body = endpoint.body,
           let dict = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            XCTAssertEqual(dict["feedback"] as? Int, -1)
        } else {
            XCTFail("Expected valid JSON body")
        }
    }
}
