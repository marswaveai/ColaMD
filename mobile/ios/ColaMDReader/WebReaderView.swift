import SwiftUI
import WebKit

struct WebReaderView: UIViewRepresentable {
    @Environment(\.colorScheme) private var colorScheme

    let document: ReaderDocument
    let theme: ReaderTheme
    let fontSize: ReaderFontSize

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.websiteDataStore = .nonPersistent()

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView

        NotificationCenter.default.addObserver(
            context.coordinator,
            selector: #selector(Coordinator.scrollToHeading(_:)),
            name: .readerScrollToHeading,
            object: nil
        )

        guard let indexURL = Bundle.main.url(forResource: "reader", withExtension: "html") else {
            return webView
        }
        webView.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.pendingPayload = payload
        context.coordinator.renderIfReady()
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        NotificationCenter.default.removeObserver(coordinator)
        uiView.navigationDelegate = nil
    }

    private var payload: String {
        let body: [String: Any] = [
            "markdown": document.content,
            "theme": resolvedTheme,
            "fontSize": fontSize.rawValue
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body),
              let json = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return json
    }

    private var resolvedTheme: String {
        if theme == .system {
            return colorScheme == .dark ? "dark" : "light"
        }
        return theme.rawValue
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        weak var webView: WKWebView?
        var pendingPayload: String?
        private var isReady = false

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            isReady = true
            renderIfReady()
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard navigationAction.navigationType == .linkActivated,
                  let url = navigationAction.request.url,
                  let scheme = url.scheme?.lowercased(),
                  ["http", "https", "mailto"].contains(scheme) else {
                decisionHandler(.allow)
                return
            }
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        }

        func renderIfReady() {
            guard isReady, let pendingPayload else { return }
            self.pendingPayload = nil
            webView?.evaluateJavaScript("window.ColaMDReader.render(\(pendingPayload));")
        }

        @objc func scrollToHeading(_ notification: Notification) {
            guard let identifier = notification.object as? String,
                  let jsonData = try? JSONSerialization.data(withJSONObject: [identifier]),
                  let json = String(data: jsonData, encoding: .utf8) else {
                return
            }
            webView?.evaluateJavaScript("window.ColaMDReader.scrollToHeading(\(json));")
        }
    }
}
