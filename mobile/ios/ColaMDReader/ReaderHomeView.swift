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
            ReaderPalette.page
                .ignoresSafeArea()

            GeometryReader { geometry in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("ColaMD Reader")
                                .font(.largeTitle.weight(.bold))
                                .foregroundStyle(ReaderPalette.ink)
                            Capsule()
                                .fill(ReaderPalette.accent)
                                .frame(width: 34, height: 3)
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
                .buttonStyle(ReaderPrimaryButtonStyle())
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            }
            .background(ReaderPalette.paper)
        }
    }

    private func emptyLibrary(availableHeight: CGFloat) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "doc.text")
                .font(.system(size: 32, weight: .medium))
                .foregroundStyle(ReaderPalette.accent)
            Text("还没有文档")
                .font(.headline)
                .foregroundStyle(ReaderPalette.ink)
        }
        .frame(maxWidth: .infinity, minHeight: max(260, availableHeight - 180))
    }

    private var recentDocuments: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("最近阅读")
                .font(.headline)
                .foregroundStyle(ReaderPalette.ink)
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
                    .foregroundStyle(ReaderPalette.accent)
                    .frame(width: 28)

                VStack(alignment: .leading, spacing: 4) {
                    Text(recent.fileName)
                        .font(.body.weight(.medium))
                        .foregroundStyle(ReaderPalette.ink)
                        .lineLimit(2)
                    Text(recent.openedAt, style: .relative)
                        .font(.caption)
                        .foregroundStyle(ReaderPalette.muted)
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ReaderPalette.muted.opacity(0.72))
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
        .background(ReaderPalette.paper, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(ReaderPalette.line, lineWidth: 1)
        }
    }

    private func reader(_ document: ReaderDocument) -> some View {
        WebReaderView(document: document, theme: store.theme, fontSize: store.fontSize)
            .navigationTitle(document.fileName)
            .navigationBarTitleDisplayMode(.inline)
            .tint(ReaderPalette.accent)
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

private enum ReaderPalette {
    static let page = Color(red: 0.98, green: 0.965, blue: 0.94)
    static let paper = Color(red: 1.0, green: 0.992, blue: 0.978)
    static let ink = Color(red: 0.16, green: 0.145, blue: 0.13)
    static let muted = Color(red: 0.43, green: 0.40, blue: 0.37)
    static let line = Color(red: 0.87, green: 0.84, blue: 0.80)
    static let accent = Color(red: 0.945, green: 0.365, blue: 0.18)
}

private struct ReaderPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.vertical, 15)
            .background(ReaderPalette.accent, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .opacity(configuration.isPressed ? 0.78 : 1)
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
