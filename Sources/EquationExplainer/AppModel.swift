import AppKit
import EECore
import SwiftUI
import WebKit

struct SelfTestOptions {
    var outDir: URL
    var keepOpen: Bool
    var prompt: String?
}

@MainActor
final class AppModel: ObservableObject {
    @Published var boards: [BoardSummary] = []
    @Published var selection: String?
    @Published private(set) var currentId: String?
    @Published private(set) var currentTitle = "Equation Explainer"

    let store: BoardStore
    let runner: PythonRunner
    let projectRoot: String?
    let resources: URL
    let web: WebController
    let selfTest: SelfTestOptions?
    private var chats: [String: Task<Void, Never>] = [:]
    private var deleted: Set<String> = []

    init() {
        let fm = FileManager.default
        // Project root: baked into Info.plist by the build script; falls back to the source tree for `swift run`.
        let sourceRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let plistRoot = Bundle.main.object(forInfoDictionaryKey: "EEProjectRoot") as? String
        projectRoot = plistRoot ?? sourceRoot.path

        if let r = Bundle.main.resourceURL, fm.fileExists(atPath: r.appendingPathComponent("Web/index.html").path) {
            resources = r
        } else {
            resources = sourceRoot.appendingPathComponent("App")
        }

        let support = AppPaths.supportDir
        let boardsDir: URL
        if let o = ProcessInfo.processInfo.environment["EE_BOARDS_DIR"], !o.isEmpty {
            boardsDir = URL(fileURLWithPath: (o as NSString).expandingTildeInPath, isDirectory: true)
        } else {
            boardsDir = support.appendingPathComponent("Boards", isDirectory: true)
        }
        store = BoardStore(dir: boardsDir)
        runner = PythonRunner(supportDir: support, kitDir: resources.appendingPathComponent("Python"))
        web = WebController(webRoot: resources.appendingPathComponent("Web"))

        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--selftest"), i + 1 < args.count {
            let dir = URL(fileURLWithPath: (args[i + 1] as NSString).expandingTildeInPath, isDirectory: true)
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let prompt = args.firstIndex(of: "--selftest-prompt").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
            selfTest = SelfTestOptions(outDir: dir, keepOpen: args.contains("--selftest-keep-open"), prompt: prompt)
        } else {
            selfTest = nil
        }

