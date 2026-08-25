import SwiftUI

struct ReaderHomeView: View {
    @EnvironmentObject private var store: ReaderStore
    @State private var isImporterPresented = false
    @State private var isOutlinePresented = false

    var body: some View {
        NavigationStack {
            Group {
                if let document = store.document {
                    reader(document)
                } else {
                    library
                }
            }
            .fileImporter(
                isPresented: $isImporterPresented,
                allowedContentTypes: ReaderDocumentType.importableTypes,
                allowsMultipleSelection: false
            ) { result in
                switch result {
                case .success(let urls):
                    if let url = urls.first {
                        store.importDocument(from: url)
                    }
                case .failure(let error):
                    store.errorMessage = error.localizedDescription
                }
            }
            .alert("无法打开文档", isPresented: Binding(
                get: { store.errorMessage != nil },
                set: { if !$0 { store.errorMessage = nil } }
            )) {
                Button("好", role: .cancel) {}
            } message: {
                Text(store.errorMessage ?? "")
            }
        }
    }

    private var library: some View {
        List {
            Section {
                Button {
                    isImporterPresented = true
                } label: {
                    Label("打开 Markdown 文件", systemImage: "doc.badge.plus")
                }
            }

            if !store.recents.isEmpty {
                Section("最近阅读") {
                    ForEach(store.recents) { recent in
                        Button {
                            store.reopen(recent)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(recent.fileName)
                                    .lineLimit(1)
                                Text(recent.openedAt, style: .relative)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions {
                            Button(role: .destructive) {
                                store.remove(recent)
                            } label: {
                                Label("移除", systemImage: "trash")
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("ColaMD Reader")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func reader(_ document: ReaderDocument) -> some View {
        WebReaderView(document: document, theme: store.theme, fontSize: store.fontSize)
            .navigationTitle(document.fileName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        store.closeDocument()
                    } label: {
                        Image(systemName: "chevron.left")
                    }
                    .accessibilityLabel("返回文档库")
                }

                ToolbarItemGroup(placement: .topBarTrailing) {
                    if !document.outline.isEmpty {
                        Button {
                            isOutlinePresented = true
                        } label: {
                            Image(systemName: "list.bullet")
                        }
                        .accessibilityLabel("文档目录")
                    }

                    Menu {
                        Picker("主题", selection: $store.theme) {
                            ForEach(ReaderTheme.allCases) { theme in
                                Text(theme.label).tag(theme)
                            }
                        }

                        Picker("字号", selection: $store.fontSize) {
                            ForEach(ReaderFontSize.allCases) { size in
                                Text(size.label).tag(size)
                            }
                        }
                    } label: {
                        Image(systemName: "textformat.size")
                    }
                    .accessibilityLabel("阅读设置")
                }
            }
            .sheet(isPresented: $isOutlinePresented) {
                OutlineSheet(headings: document.outline)
            }
    }
}

private struct OutlineSheet: View {
    @Environment(\.dismiss) private var dismiss
    let headings: [DocumentHeading]

    var body: some View {
        NavigationStack {
            List(headings) { heading in
                Button {
                    NotificationCenter.default.post(name: .readerScrollToHeading, object: heading.id)
                    dismiss()
                } label: {
                    Text(heading.title)
                        .padding(.leading, CGFloat(max(heading.level - 1, 0)) * 12)
                        .lineLimit(2)
                }
            }
            .navigationTitle("目录")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }
}

extension Notification.Name {
    static let readerScrollToHeading = Notification.Name("colamd.reader.scroll-to-heading")
}
