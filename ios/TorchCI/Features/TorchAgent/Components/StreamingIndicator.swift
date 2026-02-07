import SwiftUI

struct StreamingIndicator: View {
    let elapsedTime: TimeInterval
    let tokenCount: Int
    let thinkingContent: String
    var toolCount: Int = 0
    var hasContent: Bool = false

    @State private var dotCount = 0
    @State private var isThinkingExpanded = false

    /// Describes the current processing phase based on available signals.
    var phaseLabel: String {
        if hasContent {
            return "Generating response"
        } else if toolCount > 0 {
            return "Running tools"
        } else if !thinkingContent.isEmpty {
            return "Reasoning"
        } else {
            return "Thinking"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Main thinking indicator
            HStack(spacing: 12) {
                PulsingDots()

                VStack(alignment: .leading, spacing: 3) {
                    Text("\(phaseLabel)\(dots)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .contentTransition(.interpolate)
                        .animation(.easeInOut(duration: 0.3), value: phaseLabel)

                    HStack(spacing: 8) {
                        // Elapsed time
                        HStack(spacing: 4) {
                            Image(systemName: "clock")
                                .font(.caption2)
                            Text(Self.formatElapsedTime(elapsedTime))
                                .font(.caption.monospacedDigit())
                        }
                        .foregroundStyle(.secondary)

                        // Token counter
                        if tokenCount > 0 {
                            Circle()
                                .fill(Color(.separator))
                                .frame(width: 3, height: 3)

                            HStack(spacing: 4) {
                                Image(systemName: "text.word.spacing")
                                    .font(.caption2)

                                Text("\(tokenCount)")
                                    .font(.caption.monospacedDigit())
                                    .contentTransition(.numericText())
                            }
                            .foregroundStyle(.secondary)
                            .animation(.default, value: tokenCount)
                        }

                        // Tool count
                        if toolCount > 0 {
                            Circle()
                                .fill(Color(.separator))
                                .frame(width: 3, height: 3)

                            HStack(spacing: 4) {
                                Image(systemName: "wrench")
                                    .font(.caption2)

                                Text("\(toolCount) tool\(toolCount == 1 ? "" : "s")")
                                    .font(.caption)
                            }
                            .foregroundStyle(.secondary)
                        }
                    }
                }

                Spacer()
            }

            // Thinking content preview
            if !thinkingContent.isEmpty {
                Divider()
                    .padding(.vertical, 2)

                DisclosureGroup(isExpanded: $isThinkingExpanded) {
                    Text(thinkingContent)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .lineLimit(12)
                        .padding(.top, 6)
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "brain")
                            .font(.caption2)
                        Text("Internal reasoning")
                            .font(.caption.weight(.medium))
                    }
                    .foregroundStyle(.secondary)
                }
                .tint(.secondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(Color(.tertiarySystemBackground))
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .strokeBorder(Color.accentColor.opacity(0.2), lineWidth: 1)
                )
        )
        .shadow(color: Color.accentColor.opacity(0.08), radius: 4, x: 0, y: 2)
        .task {
            // Automatically cancelled when the view is removed from the hierarchy
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                guard !Task.isCancelled else { break }
                dotCount = (dotCount + 1) % 3
            }
        }
    }

    private var dots: String {
        String(repeating: ".", count: dotCount + 1)
    }

    static func formatElapsedTime(_ elapsedTime: TimeInterval) -> String {
        let seconds = Int(elapsedTime)
        if seconds < 60 {
            return "\(seconds)s"
        } else {
            let minutes = seconds / 60
            let remaining = seconds % 60
            return "\(minutes)m \(remaining)s"
        }
    }
}

// MARK: - Pulsing Dots Animation

struct PulsingDots: View {
    @State private var phase: CGFloat = 0

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [Color.accentColor, Color.accentColor.opacity(0.6)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 8, height: 8)
                    .scaleEffect(scaleForDot(index))
                    .opacity(opacityForDot(index))
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: false)) {
                phase = 1
            }
        }
    }

    private func scaleForDot(_ index: Int) -> CGFloat {
        let offset = Double(index) / 3.0
        let adjustedPhase = (phase + offset).truncatingRemainder(dividingBy: 1.0)
        let scale = 0.6 + 0.4 * sin(adjustedPhase * 2 * .pi)
        return scale
    }

    private func opacityForDot(_ index: Int) -> Double {
        let offset = Double(index) / 3.0
        let adjustedPhase = (phase + offset).truncatingRemainder(dividingBy: 1.0)
        let opacity = 0.4 + 0.6 * sin(adjustedPhase * 2 * .pi)
        return opacity
    }
}

// MARK: - Inline Streaming Text

struct InlineStreamingText: View {
    let text: String

    @State private var cursorVisible = true

    var body: some View {
        HStack(alignment: .lastTextBaseline, spacing: 2) {
            Text(attributedText)
                .font(.body)
                .textSelection(.enabled)

            if cursorVisible {
                RoundedRectangle(cornerRadius: 1)
                    .fill(Color.accentColor)
                    .frame(width: 2.5, height: 18)
                    .animation(.easeInOut(duration: 0.1), value: cursorVisible)
            }
        }
        .task {
            // Automatically cancelled when the view is removed from the hierarchy
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(530))
                guard !Task.isCancelled else { break }
                cursorVisible.toggle()
            }
        }
    }

    private var attributedText: AttributedString {
        (try? AttributedString(markdown: text, options: .init(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        ))) ?? AttributedString(text)
    }
}

#Preview {
    VStack(spacing: 20) {
        StreamingIndicator(
            elapsedTime: 12.5,
            tokenCount: 342,
            thinkingContent: "Let me analyze the CI data to find the failures..."
        )

        InlineStreamingText(text: "The current CI status shows **3 failures** on main branch...")
    }
    .padding()
}
