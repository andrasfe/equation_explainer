import AppKit
import WebKit

/// Serves the bundled blackboard UI from ee-app://board/… so the page has a real
/// origin (strict CSP with 'self', localStorage) without touching the network.
@MainActor
final class LocalSchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL
    init(root: URL) { self.root = root.standardizedFileURL }

    static let mime: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
        "png": "image/png", "svg": "image/svg+xml", "woff2": "font/woff2", "woff": "font/woff", "ttf": "font/ttf",
        "json": "application/json",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            return task.didFailWithError(URLError(.fileDoesNotExist))
        }
        let type = Self.mime[file.pathExtension.lowercased()] ?? "application/octet-stream"
        let resp = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": type, "Content-Length": "\(data.count)", "Cache-Control": "no-store"])!
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

/// Owns the web view and the JS ⇄ Swift bridge.
@MainActor
final class WebController: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    let webView: WKWebView
    weak var model: AppModel?
    private var pending: [String: (content: String, reasoning: String)] = [:]
    private var pendingOrder: [String] = []
    private var flushScheduled = false

    init(webRoot: URL) {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(LocalSchemeHandler(root: webRoot), forURLScheme: "ee-app")
        config.userContentController = WKUserContentController()
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "ee")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = true
        webView.isInspectable = true
        webView.underPageBackgroundColor = NSColor(red: 0.15, green: 0.10, blue: 0.06, alpha: 1)
        webView.setValue(false, forKey: "drawsBackground")
    }

    func load() {
        webView.load(URLRequest(url: URL(string: "ee-app://board/index.html")!))
    }

    // MARK: JS → Swift

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            return (nil, "Malformed message")
        }
        guard let model else { return (nil, "App is shutting down") }
        do {
            return (try await model.handle(cmd, body) ?? NSNull(), nil)
        } catch {
            return (nil, error.localizedDescription)
        }
    }

    // MARK: Swift → JS

    func call(_ function: String, _ arg: [String: Any] = [:]) {
        webView.callAsyncJavaScript("\(function)(a)", arguments: ["a": arg], in: nil, in: .page) { result in
            if case .failure(let error) = result { NSLog("JS call %@ failed: %@", function, error.localizedDescription) }
        }
    }

    func callAndWait(_ body: String) async {
        _ = try? await webView.callAsyncJavaScript(body, arguments: [:], in: nil, contentWorld: .page)
    }

    func command(_ name: String) { call("EE.native.command", ["name": name]) }

    /// Tokens arrive fast; batch them into ~30 ms frames.
    func enqueueChunk(id: String, content: String, reasoning: String) {
        if pending[id] == nil { pendingOrder.append(id); pending[id] = ("", "") }
        pending[id]!.content += content
        pending[id]!.reasoning += reasoning
        guard !flushScheduled else { return }
        flushScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { [weak self] in self?.flushChunks() }
    }

    func flushChunks() {
        flushScheduled = false
        for id in pendingOrder {
            if let p = pending[id] { call("EE.native.chunk", ["id": id, "content": p.content, "reasoning": p.reasoning]) }
        }
        pending.removeAll()
        pendingOrder.removeAll()
    }

    func finishChat(id: String, model: String?, finish: String?) {
        flushChunks()
        call("EE.native.done", ["id": id, "model": model ?? "", "finish": finish ?? ""])
    }

    func failChat(id: String, message: String) {
        flushChunks()
        call("EE.native.error", ["id": id, "message": message])
    }

    func snapshotPNG() async throws -> Data {
        let image = try await webView.takeSnapshot(configuration: nil)
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            throw NSError(domain: "EE", code: 1, userInfo: [NSLocalizedDescriptionKey: "Snapshot encoding failed"])
        }
        return png
    }

    // MARK: navigation: keep the board in-app, send links to the browser

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url.scheme == "ee-app" || url.scheme == "about" { return .allow }
        if ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return .cancel
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        NSLog("Web content process terminated; reloading board")
        load()
    }
}
