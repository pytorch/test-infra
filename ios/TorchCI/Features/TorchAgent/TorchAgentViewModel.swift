import Foundation
import SwiftUI

@MainActor
final class TorchAgentViewModel: ObservableObject {
    // MARK: - State

    enum ViewState: Equatable {
        case idle
        case checkingPermissions
        case unauthorized
        case ready
        case error(String)

        static func == (lhs: ViewState, rhs: ViewState) -> Bool {
            switch (lhs, rhs) {
            case (.idle, .idle), (.checkingPermissions, .checkingPermissions),
                 (.unauthorized, .unauthorized), (.ready, .ready):
                return true
            case let (.error(a), .error(b)):
                return a == b
            default:
                return false
            }
        }
    }

    @Published var state: ViewState = .idle
    @Published var messages: [TorchAgentMessage] = []
    @Published var sessions: [TorchAgentSession] = []
    @Published var sessionId: String?
    @Published var isStreaming = false
    @Published var streamingContent = ""
    @Published var streamingThinking = ""
    @Published var currentToolUses: [ToolUseBlock] = []
    @Published var tokenCount: Int = 0
    @Published var elapsedTime: TimeInterval = 0
    @Published var shareURL: String?
    @Published var showShareAlert = false
    @Published var showShareError = false
    @Published var shareErrorMessage = ""
    @Published var feedbackSubmitted: Int?
    @Published var username: String?

    // MARK: - Dependencies

    private let apiClient: APIClientProtocol
    private var streamTask: Task<Void, Never>?
    private var timerTask: Task<Void, Never>?

    // MARK: - Init

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    // Note: In Swift 6 strict concurrency, deinit runs on a non-isolated
    // executor, so we must not access @MainActor-isolated properties directly.
    // Instead, we use nonisolated(unsafe) local copies to cancel the tasks.
    deinit {
        let stream = streamTask
        let timer = timerTask
        stream?.cancel()
        timer?.cancel()
    }

    // MARK: - Permission Check

    func checkPermissions() async {
        state = .checkingPermissions
        do {
            let permission: TorchAgentPermission = try await apiClient.fetch(
                .torchAgentCheckPermissions()
            )
            username = permission.username
            if permission.authorized {
                state = .ready
            } else {
                state = .unauthorized
            }
        } catch {
            if let apiError = error as? APIError, case .unauthorized = apiError {
                state = .unauthorized
            } else {
                state = .error(error.localizedDescription)
            }
        }
    }

    // MARK: - Send Query

    func sendQuery(_ query: String) {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard !isStreaming else { return }

        let userMessage = TorchAgentMessage(
            role: .user,
            content: query,
            toolUses: [],
            thinkingContent: nil,
            timestamp: Date()
        )
        messages.append(userMessage)

        streamingContent = ""
        streamingThinking = ""
        currentToolUses = []
        tokenCount = 0
        elapsedTime = 0
        isStreaming = true
        feedbackSubmitted = nil

        startTimer()

        streamTask = Task {
            await performStream(query: query)
        }
    }

    // MARK: - Cancel Stream

    func cancelStream() {
        streamTask?.cancel()
        streamTask = nil
        timerTask?.cancel()
        timerTask = nil
        isStreaming = false

        if !streamingContent.isEmpty || !currentToolUses.isEmpty {
            let assistantMessage = TorchAgentMessage(
                role: .assistant,
                content: streamingContent.isEmpty ? "Response cancelled." : streamingContent,
                toolUses: currentToolUses,
                thinkingContent: streamingThinking.isEmpty ? nil : streamingThinking,
                timestamp: Date()
            )
            messages.append(assistantMessage)
            streamingContent = ""
            streamingThinking = ""
            currentToolUses = []
        }
    }

    // MARK: - Session Management

    func loadSessions() async {
        do {
            // Try decoding as a plain array first
            let loaded: [TorchAgentSession] = try await apiClient.fetch(
                .torchAgentHistory()
            )
            sessions = loaded
        } catch {
            // If array decoding fails, try a wrapped response format
            do {
                struct HistoryResponse: Decodable {
                    let sessions: [TorchAgentSession]?
                    let history: [TorchAgentSession]?
                }
                let wrapped: HistoryResponse = try await apiClient.fetch(
                    .torchAgentHistory()
                )
                sessions = wrapped.sessions ?? wrapped.history ?? []
            } catch {
                // Silently fail; sessions list is non-critical
                sessions = []
            }
        }
    }

    func loadSession(_ session: TorchAgentSession) async {
        sessionId = session.sessionId
        messages = []
        feedbackSubmitted = nil

        do {
            let shared: SharedSession = try await apiClient.fetch(
                .torchAgentChatHistory(sessionId: session.sessionId)
            )
            if let sharedMessages = shared.messages {
                messages = sharedMessages.map { msg in
                    TorchAgentMessage(
                        role: msg.role == "user" ? .user : .assistant,
                        content: msg.content ?? "",
                        toolUses: (msg.toolUses ?? []).map { tool in
                            ToolUseBlock(
                                toolName: tool.name ?? "tool",
                                input: tool.input ?? "",
                                output: tool.output,
                                isExpanded: false
                            )
                        },
                        thinkingContent: nil,
                        timestamp: Date()
                    )
                }
            }
        } catch {
            // Show the error as an assistant message rather than switching
            // the entire view state, so the user stays in the ready state
            let errorMessage = TorchAgentMessage(
                role: .assistant,
                content: "Failed to load session: \(error.localizedDescription)",
                toolUses: [],
                thinkingContent: nil,
                timestamp: Date()
            )
            messages.append(errorMessage)
        }
    }

