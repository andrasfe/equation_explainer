import EECore
import SwiftUI
import WebKit

struct BoardWebView: NSViewRepresentable {
    let controller: WebController
    func makeNSView(context: Context) -> WKWebView { controller.webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

private let slate = Color(red: 0.12, green: 0.15, blue: 0.13)
private let chalkYellow = Color(red: 0.96, green: 0.88, blue: 0.54)

struct ContentView: View {
    @EnvironmentObject var model: AppModel
    @State private var search = ""
    @State private var renaming: BoardSummary?
    @State private var renameText = ""
    @State private var deleting: BoardSummary?

    private var filtered: [BoardSummary] {
        let q = search.trimmingCharacters(in: .whitespaces)
        return q.isEmpty ? model.boards : model.boards.filter { $0.title.localizedCaseInsensitiveContains(q) }
    }

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 200, ideal: 250, max: 380)
        } detail: {
            BoardWebView(controller: model.web)
                .ignoresSafeArea(.container, edges: .bottom)
                .navigationTitle(model.currentTitle)
        }
        .onChange(of: model.selection) { _, new in
            if let new { model.open(new) }
        }
    }

    private var sidebar: some View {
        List(selection: $model.selection) {
            Section("Boards") {
                if filtered.isEmpty {
                    Text(search.isEmpty ? "Nothing written yet." : "No board matches.")
                        .font(.custom("Chalkboard SE", size: 13))
                        .foregroundStyle(.secondary)
                }
                ForEach(filtered) { board in
                    BoardRow(board: board)
                        .tag(board.id)
                        .contextMenu {
                            Button("Rename…") { renameText = board.title; renaming = board }
                            Button("Show in Finder") { model.reveal(board.id) }
                            Divider()
                            Button("Move to Trash…", role: .destructive) { deleting = board }
                        }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(slate)
        .searchable(text: $search, placement: .sidebar, prompt: "Search boards")
        .toolbar {
            ToolbarItem {
                Button { model.newBoard() } label: { Label("New Board", systemImage: "square.and.pencil") }
                    .help("New board (⌘N)")
            }
        }
        .alert("Rename board", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Title", text: $renameText)
            Button("Rename") { if let b = renaming { model.rename(b.id, to: renameText) } }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Move “\(deleting?.title ?? "")” to the Trash?",
                            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("Move to Trash", role: .destructive) { if let b = deleting { model.delete(b.id) } }
        } message: {
            Text("The board and all of its side questions go to the Trash. You can restore the file from there.")
        }
    }
}

struct BoardRow: View {
    let board: BoardSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(board.title)
                .font(.custom("Chalkboard SE", size: 14))
                .lineLimit(2)
            HStack(spacing: 4) {
                Text(board.updatedAt, style: .relative) + Text(" ago")
                if board.branchCount > 0 {
                    Text("·")
                    Text("\(board.branchCount) side question\(board.branchCount == 1 ? "" : "s")")
                        .foregroundStyle(chalkYellow.opacity(0.8))
                }
            }
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 3)
    }
}
