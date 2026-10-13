import Foundation

public struct ChatDelta: Sendable, Equatable {
    public var content: String = ""
    public var reasoning: String = ""
    public var finishReason: String?
    public var model: String?
    public init(content: String = "", reasoning: String = "", finishReason: String? = nil, model: String? = nil) {
        self.content = content; self.reasoning = reasoning; self.finishReason = finishReason; self.model = model
    }
}

public enum LLMError: LocalizedError {
    case http(Int, String)
    case stream(String)
    case noModel(String)

    public var errorDescription: String? {
        switch self {
        case .http(let code, let msg): return "The model server answered \(code): \(msg)"
        case .stream(let msg): return msg
        case .noModel(let msg): return msg
        }
    }
}

/// Server-sent-events helpers for OpenAI-compatible streaming.
public enum SSE {
    public enum Line: Equatable { case data(String), done, ignore }

    public static func classify(_ raw: String) -> Line {
        let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard line.hasPrefix("data:") else { return .ignore }  // comments (": ping"), event:, id:, blanks
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        if payload == "[DONE]" { return .done }
        return payload.isEmpty ? .ignore : .data(payload)
    }

    /// Decode one chunk. Throws if the chunk carries an error object.
    public static func decode(_ json: String) throws -> ChatDelta? {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return nil }
        if let err = obj["error"] {
            if let e = err as? [String: Any], let m = e["message"] as? String { throw LLMError.stream(m) }
            throw LLMError.stream(String(describing: err))
        }
        var d = ChatDelta()
        d.model = obj["model"] as? String
        if let choice = (obj["choices"] as? [[String: Any]])?.first {
            d.finishReason = choice["finish_reason"] as? String
            if let delta = choice["delta"] as? [String: Any] {
                d.content = delta["content"] as? String ?? ""
                d.reasoning = (delta["reasoning_content"] as? String) ?? (delta["reasoning"] as? String) ?? ""
            }
        }
        return d
    }

    /// Pull a readable message out of an error body.
    public static func errorMessage(from body: Data) -> String {
        if let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            if let e = obj["error"] as? [String: Any], let m = e["message"] as? String { return m }
            if let e = obj["error"] as? String { return e }
            if let m = obj["message"] as? String { return m }
        }
        let s = String(decoding: body.prefix(600), as: UTF8.self)
        return s.isEmpty ? "(empty response)" : s
    }
}

public final class LLMClient: @unchecked Sendable {
    public let settings: LLMSettings
    private let session: URLSession

    public init(settings: LLMSettings, session: URLSession? = nil) {
        self.settings = settings
        if let session { self.session = session } else {
            let cfg = URLSessionConfiguration.default
            cfg.timeoutIntervalForRequest = 900   // local models can take a while to load
            cfg.timeoutIntervalForResource = 3600
            self.session = URLSession(configuration: cfg)
        }
    }

    private func authorize(_ req: inout URLRequest) {
        if let key = settings.apiKey { req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
        if settings.provider == .openrouter {
            req.setValue("https://github.com/equation-explainer", forHTTPHeaderField: "HTTP-Referer")
            req.setValue("Equation Explainer", forHTTPHeaderField: "X-Title")
        }
    }

    /// The configured model, or (LM Studio) the loaded one, or the first chat model on the server.
    public func resolveModel() async throws -> String {
        if let m = settings.model { return m }
        var root = settings.baseURL.absoluteString
        if root.hasSuffix("/v1") { root.removeLast(3) }
        if let url = URL(string: root + "/api/v0/models") {
            var req = URLRequest(url: url, timeoutInterval: 5)
            authorize(&req)
            if let (data, resp) = try? await session.data(for: req), (resp as? HTTPURLResponse)?.statusCode == 200,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let list = obj["data"] as? [[String: Any]] {
                let llms = list.filter { ["llm", "vlm"].contains($0["type"] as? String ?? "") }
                if let pick = llms.first(where: { ($0["state"] as? String) == "loaded" }) ?? llms.first,
                   let id = pick["id"] as? String { return id }
            }
        }
        var req = URLRequest(url: settings.baseURL.appendingPathComponent("models"), timeoutInterval: 8)
        authorize(&req)
        let (data, resp) = try await session.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw LLMError.noModel("Could not list models at \(settings.baseURL.absoluteString): \(SSE.errorMessage(from: data))")
        }
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let ids = (obj?["data"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
        guard let id = ids.first(where: { !$0.lowercased().contains("embed") }) else {
            throw LLMError.noModel("No chat model available at \(settings.baseURL.absoluteString). Load one in LM Studio or set LMSTUDIO_MODEL.")
        }
        return id
    }

    public func makeRequest(model: String, messages: [[String: String]]) throws -> URLRequest {
        var body: [String: Any] = ["model": model, "messages": messages, "stream": true]
        if let t = settings.temperature { body["temperature"] = t }
        if let m = settings.maxTokens { body["max_tokens"] = m }
        if let e = settings.extraBodyJSON,
           let extra = try? JSONSerialization.jsonObject(with: Data(e.utf8)) as? [String: Any] {
            body.merge(extra) { _, new in new }
        }
        var req = URLRequest(url: settings.baseURL.appendingPathComponent("chat/completions"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        authorize(&req)
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        return req
    }

    /// Stream a chat completion as deltas. Cancel the consuming task to stop.
    public func stream(messages: [[String: String]]) -> AsyncThrowingStream<ChatDelta, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let model = try await resolveModel()
                    continuation.yield(ChatDelta(model: model))
                    let req = try makeRequest(model: model, messages: messages)
                    let (bytes, resp) = try await session.bytes(for: req)
                    let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
                    if status != 200 {
                        var body = Data()
                        for try await b in bytes { body.append(b); if body.count > 16_000 { break } }
                        throw LLMError.http(status, SSE.errorMessage(from: body))
                    }
                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        switch SSE.classify(line) {
                        case .ignore: continue
                        case .done: continuation.finish(); return
                        case .data(let json):
                            if let d = try SSE.decode(json) { continuation.yield(d) }
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
