import SwiftUI

struct MessageBubble: View {
    let content: String
    let isUser: Bool

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// Adaptive minimum spacer width based on dynamic type size.
    /// Larger text sizes get less reserved space so bubbles can use more width.
    private var minSpacerWidth: CGFloat {
        dynamicTypeSize >= .accessibility1 ? 24 : 44
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if isUser { Spacer(minLength: minSpacerWidth) }

            VStack(alignment: isUser ? .trailing : .leading, spacing: 0) {
                Text(markdownContent)
                    .font(.body)
                    .foregroundStyle(isUser ? .white : .primary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 11)
                    .background(bubbleBackground)
                    .clipShape(ChatBubbleShape(isUser: isUser))
                    .shadow(
                        color: shadowColor,
                        radius: shadowRadius,
                        x: 0,
                        y: 1
                    )
            }

            if !isUser { Spacer(minLength: minSpacerWidth) }
        }
    }

    private var markdownContent: AttributedString {
        (try? AttributedString(markdown: content, options: .init(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        ))) ?? AttributedString(content)
    }

    private var bubbleBackground: some ShapeStyle {
        if isUser {
            return Color.accentColor
        } else {
            return Color(.secondarySystemBackground)
        }
    }

    private var shadowColor: Color {
        if isUser {
            return Color.black.opacity(0.15)
        } else {
            return Color.black.opacity(0.08)
        }
    }

    private var shadowRadius: CGFloat {
        isUser ? 3 : 2
    }
}

// MARK: - Chat Bubble Shape

struct ChatBubbleShape: Shape {
    let isUser: Bool

    func path(in rect: CGRect) -> Path {
        let radius: CGFloat = 18
        let tailSize: CGFloat = 8

        var path = Path()

        if isUser {
            // User bubble: rounded with subtle tail on bottom-right
            let mainRect = CGRect(
                x: rect.minX,
                y: rect.minY,
                width: rect.width - tailSize * 0.5,
                height: rect.height
            )

            // Create rounded rectangle with different corner radii
            path.move(to: CGPoint(x: mainRect.minX + radius, y: mainRect.minY))
            path.addLine(to: CGPoint(x: mainRect.maxX - radius, y: mainRect.minY))
            path.addArc(
                center: CGPoint(x: mainRect.maxX - radius, y: mainRect.minY + radius),
                radius: radius,
                startAngle: .degrees(-90),
                endAngle: .degrees(0),
                clockwise: false
            )
            path.addLine(to: CGPoint(x: mainRect.maxX, y: mainRect.maxY - radius - 4))

            // Tail curve
            path.addQuadCurve(
                to: CGPoint(x: rect.maxX, y: rect.maxY - 6),
                control: CGPoint(x: mainRect.maxX + 2, y: mainRect.maxY - 8)
            )
            path.addQuadCurve(
                to: CGPoint(x: mainRect.maxX - 2, y: mainRect.maxY),
                control: CGPoint(x: mainRect.maxX - 1, y: mainRect.maxY - 1)
            )

            path.addLine(to: CGPoint(x: mainRect.minX + radius, y: mainRect.maxY))
            path.addArc(
                center: CGPoint(x: mainRect.minX + radius, y: mainRect.maxY - radius),
                radius: radius,
                startAngle: .degrees(90),
                endAngle: .degrees(180),
                clockwise: false
            )
            path.addLine(to: CGPoint(x: mainRect.minX, y: mainRect.minY + radius))
            path.addArc(
                center: CGPoint(x: mainRect.minX + radius, y: mainRect.minY + radius),
                radius: radius,
                startAngle: .degrees(180),
                endAngle: .degrees(270),
                clockwise: false
            )
        } else {
            // Assistant bubble: rounded with subtle tail on bottom-left
            let mainRect = CGRect(
                x: rect.minX + tailSize * 0.5,
                y: rect.minY,
                width: rect.width - tailSize * 0.5,
                height: rect.height
            )

            path.move(to: CGPoint(x: mainRect.minX + radius, y: mainRect.minY))
            path.addLine(to: CGPoint(x: mainRect.maxX - radius, y: mainRect.minY))
            path.addArc(
                center: CGPoint(x: mainRect.maxX - radius, y: mainRect.minY + radius),
                radius: radius,
                startAngle: .degrees(-90),
                endAngle: .degrees(0),
                clockwise: false
            )
            path.addLine(to: CGPoint(x: mainRect.maxX, y: mainRect.maxY - radius))
            path.addArc(
                center: CGPoint(x: mainRect.maxX - radius, y: mainRect.maxY - radius),
                radius: radius,
                startAngle: .degrees(0),
                endAngle: .degrees(90),
                clockwise: false
            )

            path.addLine(to: CGPoint(x: mainRect.minX + 2, y: mainRect.maxY))

            // Tail curve
            path.addQuadCurve(
                to: CGPoint(x: rect.minX, y: rect.maxY - 6),
                control: CGPoint(x: mainRect.minX + 1, y: mainRect.maxY - 1)
            )
            path.addQuadCurve(
                to: CGPoint(x: mainRect.minX, y: mainRect.maxY - radius - 4),
                control: CGPoint(x: mainRect.minX - 2, y: mainRect.maxY - 8)
            )

            path.addLine(to: CGPoint(x: mainRect.minX, y: mainRect.minY + radius))
            path.addArc(
                center: CGPoint(x: mainRect.minX + radius, y: mainRect.minY + radius),
                radius: radius,
                startAngle: .degrees(180),
                endAngle: .degrees(270),
                clockwise: false
            )
        }

        return path
    }
}

// MARK: - Markdown Message View

struct MarkdownMessageView: View {
    let content: String

    var body: some View {
        Text(attributedContent)
            .font(.body)
            .textSelection(.enabled)
    }

    private var attributedContent: AttributedString {
        (try? AttributedString(markdown: content, options: .init(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        ))) ?? AttributedString(content)
    }
}

#Preview {
    VStack(spacing: 12) {
        MessageBubble(
            content: "What's the CI status for pytorch/pytorch?",
            isUser: true
        )
        MessageBubble(
            content: "Let me check the current **CI status** for `pytorch/pytorch`...",
            isUser: false
        )
    }
    .padding()
}
