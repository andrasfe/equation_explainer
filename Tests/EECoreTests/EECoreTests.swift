import XCTest
@testable import EECore

final class DotEnvTests: XCTestCase {
    func testParsesQuotesCommentsAndExport() {
        let env = DotEnv.parse("""
        # comment
        export LLM_PROVIDER=openrouter
        OPENROUTER_API_KEY="sk-or-abc#notacomment"
        LMSTUDIO_MODEL=qwen # trailing comment
        EMPTY=
        SINGLE='a b'
        """)
        XCTAssertEqual(env["LLM_PROVIDER"], "openrouter")
        XCTAssertEqual(env["OPENROUTER_API_KEY"], "sk-or-abc#notacomment")
        XCTAssertEqual(env["LMSTUDIO_MODEL"], "qwen")
        XCTAssertEqual(env["EMPTY"], "")
        XCTAssertEqual(env["SINGLE"], "a b")
    }
}

final class ConfigTests: XCTestCase {
    func testLMStudioDefaults() {
        let c = AppConfig.resolve(values: ["LLM_PROVIDER": "lmstudio"], envFile: nil)
        XCTAssertEqual(c.llm.provider, .lmstudio)
        XCTAssertEqual(c.llm.baseURL.absoluteString, "http://localhost:1234/v1")
        XCTAssertNil(c.llm.model)
        XCTAssertTrue(c.problems.isEmpty)
        XCTAssertEqual(c.python.packages, ["numpy", "sympy", "scipy", "matplotlib"])
    }

    func testOpenRouterInferredFromKey() {
        let c = AppConfig.resolve(values: ["OPENROUTER_API_KEY": "k", "OPENROUTER_MODEL": "x/y"], envFile: nil)
        XCTAssertEqual(c.llm.provider, .openrouter)
        XCTAssertEqual(c.llm.apiKey, "k")
        XCTAssertEqual(c.llm.model, "x/y")
        XCTAssertEqual(c.llm.baseURL.absoluteString, "https://openrouter.ai/api/v1")
    }

    func testOpenRouterWithoutKeyIsAProblem() {
        let c = AppConfig.resolve(values: ["LLM_PROVIDER": "openrouter"], envFile: nil)
        XCTAssertEqual(c.llm.model, AppConfig.defaultOpenRouterModel)
        XCTAssertFalse(c.problems.isEmpty)
    }

    func testTrailingSlashAndBadExtraBody() {
        let c = AppConfig.resolve(values: ["LMSTUDIO_BASE_URL": "http://box:1234/v1/", "LLM_EXTRA_BODY": "nope"], envFile: nil)
        XCTAssertEqual(c.llm.baseURL.absoluteString, "http://box:1234/v1")
        XCTAssertNil(c.llm.extraBodyJSON)
        XCTAssertEqual(c.problems.count, 1)
    }
}

final class SSETests: XCTestCase {
    func testClassify() {
        XCTAssertEqual(SSE.classify(": OPENROUTER PROCESSING"), .ignore)
        XCTAssertEqual(SSE.classify(""), .ignore)
        XCTAssertEqual(SSE.classify("data: [DONE]"), .done)
        XCTAssertEqual(SSE.classify("data: {\"a\":1}"), .data("{\"a\":1}"))
    }

    func testDecodeContentAndReasoning() throws {
        let d = try SSE.decode(#"{"model":"m","choices":[{"delta":{"content":"Hi","reasoning_content":"hmm"},"finish_reason":null}]}"#)
        XCTAssertEqual(d?.content, "Hi")
        XCTAssertEqual(d?.reasoning, "hmm")
        XCTAssertEqual(d?.model, "m")
        let r = try SSE.decode(#"{"choices":[{"delta":{"reasoning":"or-style"},"finish_reason":"stop"}]}"#)
        XCTAssertEqual(r?.reasoning, "or-style")
        XCTAssertEqual(r?.finishReason, "stop")
    }

    func testDecodeErrorThrows() {
        XCTAssertThrowsError(try SSE.decode(#"{"error":{"message":"rate limited"}}"#))
    }

    func testErrorMessage() {
        XCTAssertEqual(SSE.errorMessage(from: Data(#"{"error":{"message":"bad key"}}"#.utf8)), "bad key")
        XCTAssertEqual(SSE.errorMessage(from: Data(#"{"error":"no model"}"#.utf8)), "no model")
    }

    func testRequestBodyMergesExtra() throws {
        let s = LLMSettings(provider: .openrouter, baseURL: URL(string: "https://openrouter.ai/api/v1")!, apiKey: "k",
                            model: "m", temperature: 0.2, maxTokens: 100, extraBodyJSON: #"{"reasoning":{"effort":"low"}}"#)
        let req = try LLMClient(settings: s).makeRequest(model: "m", messages: [["role": "user", "content": "hi"]])
        XCTAssertEqual(req.url?.absoluteString, "https://openrouter.ai/api/v1/chat/completions")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer k")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Title"), "Equation Explainer")
        let body = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: Any]
        XCTAssertEqual(body["stream"] as? Bool, true)
        XCTAssertEqual(body["max_tokens"] as? Int, 100)
        XCTAssertNotNil(body["reasoning"])
    }
}

final class BoardStoreTests: XCTestCase {
    func testSaveListRenameDelete() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ee-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = BoardStore(dir: dir)
        let json = #"{"id":"b1","title":"Grover","createdAt":1000,"updatedAt":2000,"threads":{"root":{},"t1":{},"t2":{}}}"#
        let s = try store.save("b1", data: Data(json.utf8))
        XCTAssertEqual(s?.title, "Grover")
        XCTAssertEqual(s?.branchCount, 2)
        XCTAssertEqual(store.list().map(\.id), ["b1"])
        let renamed = try store.rename("b1", title: "QFT")
        XCTAssertEqual(BoardStore.summary(from: renamed)?.title, "QFT")
        XCTAssertThrowsError(try store.save("../evil", data: Data()))
    }
}

final class PythonRunnerTests: XCTestCase {
    func testRunsCellWithExplicitInterpreter() async throws {
        guard let py = ["/opt/homebrew/bin/python3", "/usr/bin/python3"].first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            throw XCTSkip("no python3")
        }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("ee-py-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        let kit = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App/Python")
        let runner = PythonRunner(supportDir: tmp, kitDir: kit)
        let settings = PythonSettings(interpreter: py, packages: [], timeout: 20)
        let ok = try await runner.run(id: "a", code: "print('$$x^2$$')\n", settings: settings) { _ in }
        XCTAssertEqual(ok.exitCode, 0)
        XCTAssertEqual(ok.stdout, "$$x^2$$\n")
        let bad = try await runner.run(id: "b", code: "x = 1\nraise ValueError('nope')\n", settings: settings) { _ in }
        XCTAssertEqual(bad.exitCode, 1)
        XCTAssertTrue(bad.stderr.contains("ValueError: nope"))
        XCTAssertTrue(bad.stderr.contains("raise ValueError"))
        XCTAssertFalse(bad.stderr.contains("runner.py"))
        let slow = try await runner.run(id: "c", code: "import time\ntime.sleep(30)\n",
                                        settings: PythonSettings(interpreter: py, packages: [], timeout: 1)) { _ in }
        XCTAssertTrue(slow.timedOut)
    }
}
