import Foundation

struct TorchAgentMessage: Identifiable {
    let id = UUID()
    let role: MessageRole
    let content: String
    let toolUses: [ToolUseBlock]
    let thinkingContent: String?
    let timestamp: Date

    enum MessageRole: String {
        case user, assistant
    }
}

struct ToolUseBlock: Identifiable {
    let id = UUID()
    let toolName: String
    let input: String
    let output: String?
    let isExpanded: Bool
}

struct TorchAgentSession: Decodable, Identifiable {
    let sessionId: String
    let title: String?
    let createdAt: String?
    let updatedAt: String?
    let messageCount: Int?

    var id: String { sessionId }

    var displayDate: String {
        guard let createdAt else { return "" }
        if let date = ISO8601DateFormatter().date(from: createdAt) {
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .short
            return formatter.localizedString(for: date, relativeTo: Date())
        }
        return createdAt
    }

    enum CodingKeys: String, CodingKey {
        case title
        case sessionId = "session_id"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case messageCount = "message_count"
    }
}

struct TorchAgentStreamChunk: Decodable {
    let type: String?
    let content: String?
    let toolName: String?
    let toolInput: String?
    let toolResult: String?
    let thinkingContent: String?
    let sessionId: String?
    let done: Bool?

    enum CodingKeys: String, CodingKey {
        case type, content, done
        case toolName = "tool_name"
        case toolInput = "tool_input"
        case toolResult = "tool_result"
        case thinkingContent = "thinking_content"
        case sessionId = "session_id"
    }
}

struct TorchAgentPermission: Decodable {
    let authorized: Bool
    let username: String?
}

struct SharedSession: Decodable {
    let sessionId: String?
    let title: String?
    let messages: [SharedMessage]?
    let sharedBy: String?
    let sharedAt: String?

    enum CodingKeys: String, CodingKey {
        case title, messages
        case sessionId = "session_id"
        case sharedBy = "shared_by"
        case sharedAt = "shared_at"
    }
}

struct SharedMessage: Decodable, Identifiable {
    let id = UUID()
    let role: String
    let content: String?
    let toolUses: [SharedToolUse]?

    enum CodingKeys: String, CodingKey {
        case role, content
        case toolUses = "tool_uses"
    }
}

struct SharedToolUse: Decodable, Identifiable {
    let id = UUID()
    let name: String?
    let input: String?
    let output: String?

    enum CodingKeys: String, CodingKey {
        case name, input, output
    }
}
