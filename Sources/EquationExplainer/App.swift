import AppKit
import EECore
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    var model: AppModel?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model else { return .terminateNow }
        // Give the page a moment to write half-streamed answers, but never hang the quit:
        // the timer lives on the run loop (not the main queue), so it fires even if
        // terminate: was called from inside a main-queue block.
        var replied = false
        let finish = {
            guard !replied else { return }
            replied = true
            sender.reply(toApplicationShouldTerminate: true)
        }
        let timer = Timer(timeInterval: 1.5, repeats: false) { _ in finish() }
        RunLoop.main.add(timer, forMode: .common)
        RunLoop.main.add(timer, forMode: .modalPanel)
        Task { @MainActor in
            await model.flushBeforeQuit()
            timer.invalidate()
            finish()
        }
        return .terminateLater
    }
}

@main
struct EquationExplainerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        Window("Equation Explainer", id: "main") {
            ContentView()
                .environmentObject(model)
                .frame(minWidth: 960, minHeight: 620)
                .preferredColorScheme(.dark)
                .onAppear { delegate.model = model }
        }
        .defaultSize(width: 1480, height: 940)
        .commands { BoardCommands(model: model) }
    }
}

struct BoardCommands: Commands {
    let model: AppModel

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Board") { model.newBoard() }.keyboardShortcut("n")
        }
        CommandMenu("Board") {
            Button("Close Side Question") { model.web.command("closeLast") }
                .keyboardShortcut("[", modifiers: .command)
            Button("Back to the Original") { model.web.command("closeAll") }
                .keyboardShortcut(.delete, modifiers: [.command, .shift])
            Button("Board Map") { model.web.command("toggleMap") }
                .keyboardShortcut("m", modifiers: [.command, .shift])
            Divider()
            Button("Insert Matrix…") { model.web.command("insertMatrix") }
                .keyboardShortcut("m", modifiers: [.command, .option])
            Button("Write on the Board") { model.web.command("focus") }
                .keyboardShortcut("l", modifiers: .command)
            Divider()
            Button("Level-Set Now") { model.web.command("levelset") }
                .keyboardShortcut("l", modifiers: [.command, .shift])
            Button("Where I Stand…") { model.web.command("profile") }
            Divider()
            Button("Model & Runtime…") { model.web.command("config") }
            Button("Open .env") { model.openEnv() }
            Button("Reveal Boards Folder") { model.revealBoardsFolder() }
        }
        CommandGroup(after: .toolbar) {
            Button("Zoom In") { model.zoom(.in) }.keyboardShortcut("=", modifiers: .command)
            Button("Zoom Out") { model.zoom(.out) }.keyboardShortcut("-", modifiers: .command)
            Button("Actual Size") { model.zoom(.reset) }.keyboardShortcut("0", modifiers: .command)
            Divider()
        }
    }
}
