import Foundation

/// Minimal .env parser: KEY=VALUE lines, `export` prefix, quotes, inline ` #` comments.
public enum DotEnv {
    public static func parse(_ text: String) -> [String: String] {
        var out: [String: String] = [:]
        for raw in text.components(separatedBy: .newlines) {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            if line.hasPrefix("export ") { line = String(line.dropFirst(7)).trimmingCharacters(in: .whitespaces) }
            guard let eq = line.firstIndex(of: "=") else { continue }
            let key = line[..<eq].trimmingCharacters(in: .whitespaces)
            var value = line[line.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            if let q = value.first, q == "\"" || q == "'",
               let close = value.dropFirst().firstIndex(of: q) {
                value = String(value[value.index(after: value.startIndex)..<close])
                if q == "\"" { value = value.replacingOccurrences(of: "\\n", with: "\n") }
            } else if let hash = value.range(of: " #") {
                value = value[..<hash.lowerBound].trimmingCharacters(in: .whitespaces)
            }
            if !key.isEmpty { out[key] = value }
        }
        return out
    }
}

public struct LLMSettings: Sendable, Equatable {
    public enum Provider: String, Sendable { case openrouter, lmstudio, custom }
    public var provider: Provider
    public var baseURL: URL
    public var apiKey: String?
    /// nil = ask the server (LM Studio: the loaded model)
    public var model: String?
    public var temperature: Double?
    public var maxTokens: Int?
    /// extra JSON merged into the request body (LLM_EXTRA_BODY)
    public var extraBodyJSON: String?

    public var displayName: String {
        switch provider {
        case .openrouter: return "OpenRouter"
        case .lmstudio: return "LM Studio"
        case .custom: return "Custom"
        }
    }
}

public struct PythonSettings: Sendable, Equatable {
    /// explicit interpreter (PYTHON_PATH); nil = managed venv
    public var interpreter: String?
    public var packages: [String]
    public var timeout: TimeInterval
}

public struct AppConfig: Sendable {
    public var llm: LLMSettings
    public var python: PythonSettings
    public var envFile: URL?
    public var problems: [String]

    public static let defaultOpenRouterModel = "anthropic/claude-fable-5.1"

    /// Where we look for .env, in order.
    public static func candidateEnvFiles(projectRoot: String?, environment: [String: String]) -> [URL] {
        var out: [URL] = []
        if let p = environment["EE_ENV_FILE"], !p.isEmpty { out.append(URL(fileURLWithPath: (p as NSString).expandingTildeInPath)) }
        if let root = projectRoot, !root.isEmpty { out.append(URL(fileURLWithPath: root).appendingPathComponent(".env")) }
        out.append(AppPaths.supportDir.appendingPathComponent(".env"))
        out.append(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".equation_explainer.env"))
        out.append(URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(".env"))
        return out
    }

    public static func load(projectRoot: String?, environment: [String: String] = ProcessInfo.processInfo.environment) -> AppConfig {
        var values = environment
        var used: URL?
        for url in candidateEnvFiles(projectRoot: projectRoot, environment: environment) {
            if let text = try? String(contentsOf: url, encoding: .utf8) {
                values.merge(DotEnv.parse(text)) { _, new in new }
                used = url
                break
            }
        }
        return resolve(values: values, envFile: used)
    }

    public static func resolve(values: [String: String], envFile: URL?) -> AppConfig {
        var problems: [String] = []
        func get(_ k: String) -> String? {
            guard let v = values[k]?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty else { return nil }
            return v
        }
        var provider: LLMSettings.Provider
        if let p = get("LLM_PROVIDER")?.lowercased() {
            switch p {
            case "openrouter": provider = .openrouter
            case "lmstudio", "lm_studio", "lm-studio", "local": provider = .lmstudio
            case "custom", "openai": provider = .custom
            default:
                problems.append("Unknown LLM_PROVIDER '\(p)', falling back to lmstudio")
                provider = .lmstudio
            }
        } else {
            provider = get("OPENROUTER_API_KEY") != nil ? .openrouter : .lmstudio
        }

        var base: String
        var key: String?
        var model: String?
        switch provider {
        case .openrouter:
            base = get("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1"
            key = get("OPENROUTER_API_KEY")
            model = get("OPENROUTER_MODEL") ?? defaultOpenRouterModel
            if key == nil { problems.append("OPENROUTER_API_KEY is not set in .env") }
        case .lmstudio:
            base = get("LMSTUDIO_BASE_URL") ?? "http://localhost:1234/v1"
            key = get("LMSTUDIO_API_KEY")
            model = get("LMSTUDIO_MODEL")
        case .custom:
            base = get("LLM_BASE_URL") ?? "http://localhost:8080/v1"
            key = get("LLM_API_KEY")
            model = get("LLM_MODEL")
            if get("LLM_BASE_URL") == nil { problems.append("LLM_BASE_URL is not set for the custom provider") }
        }
        while base.hasSuffix("/") { base.removeLast() }
        let url = URL(string: base) ?? URL(string: "http://localhost:1234/v1")!
        if URL(string: base) == nil { problems.append("Invalid base URL '\(base)'") }

        let temperature = get("LLM_TEMPERATURE").flatMap(Double.init) ?? 0.3
        let maxTokens = get("LLM_MAX_TOKENS").flatMap(Int.init) ?? 8192
        var extra = get("LLM_EXTRA_BODY")
        if let e = extra, (try? JSONSerialization.jsonObject(with: Data(e.utf8))) as? [String: Any] == nil {
            problems.append("LLM_EXTRA_BODY is not a JSON object; ignored")
            extra = nil
        }

        let packages = (get("PYTHON_PACKAGES") ?? "numpy sympy scipy matplotlib")
            .split(whereSeparator: { $0 == " " || $0 == "," }).map(String.init).filter { !$0.isEmpty }
        let python = PythonSettings(
            interpreter: get("PYTHON_PATH").map { ($0 as NSString).expandingTildeInPath },
            packages: packages,
            timeout: get("PYTHON_TIMEOUT").flatMap(Double.init) ?? 120)

        return AppConfig(
            llm: LLMSettings(provider: provider, baseURL: url, apiKey: key, model: model,
                             temperature: temperature, maxTokens: maxTokens, extraBodyJSON: extra),
            python: python, envFile: envFile, problems: problems)
    }
}

public enum AppPaths {
    /// ~/Library/Application Support/EquationExplainer (override with EE_DATA_DIR)
    public static var supportDir: URL {
        if let o = ProcessInfo.processInfo.environment["EE_DATA_DIR"], !o.isEmpty {
            return URL(fileURLWithPath: (o as NSString).expandingTildeInPath, isDirectory: true)
        }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("EquationExplainer", isDirectory: true)
    }
}
