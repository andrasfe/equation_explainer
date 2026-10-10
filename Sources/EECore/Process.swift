import Foundation

public struct ProcessOutput: Sendable {
    public var stdout: Data
    public var stderr: Data
    public var status: Int32
    public var timedOut: Bool
    public var cancelled: Bool
}

/// Thread-safe byte accumulator with a cap (runaway prints shouldn't eat memory).
final class Collector: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    private let cap: Int
    private(set) var truncated = false
    init(cap: Int) { self.cap = cap }
    func append(_ d: Data) {
        lock.lock(); defer { lock.unlock() }
        if data.count >= cap { truncated = true; return }
        data.append(d.prefix(cap - data.count))
        if data.count >= cap { truncated = true }
    }
    func value() -> Data { lock.lock(); defer { lock.unlock() }; return data }
}

final class Flags: @unchecked Sendable {
    private let lock = NSLock()
    private var _timedOut = false, _cancelled = false
    var timedOut: Bool { get { lock.lock(); defer { lock.unlock() }; return _timedOut } set { lock.lock(); _timedOut = newValue; lock.unlock() } }
    var cancelled: Bool { get { lock.lock(); defer { lock.unlock() }; return _cancelled } set { lock.lock(); _cancelled = newValue; lock.unlock() } }
}

/// A launched child process that can be cancelled from another task.
public final class ProcessHandle: @unchecked Sendable {
    public init() {}
    let process = Process()
    let flags = Flags()
    public func cancel() {
        flags.cancelled = true
        if process.isRunning { process.terminate() }
        let pid = process.processIdentifier
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [process] in
            if process.isRunning { kill(pid, SIGKILL) }
        }
    }
}

public enum Subprocess {
    /// Run a process to completion off the main thread, capturing output.
    public static func run(_ exe: URL, _ args: [String], env: [String: String]? = nil, cwd: URL? = nil,
                           timeout: TimeInterval, outputCap: Int = 2_000_000,
                           handle: ProcessHandle = ProcessHandle()) async throws -> ProcessOutput {
        let p = handle.process
        p.executableURL = exe
        p.arguments = args
        if let env { p.environment = env }
        if let cwd { p.currentDirectoryURL = cwd }
        let outPipe = Pipe(), errPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = errPipe
        p.standardInput = FileHandle.nullDevice
        let out = Collector(cap: outputCap), err = Collector(cap: outputCap)
        outPipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if !d.isEmpty { out.append(d) }
        }
        errPipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if !d.isEmpty { err.append(d) }
        }
        return try await withCheckedThrowingContinuation { cont in
            p.terminationHandler = { proc in
                outPipe.fileHandleForReading.readabilityHandler = nil
                errPipe.fileHandleForReading.readabilityHandler = nil
                out.append(outPipe.fileHandleForReading.readDataToEndOfFile())
                err.append(errPipe.fileHandleForReading.readDataToEndOfFile())
                var stdout = out.value()
                if out.truncated { stdout.append(Data("\n[output truncated]\n".utf8)) }
                cont.resume(returning: ProcessOutput(stdout: stdout, stderr: err.value(), status: proc.terminationStatus,
                                                     timedOut: handle.flags.timedOut, cancelled: handle.flags.cancelled))
            }
            do {
                try p.run()
            } catch {
                outPipe.fileHandleForReading.readabilityHandler = nil
                errPipe.fileHandleForReading.readabilityHandler = nil
                cont.resume(throwing: error)
                return
            }
            if timeout > 0 {
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                    if p.isRunning {
                        handle.flags.timedOut = true
                        p.terminate()
                        let pid = p.processIdentifier
                        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { if p.isRunning { kill(pid, SIGKILL) } }
                    }
                }
            }
        }
    }
}
