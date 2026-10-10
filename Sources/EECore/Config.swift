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
    /// The model that builds the learner profile ("level-set"); OpenRouter by default.
    public var levelSet: LLMSettings
    public var python: PythonSettings
    public var envFile: URL?
    public var problems: [String]
    public var levelSetProblems: [String]

    public static let defaultOpenRouterModel = "anthropic/claude-fable-5.1"
    public static let defaultLevelSetModel = "openai/gpt-5.6-sol-pro"

    static func parseProvider(_ raw: String) -> LLMSettings.Provider? {
        switch raw.lowercased() {
        case "openrouter": return .openrouter
        case "lmstudio", "lm_studio", "lm-studio", "local": return .lmstudio
        case "custom", "openai": return .custom
        default: return nil
        }
    }

    /// Base URL, key and default model for a provider, from the .env values.
    static func endpoint(_ provider: LLMSettings.Provider, _ get: (String) -> String?) -> (base: String, key: String?, model: String?) {
        switch provider {
        case .openrouter:
            return (get("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1", get("OPENROUTER_API_KEY"),
                    get("OPENROUTER_MODEL") ?? defaultOpenRouterModel)
        case .lmstudio:
            return (get("LMSTUDIO_BASE_URL") ?? "http://localhost:1234/v1", get("LMSTUDIO_API_KEY"), get("LMSTUDIO_MODEL"))
        case .custom:
            return (get("LLM_BASE_URL") ?? "http://localhost:8080/v1", get("LLM_API_KEY"), get("LLM_MODEL"))
        }
    }

    static func url(_ raw: String, problems: inout [String]) -> URL {
        var base = raw
        while base.hasSuffix("/") { base.removeLast() }
        if let u = URL(string: base), u.scheme != nil { return u }
        problems.append("Invalid base URL '\(raw)'")
        return URL(string: "http://localhost:1234/v1")!
    }

    static func jsonObject(_ raw: String?, key: String, problems: inout [String]) -> String? {
        guard let raw else { return nil }
        if (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] == nil {
            problems.append("\(key) is not a JSON object; ignored")
            return nil
        }
        return raw
    }

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
        if let p = get("LLM_PROVIDER") {
            if let parsed = parseProvider(p) { provider = parsed } else {
                problems.append("Unknown LLM_PROVIDER '\(p)', falling back to lmstudio")
                provider = .lmstudio
            }
        } else {
            provider = get("OPENROUTER_API_KEY") != nil ? .openrouter : .lmstudio
        }
        let ep = endpoint(provider, get)
        if provider == .openrouter && ep.key == nil { problems.append("OPENROUTER_API_KEY is not set in .env") }
        if provider == .custom && get("LLM_BASE_URL") == nil { problems.append("LLM_BASE_URL is not set for the custom provider") }
        let llm = LLMSettings(provider: provider, baseURL: url(ep.base, problems: &problems), apiKey: ep.key, model: ep.model,
                              temperature: get("LLM_TEMPERATURE").flatMap(Double.init) ?? 0.3,
                              maxTokens: get("LLM_MAX_TOKENS").flatMap(Int.init) ?? 8192,
                              extraBodyJSON: jsonObject(get("LLM_EXTRA_BODY"), key: "LLM_EXTRA_BODY", problems: &problems))

        // Level-set (learner profile): OpenRouter + openai/gpt-5.6-sol-pro unless overridden.
        var lsProblems: [String] = []
        var lsProvider = LLMSettings.Provider.openrouter
        if let p = get("LEVELSET_PROVIDER") {
            if let parsed = parseProvider(p) { lsProvider = parsed } else { lsProblems.append("Unknown LEVELSET_PROVIDER '\(p)', using openrouter") }
        }
        let lsEp = endpoint(lsProvider, get)
        let lsModel = get("LEVELSET_MODEL") ?? (lsProvider == .openrouter ? defaultLevelSetModel : lsEp.model)
        if lsProvider == .openrouter && lsEp.key == nil {
            lsProblems.append("OPENROUTER_API_KEY is not set in .env. The level-set runs on OpenRouter (\(lsModel)).")
        }
        let levelSet = LLMSettings(provider: lsProvider, baseURL: url(lsEp.base, problems: &lsProblems), apiKey: lsEp.key, model: lsModel,
                                   temperature: get("LEVELSET_TEMPERATURE").flatMap(Double.init),
                                   maxTokens: get("LEVELSET_MAX_TOKENS").flatMap(Int.init) ?? 32000,
                                   extraBodyJSON: jsonObject(get("LEVELSET_EXTRA_BODY"), key: "LEVELSET_EXTRA_BODY", problems: &lsProblems)
                                       ?? (lsProvider == .openrouter ? #"{"response_format":{"type":"json_object"}}"# : nil))

        let packages = (get("PYTHON_PACKAGES") ?? "numpy sympy scipy matplotlib")
            .split(whereSeparator: { $0 == " " || $0 == "," }).map(String.init).filter { !$0.isEmpty }
        let python = PythonSettings(
            interpreter: get("PYTHON_PATH").map { ($0 as NSString).expandingTildeInPath },
            packages: packages,
            timeout: get("PYTHON_TIMEOUT").flatMap(Double.init) ?? 120)

        return AppConfig(llm: llm, levelSet: levelSet, python: python, envFile: envFile,
                         problems: problems, levelSetProblems: lsProblems)
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
