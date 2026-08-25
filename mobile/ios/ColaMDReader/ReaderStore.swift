import Foundation
import UniformTypeIdentifiers

struct ReaderDocument: Identifiable, Equatable {
    let id: UUID
    let fileName: String
    let content: String
    let importedURL: URL
    let outline: [DocumentHeading]
}

struct DocumentHeading: Identifiable, Equatable {
    let id: String
    let level: Int
    let title: String
}

struct RecentDocument: Codable, Identifiable, Equatable {
    let id: UUID
    let fileName: String
    let relativePath: String
    let openedAt: Date
}

enum ReaderTheme: String, CaseIterable, Identifiable {
    case system
    case light
    case dark
    case sepia

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "跟随系统"
        case .light: "浅色"
        case .dark: "深色"
        case .sepia: "护眼"
        }
    }
}

enum ReaderFontSize: Int, CaseIterable, Identifiable {
    case small = 16
    case standard = 18
    case large = 20
    case extraLarge = 22

    var id: Int { rawValue }

    var label: String {
        switch self {
        case .small: "小"
        case .standard: "标准"
        case .large: "大"
        case .extraLarge: "特大"
        }
    }
}

enum ReaderDocumentType {
    static let markdown = UTType(exportedAs: "ai.marswave.colamd.reader.markdown")
    static let importableTypes: [UTType] = [markdown, .plainText]
}

@MainActor
final class ReaderStore: ObservableObject {
    @Published private(set) var document: ReaderDocument?
    @Published private(set) var recents: [RecentDocument] = []
    @Published var errorMessage: String?
    @Published var theme: ReaderTheme {
        didSet { defaults.set(theme.rawValue, forKey: Keys.theme) }
    }
    @Published var fontSize: ReaderFontSize {
        didSet { defaults.set(fontSize.rawValue, forKey: Keys.fontSize) }
    }

    private enum Keys {
        static let recents = "colamd.reader.recents"
        static let theme = "colamd.reader.theme"
        static let fontSize = "colamd.reader.font-size"
    }

    private let defaults: UserDefaults
    private let fileManager: FileManager
    private let maxDocumentBytes = 10 * 1024 * 1024

    init(defaults: UserDefaults = .standard, fileManager: FileManager = .default) {
        self.defaults = defaults
        self.fileManager = fileManager
        self.theme = ReaderTheme(rawValue: defaults.string(forKey: Keys.theme) ?? "") ?? .system
        self.fontSize = ReaderFontSize(rawValue: defaults.integer(forKey: Keys.fontSize)) ?? .standard
        self.recents = Self.loadRecents(defaults: defaults)
    }

