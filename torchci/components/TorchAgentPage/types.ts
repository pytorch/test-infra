export interface ToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: any;
}

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  tool_use_id?: string;
  content?: { type: string; text: string }[];
}

export interface AssistantMessage {
  id: string;
  type: string;
  role: string;
  content: (ContentBlock | ToolUse)[];
  stop_reason?: string;
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface MessageWrapper {
  type: string;
  message?: AssistantMessage;
  delta?: {
    type: string;
    text?: string;
  };
  error?: string;
  status?: string;
  subtype?: string;
  total_tokens?: number;
  total_cost?: number;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  sessionId?: string;
  resumeSession?: boolean;
  usage?: {
    output_tokens: number;
    input_tokens?: number;
  };
  tool_use_id?: string;
  tool_result?: {
    tool_use_id: string;
    type: string;
    content: { type: string; text: string }[];
  };
}

export interface GrafanaLink {
  fullUrl: string;
  dashboardId: string;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

export type ParsedContent = {
  type: "text" | "tool_use" | "todo_list" | "user_message";
  content: string;
  displayedContent?: string;
  toolName?: string;
  toolInput?: any;
  toolUseId?: string;
  toolResult?: string;
  grafanaLinks?: GrafanaLink[];
  isAnimating?: boolean;
  timestamp?: number;
  outputTokens?: number;
  todoItems?: TodoItem[];
};
