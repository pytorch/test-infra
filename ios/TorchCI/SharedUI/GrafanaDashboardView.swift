import SwiftUI
import WebKit
import UIKit

/// A reusable view that embeds a Grafana public dashboard using WKWebView.
struct GrafanaDashboardView: UIViewRepresentable {
    let dashboardID: String
    @Environment(\.colorScheme) private var colorScheme

    private static let baseURL = "https://disz2yd9jqnwc.cloudfront.net/public-dashboards"

    private var dashboardURL: URL? {
        let theme = colorScheme == .dark ? "dark" : "light"
        return URL(string: "\(Self.baseURL)/\(dashboardID)?theme=\(theme)")
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = UIColor.clear
        webView.scrollView.backgroundColor = UIColor.clear
        webView.navigationDelegate = context.coordinator

        if let url = dashboardURL {
            webView.load(URLRequest(url: url))
        }

        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        let theme = colorScheme == .dark ? "dark" : "light"
        if let currentURL = webView.url?.absoluteString,
           !currentURL.contains("theme=\(theme)") {
            if let url = dashboardURL {
                webView.load(URLRequest(url: url))
            }
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {}
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {}
    }
}
