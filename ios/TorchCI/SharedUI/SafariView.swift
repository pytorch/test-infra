import SwiftUI
import SafariServices

struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let config = SFSafariViewController.Configuration()
        config.entersReaderIfAvailable = false
        return SFSafariViewController(url: url, configuration: config)
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}

struct LinkButton: View {
    let title: String
    let url: String
    var icon: String = "link"

    @State private var showingSafari = false

    var body: some View {
        Button {
            if let url = URL(string: url) {
                showingSafari = true
            }
        } label: {
            Label(title, systemImage: icon)
        }
        .sheet(isPresented: $showingSafari) {
            if let url = URL(string: url) {
                SafariView(url: url)
                    .ignoresSafeArea()
            }
        }
    }
}
