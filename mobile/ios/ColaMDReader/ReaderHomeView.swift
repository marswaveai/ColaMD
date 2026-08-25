import SwiftUI

struct ReaderHomeView: View {
    @EnvironmentObject private var store: ReaderStore
    @State private var isImporterPresented = false
    @State private var isOutlinePresented = false

    var body: some View {
        Group {
            if let document = store.document {
                NavigationStack {
                    reader(document)
                }
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

    private var library: some View {
        ZStack {
            Color(uiColor: .systemBackground)
                .ignoresSafeArea()

            GeometryReader { geometry in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("ColaMD Reader")
                                .font(.largeTitle.weight(.bold))
                            Text("Markdown Reader")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.top, 20)

                        if store.recents.isEmpty {
                            emptyLibrary(availableHeight: geometry.size.height)
                        } else {
                            recentDocuments
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 24)
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                Divider()
                Button {
                    isImporterPresented = true
                } label: {
                    Label("打开文件", systemImage: "folder")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            }
            .background(.bar)
        }
    }

    private func emptyLibrary(availableHeight: CGFloat) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "doc.text")
                .font(.system(size: 32, weight: .medium))
                .foregroundStyle(.secondary)
            Text("还没有文档")
                .font(.headline)
        }
        .frame(maxWidth: .infinity, minHeight: max(260, availableHeight - 180))
    }

    private var recentDocuments: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("最近阅读")
                .font(.headline)
                .padding(.top, 38)
                .padding(.bottom, 2)

            ForEach(store.recents) { recent in
                recentRow(recent)
            }
        }
    }

    private func recentRow(_ recent: RecentDocument) -> some View {
        Button {
            store.reopen(recent)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "doc.text")
                    .font(.title3)
                    .foregroundStyle(.tint)
                    .frame(width: 28)

                VStack(alignment: .leading, spacing: 4) {
                    Text(recent.fileName)
                        .font(.body.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    Text(recent.openedAt, style: .relative)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(role: .destructive) {
                store.remove(recent)
            } label: {
                Label("移除", systemImage: "trash")
            }
        }
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
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
