import SwiftUI

struct ToolUseView: View {
    let toolUse: ToolUseBlock
    @State private var isInputExpanded = false
    @State private var isOutputExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 7)
                        .fill(colorForTool(toolUse.toolName).opacity(0.15))
                        .frame(width: 28, height: 28)

                    Image(systemName: iconForTool(toolUse.toolName))
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(colorForTool(toolUse.toolName))
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(displayNameForTool(toolUse.toolName))
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)

                    if toolUse.output == nil {
                        Text("Running...")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Completed")
                            .font(.caption2)
                            .foregroundStyle(AppColors.success)
                    }
                }

                Spacer()

                if toolUse.output == nil {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(AppColors.success)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)

            Divider()
                .padding(.horizontal, 14)

            // Input Section
            if !toolUse.input.isEmpty {
                DisclosureGroup(isExpanded: $isInputExpanded) {
                    ScrollView {
                        Text(toolUse.input)
                            .font(AppTypography.monospacedSmall)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 120)
                    .background(Color(.tertiarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(Color(.separator).opacity(0.2), lineWidth: 1)
                    )
                    .padding(.horizontal, 14)
                    .padding(.bottom, 10)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "doc.text")
                            .font(.caption2)
                        Text("Input")
                            .font(.caption.weight(.medium))
                    }
                    .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .tint(.secondary)
            }

            // Output Section
            if let output = toolUse.output, !output.isEmpty {
                DisclosureGroup(isExpanded: $isOutputExpanded) {
                    ScrollView {
                        Text(output)
                            .font(AppTypography.monospacedSmall)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 180)
                    .background(Color(.tertiarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(Color(.separator).opacity(0.2), lineWidth: 1)
                    )
                    .padding(.horizontal, 14)
                    .padding(.bottom, 10)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.down.doc")
                            .font(.caption2)
                        Text("Output")
                            .font(.caption.weight(.medium))

                        // Show output preview in collapsed state
                        if !isOutputExpanded {
                            Text(output.prefix(30) + (output.count > 30 ? "..." : ""))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                    }
                    .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .tint(.secondary)
            }
        }
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color(.separator).opacity(0.2), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.04), radius: 2, x: 0, y: 1)
    }

    // MARK: - Tool Metadata

    func iconForTool(_ name: String) -> String {
        let lowered = name.lowercased()
        if lowered.contains("clickhouse") || lowered.contains("query") || lowered.contains("sql") {
            return "cylinder.split.1x2"
        } else if lowered.contains("grafana") || lowered.contains("chart") || lowered.contains("graph") {
            return "chart.xyaxis.line"
        } else if lowered.contains("bash") || lowered.contains("shell") || lowered.contains("exec") {
            return "terminal"
        } else if lowered.contains("github") || lowered.contains("pr") || lowered.contains("issue") {
            return "chevron.left.forwardslash.chevron.right"
        } else if lowered.contains("search") || lowered.contains("find") {
            return "magnifyingglass"
        } else {
            return "wrench"
        }
    }

    func colorForTool(_ name: String) -> Color {
        let lowered = name.lowercased()
        if lowered.contains("clickhouse") || lowered.contains("query") || lowered.contains("sql") {
            return .orange
        } else if lowered.contains("grafana") || lowered.contains("chart") {
            return .purple
        } else if lowered.contains("bash") || lowered.contains("shell") {
            return .green
        } else if lowered.contains("github") {
            return .indigo
        } else {
            return .blue
        }
    }

    func displayNameForTool(_ name: String) -> String {
        let lowered = name.lowercased()
        if lowered.contains("clickhouse") {
            return "ClickHouse Query"
        } else if lowered.contains("grafana") {
            return "Grafana"
        } else if lowered.contains("bash") || lowered.contains("shell") {
            return "Bash Command"
        } else if lowered.contains("github") {
            return "GitHub API"
        } else if lowered.contains("search") {
            return "Search"
        } else {
            return name
        }
    }
}

#Preview {
    VStack(spacing: 12) {
        ToolUseView(toolUse: ToolUseBlock(
            toolName: "clickhouse_query",
            input: "SELECT count() FROM default.workflow_job WHERE created_at > now() - INTERVAL 1 DAY",
            output: "count()\n42567",
            isExpanded: false
        ))

        ToolUseView(toolUse: ToolUseBlock(
            toolName: "bash_command",
            input: "curl -s https://api.github.com/repos/pytorch/pytorch",
            output: nil,
            isExpanded: false
        ))
    }
    .padding()
}