    func newChat() {
        sessionId = nil
        messages = []
        streamingContent = ""
        streamingThinking = ""
        currentToolUses = []
        isStreaming = false
        tokenCount = 0
        elapsedTime = 0
        feedbackSubmitted = nil
        streamTask?.cancel()
        timerTask?.cancel()
    }

    // MARK: - Share

    func shareSession() async {
        guard let sessionId else {
            shareErrorMessage = "No active session to share."
            showShareError = true
            return
        }

        do {
            struct ShareResponse: Decodable {
                let uuid: String?
                let url: String?
            }
            let response: ShareResponse = try await apiClient.fetch(
                .torchAgentShare(sessionId: sessionId)
            )
            if let url = response.url {
                shareURL = url
            } else if let uuid = response.uuid {
                shareURL = "https://hud.pytorch.org/torchagent/shared/\(uuid)"
            }
            showShareAlert = true
        } catch {
            shareErrorMessage = error.localizedDescription
            showShareError = true
        }
    }

    // MARK: - Feedback

    func submitFeedback(_ rating: Int) async {
        guard let sessionId else { return }

        do {
            let _: Data = try await apiClient.fetchRaw(
                .torchAgentFeedback(sessionId: sessionId, feedback: rating)
            )
            feedbackSubmitted = rating
        } catch {
            // Silently fail on feedback
        }
    }

    // MARK: - Private Streaming

    private func performStream(query: String) async {
        let endpoint = APIEndpoint.torchAgentQuery(query: query, sessionId: sessionId)
        let stream = apiClient.stream(endpoint)
        let decoder = JSONDecoder()
        var streamError: Error?

        do {
            for try await data in stream {
                guard !Task.isCancelled else { break }

                let trimmed = data.trimmingNewlines()
                guard !trimmed.isEmpty else { continue }

                // Handle SSE format: lines may start with "data: "
                let jsonData: Data
                if let str = String(data: trimmed, encoding: .utf8),
                   str.hasPrefix("data: ") {
                    let jsonStr = String(str.dropFirst(6))
                    if jsonStr == "[DONE]" { continue }
                    jsonData = Data(jsonStr.utf8)
                } else {
                    jsonData = trimmed
                }

                guard let chunk = try? decoder.decode(TorchAgentStreamChunk.self, from: jsonData) else {
                    continue
                }

                handleChunk(chunk)
            }
        } catch {
            if !Task.isCancelled {
                streamError = error
            }
        }

        // Finalize
        timerTask?.cancel()
        timerTask = nil

        if let streamError, streamingContent.isEmpty && currentToolUses.isEmpty {
            // No partial content; show the error as an assistant message
            let errorMessage = TorchAgentMessage(
                role: .assistant,
                content: "An error occurred: \(streamError.localizedDescription)",
                toolUses: [],
                thinkingContent: nil,
                timestamp: Date()
            )
            messages.append(errorMessage)
        } else if !streamingContent.isEmpty || !currentToolUses.isEmpty {
            // Append partial or complete content; note if stream ended with an error
            var content = streamingContent
            if streamError != nil {
                content += "\n\n*Response may be incomplete due to a connection error.*"
            }
            let assistantMessage = TorchAgentMessage(
                role: .assistant,
                content: content,
                toolUses: currentToolUses,
                thinkingContent: streamingThinking.isEmpty ? nil : streamingThinking,
                timestamp: Date()
            )
            messages.append(assistantMessage)
        }

        streamingContent = ""
        streamingThinking = ""
        currentToolUses = []
        isStreaming = false
    }

    private func handleChunk(_ chunk: TorchAgentStreamChunk) {
        if let sid = chunk.sessionId {
            sessionId = sid
        }

        // Handle the `done` boolean field (some backends send this instead of type "done")
        if chunk.done == true {
            return
        }

        guard let type = chunk.type else {
            // No type field; treat any content as text
            if let content = chunk.content {
                streamingContent += content
                tokenCount += estimateTokens(content)
            }
            return
        }

        switch type {
        case "text", "content":
            if let content = chunk.content {
                streamingContent += content
                tokenCount += estimateTokens(content)
            }

        case "thinking":
            if let thinking = chunk.thinkingContent {
                streamingThinking += thinking
            }

        case "tool_use":
            if let toolName = chunk.toolName {
                let block = ToolUseBlock(
                    toolName: toolName,
                    input: chunk.toolInput ?? "",
                    output: nil,
                    isExpanded: false
                )
                currentToolUses.append(block)
            }

        case "tool_result":
            if let result = chunk.toolResult, !currentToolUses.isEmpty {
                let last = currentToolUses.removeLast()
                let updated = ToolUseBlock(
                    toolName: last.toolName,
                    input: last.input,
                    output: result,
                    isExpanded: last.isExpanded
                )
                currentToolUses.append(updated)
            }

        case "done":
            // Stream complete; will finalize in performStream
            break

        case "error":
            if let content = chunk.content {
                streamingContent += "\n\n**Error:** \(content)"
            }

        default:
            if let content = chunk.content {
                streamingContent += content
                tokenCount += estimateTokens(content)
            }
        }
    }

    private func startTimer() {
        timerTask?.cancel()
        let startTime = Date()
        timerTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard !Task.isCancelled else { break }
                elapsedTime = Date().timeIntervalSince(startTime)
            }
        }
    }

    private func estimateTokens(_ text: String) -> Int {
        // Rough estimate: ~4 characters per token
        max(1, text.count / 4)
    }
}

// MARK: - Data Extension

private extension Data {
    func trimmingNewlines() -> Data {
        guard let str = String(data: self, encoding: .utf8) else { return self }
        let trimmed = str.trimmingCharacters(in: .whitespacesAndNewlines)
        return Data(trimmed.utf8)
    }
}
