import SwiftUI

struct AboutView: View {
    @State private var showingSafariURL: IdentifiableURL?

    var body: some View {
        List {
            appInfoSection
            linksSection
            acknowledgementsSection
            footerSection
        }
        .navigationTitle("About")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $showingSafariURL) { item in
            SafariView(url: item.url)
                .ignoresSafeArea()
        }
    }

    // MARK: - Constants

    static let appDescription = "Monitor PyTorch CI/CD workflows, track build health, review pull requests, and stay updated on the PyTorch continuous integration pipeline\u{2014}right from your iPhone."

    static let copyrightNotice = "\u{00A9} 2024-2026 PyTorch Contributors"

    static let links: [(title: String, subtitle: String, icon: String, urlString: String)] = [
        (title: "PyTorch HUD", subtitle: "hud.pytorch.org", icon: "chart.bar.doc.horizontal", urlString: "https://hud.pytorch.org"),
        (title: "GitHub Repository", subtitle: "pytorch/test-infra", icon: "chevron.left.forwardslash.chevron.right", urlString: "https://github.com/pytorch/test-infra"),
        (title: "Documentation", subtitle: "PyTorch CI/CD documentation", icon: "book", urlString: "https://github.com/pytorch/test-infra/blob/main/README.md"),
        (title: "Report an Issue", subtitle: "Bug reports and feature requests", icon: "exclamationmark.bubble", urlString: "https://github.com/pytorch/test-infra/issues/new"),
        (title: "PyTorch Website", subtitle: "pytorch.org", icon: "globe", urlString: "https://pytorch.org"),
    ]

    // MARK: - Version Info

    static func formattedVersion(from bundle: Bundle = .main) -> String {
        let version = bundle.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = bundle.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "v\(version) (\(build))"
    }

    private var appVersion: String {
        Self.formattedVersion()
    }

    // MARK: - App Info Section

    private var appInfoSection: some View {
        Section {
            VStack(spacing: 16) {
                // App icon - use actual app icon from asset catalog
                if let image = UIImage(named: "AppIcon") {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 80, height: 80)
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .shadow(color: .black.opacity(0.1), radius: 4, x: 0, y: 2)
                        .padding(.top, 8)
                } else {
                    // Fallback to system icon if app icon not found
                    Image(systemName: "flame")
                        .font(.system(size: 56))
                        .foregroundStyle(
                            LinearGradient(
                                colors: [.orange, .red],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .padding(.top, 8)
                }

                // App name and version
                VStack(spacing: 4) {
                    Text("TorchCI")
                        .font(AppTypography.largeTitle)

                    Text(appVersion)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                // Description
                Text(Self.appDescription)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
            }
            .frame(maxWidth: .infinity)
        }
        .listRowBackground(Color.clear)
    }

    // MARK: - Links Section

    private var linksSection: some View {
        Section {
            ForEach(Array(Self.links.enumerated()), id: \.offset) { _, link in
                linkRow(
                    title: link.title,
                    subtitle: link.subtitle,
                    icon: link.icon,
                    urlString: link.urlString
                )
            }
        } header: {
            Text("Links")
        }
    }

    // MARK: - Acknowledgements Section

    private var acknowledgementsSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 12) {
                Text("Built with love for the PyTorch community")
                    .font(.callout)
                    .foregroundStyle(.secondary)

                Text("This app is part of the PyTorch test infrastructure project and uses zero third-party dependencies.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } header: {
            Text("Acknowledgements")
        } footer: {
            Text("TorchCI is open source software. Contributions are welcome!")
                .font(.caption)
        }
    }

    // MARK: - Footer Section

    private var footerSection: some View {
        Section {
            VStack(spacing: 12) {
                HStack(spacing: 6) {
                    Image(systemName: "swift")
                        .font(.body)
                        .foregroundStyle(.orange)
                    Text("Made with SwiftUI")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Text(Self.copyrightNotice)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
        }
        .listRowBackground(Color.clear)
    }

    // MARK: - Link Row

    private func linkRow(title: String, subtitle: String, icon: String, urlString: String) -> some View {
        Button {
            if let url = URL(string: urlString) {
                showingSafariURL = IdentifiableURL(url: url)
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.body)
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 28)

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.body)
                        .foregroundStyle(.primary)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Image(systemName: "arrow.up.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

// MARK: - Identifiable URL Wrapper

/// Wraps a URL to conform to Identifiable for use with .sheet(item:).
/// This avoids relying on a @retroactive Identifiable conformance on URL.
struct IdentifiableURL: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

#Preview {
    NavigationStack {
        AboutView()
    }
}
