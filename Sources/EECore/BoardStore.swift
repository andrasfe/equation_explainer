import Foundation

public struct BoardSummary: Identifiable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var createdAt: Date
    public var updatedAt: Date
    public var branchCount: Int
}

public enum BoardStoreError: LocalizedError {
    case badId(String)
    case notFound(String)
    public var errorDescription: String? {
        switch self {
        case .badId(let id): return "Invalid board id '\(id)'"
        case .notFound(let id): return "Board '\(id)' not found"
        }
    }
}

/// One JSON file per board in Application Support/EquationExplainer/Boards.
public final class BoardStore: @unchecked Sendable {
    public let dir: URL
    private let lock = NSLock()

    public init(dir: URL) {
        self.dir = dir
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    static func valid(_ id: String) -> Bool {
        !id.isEmpty && id.count < 100 && id.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    }

    func url(_ id: String) throws -> URL {
        guard Self.valid(id) else { throw BoardStoreError.badId(id) }
        return dir.appendingPathComponent("\(id).json")
    }

    public static func summary(from data: Data) -> BoardSummary? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = obj["id"] as? String else { return nil }
        let ms = { (k: String) -> Date in Date(timeIntervalSince1970: ((obj[k] as? Double) ?? 0) / 1000) }
        let threads = (obj["threads"] as? [String: Any])?.count ?? 1
        let title = (obj["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled board"
        return BoardSummary(id: id, title: title, createdAt: ms("createdAt"), updatedAt: ms("updatedAt"),
                            branchCount: max(0, threads - 1))
    }

    public func list() -> [BoardSummary] {
        lock.lock(); defer { lock.unlock() }
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }
            .compactMap { (try? Data(contentsOf: $0)).flatMap(Self.summary(from:)) }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Every board's raw JSON (for the learner model, which looks across all boards).
    public func allJSON() -> [String] {
        lock.lock(); defer { lock.unlock() }
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }.compactMap { try? String(contentsOf: $0, encoding: .utf8) }
    }

    /// The learner profile lives next to the Boards folder.
    public var profileURL: URL { dir.deletingLastPathComponent().appendingPathComponent("learner.json") }

    public func load(_ id: String) throws -> Data {
        lock.lock(); defer { lock.unlock() }
        let u = try url(id)
        guard FileManager.default.fileExists(atPath: u.path) else { throw BoardStoreError.notFound(id) }
        return try Data(contentsOf: u)
    }

    @discardableResult
    public func save(_ id: String, data: Data) throws -> BoardSummary? {
        lock.lock(); defer { lock.unlock() }
        try data.write(to: try url(id), options: .atomic)
        return Self.summary(from: data)
    }

    /// Moves the board file to the Trash (recoverable).
    public func delete(_ id: String) throws {
        lock.lock(); defer { lock.unlock() }
        let u = try url(id)
        guard FileManager.default.fileExists(atPath: u.path) else { return }
        try FileManager.default.trashItem(at: u, resultingItemURL: nil)
    }

    /// Rewrites the title inside the JSON and returns the updated document.
    public func rename(_ id: String, title: String) throws -> Data {
        let data = try load(id)
        guard var obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw BoardStoreError.notFound(id) }
        obj["title"] = title
        obj["updatedAt"] = Date().timeIntervalSince1970 * 1000
        let out = try JSONSerialization.data(withJSONObject: obj)
        try save(id, data: out)
        return out
    }
}