    func importDocument(from url: URL) {
        do {
            let document = try importDocumentSynchronously(from: url)
            self.document = document
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func open(url: URL) {
        importDocument(from: url)
    }

    func reopen(_ recent: RecentDocument) {
        let url = documentsDirectory.appendingPathComponent(recent.relativePath)
        do {
            let document = try loadDocument(from: url, id: recent.id, fileName: recent.fileName)
            self.document = document
            touch(recent)
        } catch {
            remove(recent)
            errorMessage = "找不到这份文档，已从最近阅读中移除。"
        }
    }

    func closeDocument() {
        document = nil
    }

    func remove(_ recent: RecentDocument) {
        let url = documentsDirectory.appendingPathComponent(recent.relativePath)
        try? fileManager.removeItem(at: url)
        recents.removeAll { $0.id == recent.id }
        persistRecents()
    }

    private func importDocumentSynchronously(from sourceURL: URL) throws -> ReaderDocument {
        let accessingSecurityScopedResource = sourceURL.startAccessingSecurityScopedResource()
        defer {
            if accessingSecurityScopedResource {
                sourceURL.stopAccessingSecurityScopedResource()
            }
        }

        let attributes = try fileManager.attributesOfItem(atPath: sourceURL.path)
        if let size = attributes[.size] as? NSNumber, size.intValue > maxDocumentBytes {
            throw ReaderError.documentTooLarge
        }

        let data = try Data(contentsOf: sourceURL)
        let content = try decodeMarkdown(data)
        let id = UUID()
        let fileName = sanitizedFileName(sourceURL.lastPathComponent)
        let relativePath = "ImportedDocuments/\(id.uuidString)-\(fileName)"
        let targetURL = documentsDirectory.appendingPathComponent(relativePath)

        try fileManager.createDirectory(at: targetURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: targetURL, options: .atomic)

        let recent = RecentDocument(id: id, fileName: fileName, relativePath: relativePath, openedAt: .now)
        recents.removeAll { $0.id == id || $0.fileName == fileName }
        recents.insert(recent, at: 0)
        recents = Array(recents.prefix(12))
        persistRecents()

        return ReaderDocument(id: id, fileName: fileName, content: content, importedURL: targetURL, outline: makeOutline(from: content))
    }

    private func loadDocument(from url: URL, id: UUID, fileName: String) throws -> ReaderDocument {
        let data = try Data(contentsOf: url)
        let content = try decodeMarkdown(data)
        return ReaderDocument(id: id, fileName: fileName, content: content, importedURL: url, outline: makeOutline(from: content))
    }

    private func touch(_ recent: RecentDocument) {
        guard let index = recents.firstIndex(where: { $0.id == recent.id }) else { return }
        let updated = RecentDocument(id: recent.id, fileName: recent.fileName, relativePath: recent.relativePath, openedAt: .now)
        recents.remove(at: index)
        recents.insert(updated, at: 0)
        persistRecents()
    }

    private func decodeMarkdown(_ data: Data) throws -> String {
        if let content = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .utf16) {
            return content
        }
        throw ReaderError.unsupportedEncoding
    }

    private var documentsDirectory: URL {
        fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ColaMDReader", isDirectory: true)
    }

    private func persistRecents() {
        guard let data = try? JSONEncoder().encode(recents) else { return }
        defaults.set(data, forKey: Keys.recents)
    }

    private static func loadRecents(defaults: UserDefaults) -> [RecentDocument] {
        guard let data = defaults.data(forKey: Keys.recents),
              let recents = try? JSONDecoder().decode([RecentDocument].self, from: data) else {
            return []
        }
        return recents.sorted { $0.openedAt > $1.openedAt }
    }

    private func sanitizedFileName(_ name: String) -> String {
        let fallback = "未命名.md"
        let forbidden = CharacterSet(charactersIn: "/:\\0").union(.controlCharacters)
        let result = String(String.UnicodeScalarView(name.unicodeScalars.filter { !forbidden.contains($0) }))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return result.isEmpty ? fallback : result
    }

    private func makeOutline(from content: String) -> [DocumentHeading] {
        var headings: [DocumentHeading] = []
        let pattern = "^(#{1,6})[ \\t]+(.+?)[ \\t]*#*[ \\t]*$"
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) else {
            return headings
        }
        let range = NSRange(content.startIndex..., in: content)
        expression.enumerateMatches(in: content, options: [], range: range) { match, _, _ in
            guard let match,
                  let hashesRange = Range(match.range(at: 1), in: content),
                  let titleRange = Range(match.range(at: 2), in: content) else { return }
            let title = String(content[titleRange])
                .replacingOccurrences(of: "`", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { return }
            headings.append(DocumentHeading(id: "heading-\(headings.count)", level: content[hashesRange].count, title: title))
        }
        return headings
    }
}

enum ReaderError: LocalizedError {
    case documentTooLarge
    case unsupportedEncoding

    var errorDescription: String? {
        switch self {
        case .documentTooLarge:
            "文档超过 10 MB，暂时无法打开。"
        case .unsupportedEncoding:
            "此文件不是 UTF-8 或 UTF-16 编码的 Markdown 文档。"
        }
    }
}
