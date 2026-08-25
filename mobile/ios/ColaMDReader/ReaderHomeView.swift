import SwiftUI

struct ReaderHomeView: View {
    @Environment(\.colorScheme) private var colorScheme
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
                            Text("ColaMD")
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
                .padding(.horizontal, 18)
                .padding(.vertical, 8)
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
                    Text(recent.openedAt.formatted(date: .abbreviated, time: .shortened))
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
        ZStack {
            ReaderReadingPalette.page(for: store.theme, colorScheme: colorScheme)
                .ignoresSafeArea()
            WebReaderView(document: document, theme: store.theme, fontSize: store.fontSize)
        }
        .navigationBarBackButtonHidden()
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) {
            readerHeader(document)
                .background(ReaderReadingPalette.page(for: store.theme, colorScheme: colorScheme))
        }
        .tint(ReaderReadingPalette.accent(for: store.theme, colorScheme: colorScheme))
        .sheet(isPresented: $isOutlinePresented) {
            OutlineSheet(headings: document.outline)
        }
    }

    private func readerHeader(_ document: ReaderDocument) -> some View {
        HStack(spacing: 10) {
            Button {
                store.closeDocument()
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ReaderReadingPalette.ink(for: store.theme, colorScheme: colorScheme))
                    .frame(width: 44, height: 42)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("返回文档库")

            Text(document.fileName)
                .font(.caption)
                .lineLimit(1)
                .foregroundStyle(ReaderReadingPalette.ink(for: store.theme, colorScheme: colorScheme))

            Spacer(minLength: 4)

            if !document.outline.isEmpty {
                Button {
                    isOutlinePresented = true
                } label: {
                    Image(systemName: "list.bullet")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(ReaderReadingPalette.ink(for: store.theme, colorScheme: colorScheme))
                        .frame(width: 44, height: 42)
                }
                .buttonStyle(.plain)
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
                Text("格式")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(ReaderReadingPalette.ink(for: store.theme, colorScheme: colorScheme))
                    .frame(minWidth: 44, minHeight: 42)
            }
            .accessibilityLabel("阅读格式")
        }
        .padding(.horizontal, 10)
        .frame(height: 42)
    }
}

private enum ReaderReadingPalette {
    static func colorScheme(for theme: ReaderTheme, system: ColorScheme) -> ColorScheme {
        switch theme {
        case .system: system
        case .dark, .solarizedDark, .nord, .gruvbox, .dracula, .midnight: .dark
        default: .light
        }
    }

    static func page(for theme: ReaderTheme, colorScheme: ColorScheme) -> Color {
        switch theme {
        case .system: colorScheme == .dark ? Color(red: 0.05, green: 0.067, blue: 0.09) : .white
        case .light, .notion, .bear: .white
        case .dark: Color(red: 0.05, green: 0.067, blue: 0.09)
        case .elegant: Color(red: 0.94, green: 0.93, blue: 0.92)
        case .sepia: Color(red: 0.965, green: 0.937, blue: 0.878)
        case .writer: Color(red: 0.988, green: 0.988, blue: 0.98)
        case .solarizedDark: Color(red: 0, green: 0.169, blue: 0.212)
        case .nord: Color(red: 0.18, green: 0.204, blue: 0.251)
        case .gruvbox: Color(red: 0.157, green: 0.157, blue: 0.157)
        case .dracula: Color(red: 0.157, green: 0.165, blue: 0.212)
        case .midnight: .black
        }
    }

    static func ink(for theme: ReaderTheme, colorScheme: ColorScheme) -> Color {
        switch theme {
        case .system: colorScheme == .dark ? Color(red: 0.90, green: 0.93, blue: 0.95) : Color(red: 0.14, green: 0.16, blue: 0.18)
        case .light, .notion, .bear: Color(red: 0.14, green: 0.16, blue: 0.18)
        case .dark: Color(red: 0.90, green: 0.93, blue: 0.95)
        case .elegant: Color(red: 0.17, green: 0.17, blue: 0.17)
        case .sepia: Color(red: 0.31, green: 0.25, blue: 0.20)
        case .writer: Color(red: 0.10, green: 0.10, blue: 0.10)
        case .solarizedDark: Color(red: 0.76, green: 0.84, blue: 0.84)
        case .nord: Color(red: 0.85, green: 0.87, blue: 0.91)
        case .gruvbox: Color(red: 0.92, green: 0.86, blue: 0.70)
        case .dracula: Color(red: 0.97, green: 0.97, blue: 0.95)
        case .midnight: Color(red: 0.84, green: 0.84, blue: 0.84)
        }
    }

    static func accent(for theme: ReaderTheme, colorScheme: ColorScheme) -> Color {
        switch theme {
        case .system: colorScheme == .dark ? Color(red: 0.345, green: 0.651, blue: 1) : Color(red: 0.035, green: 0.412, blue: 0.855)
        case .light: Color(red: 0.035, green: 0.412, blue: 0.855)
        case .dark: Color(red: 0.345, green: 0.651, blue: 1)
        case .elegant: Color(red: 0.737, green: 0.267, blue: 0.141)
        case .sepia: Color(red: 0.612, green: 0.369, blue: 0.161)
        case .notion: Color(red: 0.216, green: 0.208, blue: 0.184)
        case .bear: Color(red: 0.831, green: 0.239, blue: 0.165)
        case .writer: Color(red: 0.231, green: 0.431, blue: 0.769)
        case .solarizedDark: Color(red: 0.188, green: 0.576, blue: 0.855)
        case .nord: Color(red: 0.533, green: 0.753, blue: 0.816)
        case .gruvbox: Color(red: 0.514, green: 0.647, blue: 0.596)
        case .dracula: Color(red: 0.741, green: 0.576, blue: 0.976)
        case .midnight: Color(red: 0.039, green: 0.518, blue: 1)
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
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ReaderPalette.accent)
            .frame(minHeight: 32)
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.58 : 1)
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