        web.model = self
        boards = store.list()
        web.load()
    }

    var config: AppConfig { AppConfig.load(projectRoot: projectRoot) }

    // MARK: sidebar actions

    func open(_ id: String) {
        guard id != currentId else { return }
        do {
            let data = try store.load(id)
            web.call("EE.native.openBoard", ["json": String(decoding: data, as: UTF8.self)])
        } catch {
            NSLog("open board failed: %@", error.localizedDescription)
            refreshBoards()
        }
    }

    func newBoard() { web.call("EE.native.newBoard") }

    func refreshBoards() { boards = store.list() }

    func rename(_ id: String, to title: String) {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, (try? store.rename(id, title: t)) != nil else { return }
        web.call("EE.native.renamed", ["id": id, "title": t])
        if id == currentId { currentTitle = t }
        refreshBoards()
    }

    func delete(_ id: String) {
        deleted.insert(id)
        try? store.delete(id)
        web.call("EE.native.deleted", ["id": id])
        if selection == id { selection = nil }
        refreshBoards()
    }

    func revealBoardsFolder() { NSWorkspace.shared.activateFileViewerSelecting([store.dir]) }

    func reveal(_ id: String) {
        NSWorkspace.shared.activateFileViewerSelecting([store.dir.appendingPathComponent("\(id).json")])
    }

    func openEnv() {
        let cfg = config
        if let f = cfg.envFile { NSWorkspace.shared.open(f); return }
        // No .env yet: create one next to the project (or in Application Support) from the example.
        let target = projectRoot.map { URL(fileURLWithPath: $0).appendingPathComponent(".env") }
            ?? AppPaths.supportDir.appendingPathComponent(".env")
        let example = projectRoot.map { URL(fileURLWithPath: $0).appendingPathComponent(".env.example") }
        let text = example.flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? "LLM_PROVIDER=lmstudio\nLMSTUDIO_BASE_URL=http://localhost:1234/v1\n"
        try? text.write(to: target, atomically: true, encoding: .utf8)
        NSWorkspace.shared.open(target)
    }

    enum ZoomDir: String { case `in`, out, reset }
    func zoom(_ dir: ZoomDir) {
        let z = web.webView.pageZoom
        switch dir {
        case .in: web.webView.pageZoom = min(3, z + 0.1)
        case .out: web.webView.pageZoom = max(0.5, z - 0.1)
        case .reset: web.webView.pageZoom = 1
        }
        web.command("zoomChanged")
    }

    /// Ask the page to write every board it holds before we quit.
    func flushBeforeQuit() async {
        await web.callAndWait("await EE.native.flush()")
    }

    // MARK: bridge

    func handle(_ cmd: String, _ body: [String: Any]) async throws -> Any? {
        let str = { (k: String) in body[k] as? String ?? "" }
        switch cmd {
        case "ready":
            var reply: [String: Any] = ["native": true]
            if selfTest == nil, let last = UserDefaults.standard.string(forKey: "lastBoardId"),
               let data = try? store.load(last) {
                reply["board"] = String(decoding: data, as: UTF8.self)
            }
            if let st = selfTest {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                    self?.web.call("EE.selfTest", st.prompt.map { ["prompt": $0] } ?? [:])
                }
            }
            return reply

        case "config":
            let cfg = config
            var problems = cfg.problems
            var model = cfg.llm.model ?? "auto"
            if cfg.llm.provider != .openrouter || cfg.llm.apiKey != nil {
                do { model = try await LLMClient(settings: cfg.llm).resolveModel() } catch { problems.append(error.localizedDescription) }
            }
            let python = cfg.python.interpreter ?? runner.supportDir.appendingPathComponent("pyenv/bin/python").path
            let levelSet: [String: Any] = ["provider": cfg.levelSet.displayName, "model": cfg.levelSet.model ?? "auto",
                                           "problems": cfg.levelSetProblems]
            return ["provider": cfg.llm.displayName, "model": model, "baseURL": cfg.llm.baseURL.absoluteString,
                    "envFile": cfg.envFile?.path ?? "", "problems": problems, "python": python,
                    "packages": cfg.python.packages.joined(separator: " "), "levelset": levelSet]

        case "chat":
            let id = str("id")
            let raw = body["messages"] as? [[String: Any]] ?? []
            let messages = raw.map { ["role": $0["role"] as? String ?? "user", "content": $0["content"] as? String ?? ""] }
            startChat(id: id, messages: messages, purpose: str("purpose"))
            return ["ok": true]

        case "allBoards":
            return ["boards": store.allJSON()]

        case "loadProfile":
            return ["json": (try? String(contentsOf: store.profileURL, encoding: .utf8)) ?? ""]

        case "saveProfile":
            try BoardStore.writePrivate(Data(str("json").utf8), to: store.profileURL)
            return ["ok": true]

        case "loadNotes":
            return ["json": (try? String(contentsOf: store.notesURL, encoding: .utf8)) ?? ""]

        case "saveNotes":
            try BoardStore.writePrivate(Data(str("json").utf8), to: store.notesURL)
            return ["ok": true]

        case "cancel":
            let id = str("id")
            chats.removeValue(forKey: id)?.cancel()
            await runner.cancel(id: id)
            return ["ok": true]

        case "python":
            let settings = config.python
            let web = self.web
            let result = try await runner.run(id: str("id"), code: str("code"), settings: settings) { text in
                Task { @MainActor in web.call("EE.native.pyStatus", ["text": text]) }
            }
            return result.dictionary

        case "saveBoard":
            let id = str("id")
            guard !deleted.contains(id) else { return ["ok": false, "skipped": "deleted"] }
            if let summary = try store.save(id, data: Data(str("json").utf8)) { upsert(summary) }
            return ["ok": true]

        case "current":
            let id = str("id"), title = str("title")
            currentId = id
            currentTitle = title.isEmpty ? "New board" : title
            if let i = boards.firstIndex(where: { $0.id == id }), !title.isEmpty { boards[i].title = title }
            selection = boards.contains(where: { $0.id == id }) ? id : nil
            if selfTest == nil { UserDefaults.standard.set(id, forKey: "lastBoardId") }
            return ["ok": true]

        case "zoom":
            zoom(ZoomDir(rawValue: str("dir")) ?? .reset)
            return ["zoom": web.webView.pageZoom]

        case "copy":
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(str("text"), forType: .string)
            return ["ok": true]

        case "openEnv":
            openEnv()
            return ["ok": true]

        case "log":
            NSLog("[board] %@", str("message"))
            return ["ok": true]

        case "selftest":
            return try await handleSelfTest(body)

        default:
            throw NSError(domain: "EE", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unknown command \(cmd)"])
        }
    }

    private func upsert(_ s: BoardSummary) {
        if let i = boards.firstIndex(where: { $0.id == s.id }) { boards[i] = s } else { boards.append(s) }
        boards.sort { $0.updatedAt > $1.updatedAt }
        if s.id == currentId {
            currentTitle = s.title
            if selection != s.id { selection = s.id }
        }
    }

    private func startChat(id: String, messages: [[String: String]], purpose: String) {
        let cfg = config
        let isLevelSet = purpose == "levelset"
        let settings = isLevelSet ? cfg.levelSet : cfg.llm
        if isLevelSet, let problem = cfg.levelSetProblems.first {
            web.failChat(id: id, message: problem)
            return
        }
        if !isLevelSet && cfg.llm.provider == .openrouter && cfg.llm.apiKey == nil {
            web.failChat(id: id, message: "OPENROUTER_API_KEY is missing. Add it to \(cfg.envFile?.path ?? ".env") or set LLM_PROVIDER=lmstudio.")
            return
        }
        let client = LLMClient(settings: settings)
        let web = self.web
        chats[id] = Task { [weak self] in
            var model: String?
            var finish: String?
            do {
                for try await d in client.stream(messages: messages) {
                    if Task.isCancelled { break }
                    if let m = d.model { model = m }
                    if let f = d.finishReason { finish = f }
                    if !d.content.isEmpty || !d.reasoning.isEmpty {
                        web.enqueueChunk(id: id, content: d.content, reasoning: d.reasoning)
                    }
                }
                if !Task.isCancelled { web.finishChat(id: id, model: model, finish: finish) }
            } catch {
                if !Task.isCancelled { web.failChat(id: id, message: Self.describe(error, settings)) }
            }
            self?.chats[id] = nil
        }
    }

    private static func describe(_ error: Error, _ settings: LLMSettings) -> String {
        if let u = error as? URLError, [.cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .timedOut].contains(u.code) {
            let hint = settings.provider == .lmstudio ? " Is LM Studio running with its server started?" : ""
            return "Could not reach \(settings.baseURL.absoluteString).\(hint) (\(u.localizedDescription))"
        }
        return error.localizedDescription
    }

    // MARK: self test

    private func handleSelfTest(_ body: [String: Any]) async throws -> Any? {
        let event = body["event"] as? String ?? ""
        let dir = selfTest?.outDir ?? FileManager.default.temporaryDirectory.appendingPathComponent("ee-selftest")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        switch event {
        case "log":
            let line = "\(ISO8601DateFormatter().string(from: Date())) \(body["message"] as? String ?? "")\n"
            let log = dir.appendingPathComponent("log.txt")
            if let h = try? FileHandle(forWritingTo: log) {
                h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close()
            } else {
                try? line.write(to: log, atomically: true, encoding: .utf8)
            }
            FileHandle.standardError.write(Data(("[selftest] " + line).utf8))
            return ["ok": true]
        case "snapshot":
            let name = (body["name"] as? String ?? "snap").filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
            try await Task.sleep(nanoseconds: 250_000_000)
            let png = try await web.snapshotPNG()
            try png.write(to: dir.appendingPathComponent("\(name).png"))
            return ["ok": true]
        case "reload":
            let data = try store.load(body["id"] as? String ?? "")
            return ["board": String(decoding: data, as: UTF8.self)]
        case "finish":
            try (body["report"] as? String ?? "{}").write(to: dir.appendingPathComponent("report.json"), atomically: true, encoding: .utf8)
            if selfTest?.keepOpen == false {
                NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 1)
            }
            return ["ok": true]
        default:
            return ["ok": true]
        }
    }
}
