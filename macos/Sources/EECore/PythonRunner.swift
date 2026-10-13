import Foundation

public struct PythonRunResult: Sendable {
    public var stdout: String
    public var stderr: String
    public var exitCode: Int32
    public var ms: Int
    public var timedOut: Bool
    public var cancelled: Bool
    public var images: [String]   // data: URIs
    public var interpreter: String

    public var dictionary: [String: Any] {
        ["stdout": stdout, "stderr": stderr, "exitCode": Int(exitCode), "ms": ms, "timedOut": timedOut,
         "cancelled": cancelled, "images": images, "interpreter": interpreter]
    }
}

public enum PythonError: LocalizedError {
    case noBasePython
    case setupFailed(String)
    public var errorDescription: String? {
        switch self {
        case .noBasePython: return "No python3 found. Install Python (e.g. `brew install python`) or set PYTHON_PATH in .env."
        case .setupFailed(let m): return "Setting up the Python environment failed:\n\(m)"
        }
    }
}

/// Runs board cells in fresh Python processes, inside a managed virtualenv.
public actor PythonRunner {
    public nonisolated let supportDir: URL
    /// folder with runner.py, boardkit.py, matplotlibrc
    public nonisolated let kitDir: URL
    private var handles: [String: ProcessHandle] = [:]
    private var setupTask: Task<URL, Error>?
    private var setupKey: String?

    public init(supportDir: URL, kitDir: URL) {
        self.supportDir = supportDir
        self.kitDir = kitDir
    }

    var venvDir: URL { supportDir.appendingPathComponent("pyenv", isDirectory: true) }
    var venvPython: URL { venvDir.appendingPathComponent("bin/python") }
    var marker: URL { venvDir.appendingPathComponent(".ee-packages") }

    static func basePython() -> URL? {
        let candidates = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3",
                          "/Library/Frameworks/Python.framework/Versions/Current/bin/python3", "/usr/bin/python3"]
        return candidates.map(URL.init(fileURLWithPath:)).first { FileManager.default.isExecutableFile(atPath: $0.path) }
    }

    /// The interpreter to use, creating/updating the managed venv when needed.
    public func interpreter(_ settings: PythonSettings, progress: @escaping @Sendable (String) -> Void) async throws -> URL {
        if let p = settings.interpreter { return URL(fileURLWithPath: p) }
        let want = settings.packages.sorted().joined(separator: " ")
        let fm = FileManager.default
        if fm.isExecutableFile(atPath: venvPython.path),
           let have = try? String(contentsOf: marker, encoding: .utf8), have == want {
            return venvPython
        }
        if let t = setupTask, setupKey == want { return try await t.value }
        let venvDir = self.venvDir, venvPython = self.venvPython, marker = self.marker, packages = settings.packages
        let task = Task<URL, Error> {
            try fm.createDirectory(at: venvDir.deletingLastPathComponent(), withIntermediateDirectories: true)
            if !fm.isExecutableFile(atPath: venvPython.path) {
                guard let base = Self.basePython() else { throw PythonError.noBasePython }
                progress("Creating a Python environment for the board (one time)…")
                let r = try await Subprocess.run(base, ["-m", "venv", venvDir.path], timeout: 300)
                if r.status != 0 { throw PythonError.setupFailed(String(decoding: r.stderr, as: UTF8.self)) }
            }
            if !packages.isEmpty {
                progress("Installing \(packages.joined(separator: ", ")) (one time, about a minute)…")
                let r = try await Subprocess.run(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "-q"] + packages,
                                                 timeout: 1200)
                if r.status != 0 { throw PythonError.setupFailed(String(decoding: r.stderr, as: UTF8.self)) }
            }
            try want.write(to: marker, atomically: true, encoding: .utf8)
            progress("Python environment ready.")
            return venvPython
        }
        setupTask = task
        setupKey = want
        do {
            let url = try await task.value
            setupTask = nil
            return url
        } catch {
            setupTask = nil
            throw error
        }
    }

    public func run(id: String, code: String, settings: PythonSettings,
                    progress: @escaping @Sendable (String) -> Void) async throws -> PythonRunResult {
        let python = try await interpreter(settings, progress: progress)
        let fm = FileManager.default
        let runDir = supportDir.appendingPathComponent("runs/\(UUID().uuidString)", isDirectory: true)
        let outDir = runDir.appendingPathComponent("out", isDirectory: true)
        try fm.createDirectory(at: outDir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: runDir) }
        let cell = runDir.appendingPathComponent("cell.py")
        try code.write(to: cell, atomically: true, encoding: .utf8)

        var env = ProcessInfo.processInfo.environment
        let existing = env["PYTHONPATH"].map { ":" + $0 } ?? ""
        env["PYTHONPATH"] = kitDir.path + existing
        env["MPLBACKEND"] = "Agg"
        env["MATPLOTLIBRC"] = kitDir.appendingPathComponent("matplotlibrc").path
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["MPLCONFIGDIR"] = supportDir.appendingPathComponent("mplconfig").path

        let handle = ProcessHandle()
        handles[id] = handle
        defer { handles[id] = nil }
        let started = Date()
        let r = try await Subprocess.run(python, ["-u", kitDir.appendingPathComponent("runner.py").path, cell.path, outDir.path],
                                         env: env, cwd: runDir, timeout: settings.timeout, handle: handle)
        var images: [String] = []
        let pngs = ((try? fm.contentsOfDirectory(atPath: outDir.path)) ?? []).filter { $0.hasSuffix(".png") }.sorted()
        for name in pngs.prefix(8) {
            if let d = try? Data(contentsOf: outDir.appendingPathComponent(name)), d.count < 6_000_000 {
                images.append("data:image/png;base64," + d.base64EncodedString())
            }
        }
        var stderr = String(decoding: r.stderr, as: UTF8.self)
        if r.timedOut { stderr += "\n[stopped: exceeded PYTHON_TIMEOUT of \(Int(settings.timeout)) s]" }
        return PythonRunResult(stdout: String(decoding: r.stdout, as: UTF8.self), stderr: stderr,
                               exitCode: r.status, ms: Int(Date().timeIntervalSince(started) * 1000),
                               timedOut: r.timedOut, cancelled: r.cancelled, images: images, interpreter: python.path)
    }

    public func cancel(id: String) {
        handles[id]?.cancel()
    }
}
