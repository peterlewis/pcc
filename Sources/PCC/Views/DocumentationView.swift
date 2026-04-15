import SwiftUI
import WebKit

struct DocumentationView: View {
    @StateObject private var browser = BrowserState()
    @State private var urlText = "https://mitxela.com/projects/precision_clock_mk_iv/docs"

    var body: some View {
        VStack(spacing: 0) {
            // Navigation toolbar
            HStack(spacing: 6) {
                Button(action: browser.goBack) {
                    Image(systemName: "chevron.left")
                }
                .disabled(!browser.canGoBack)
                .buttonStyle(.borderless)

                Button(action: browser.goForward) {
                    Image(systemName: "chevron.right")
                }
                .disabled(!browser.canGoForward)
                .buttonStyle(.borderless)

                if browser.isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 16, height: 16)
                } else {
                    Button(action: browser.reload) {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                }

                TextField("URL", text: $urlText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { browser.load(urlText) }

                Menu {
                    Button("Precision Clock Mk IV") {
                        navigate("https://mitxela.com/projects/precision_clock_mk_iv")
                    }
                    Button("Mitxela Projects") {
                        navigate("https://mitxela.com/projects")
                    }
                } label: {
                    Image(systemName: "bookmark")
                }
                .menuStyle(.borderlessButton)
                .frame(width: 24)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            Divider()

            BrowserWebView(state: browser, onURLChange: { urlText = $0 })
        }
        .onAppear { browser.load(urlText) }
    }

    private func navigate(_ url: String) {
        urlText = url
        browser.load(url)
    }
}

// MARK: - Browser State

private class BrowserState: ObservableObject {
    let webView = WKWebView()
    @Published var canGoBack = false
    @Published var canGoForward = false
    @Published var isLoading = false

    func load(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        webView.load(URLRequest(url: url))
    }

    func goBack() { webView.goBack() }
    func goForward() { webView.goForward() }
    func reload() { webView.reload() }
}

// MARK: - WKWebView Wrapper

private struct BrowserWebView: NSViewRepresentable {
    let state: BrowserState
    let onURLChange: (String) -> Void

    func makeNSView(context: Context) -> WKWebView {
        state.webView.navigationDelegate = context.coordinator
        return state.webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(state: state, onURLChange: onURLChange)
    }

    class Coordinator: NSObject, WKNavigationDelegate {
        let state: BrowserState
        let onURLChange: (String) -> Void
        private var observers: [NSKeyValueObservation] = []

        init(state: BrowserState, onURLChange: @escaping (String) -> Void) {
            self.state = state
            self.onURLChange = onURLChange
            super.init()

            observers.append(state.webView.observe(\.isLoading) { [weak self] wv, _ in
                DispatchQueue.main.async {
                    self?.state.isLoading = wv.isLoading
                    self?.state.canGoBack = wv.canGoBack
                    self?.state.canGoForward = wv.canGoForward
                }
            })

            observers.append(state.webView.observe(\.url) { [weak self] wv, _ in
                DispatchQueue.main.async {
                    if let url = wv.url?.absoluteString {
                        self?.onURLChange(url)
                    }
                }
            })
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            state.isLoading = false
            state.canGoBack = webView.canGoBack
            state.canGoForward = webView.canGoForward
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            state.isLoading = true
        }
    }
}
