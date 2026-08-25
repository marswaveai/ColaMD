import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let appGroupIdentifier = "group.ai.marswave.colamd.reader"
    private var hasStartedImport = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let label = UILabel()
        label.text = "正在导入到 ColaMD"
        label.font = .preferredFont(forTextStyle: .headline)
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !hasStartedImport else { return }
        hasStartedImport = true
        importMarkdownFile()
    }

    private func importMarkdownFile() {
        guard let provider = extensionContext?.inputItems
            .compactMap({ $0 as? NSExtensionItem })
            .flatMap({ $0.attachments ?? [] })
            .first(where: { provider in
                provider.registeredTypeIdentifiers.contains { identifier in
                    UTType(identifier)?.conforms(to: .plainText) == true
                }
            }) else {
            complete(with: ShareError.noMarkdownFile)
            return
        }

        let typeIdentifier = provider.registeredTypeIdentifiers.first {
            UTType($0)?.conforms(to: .plainText) == true
        } ?? UTType.plainText.identifier

        provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { [weak self] (url: URL?, error: Error?) in
            guard let self else { return }
            guard let url else {
                self.complete(with: error ?? ShareError.noMarkdownFile)
                return
            }

            do {
                try self.copyToSharedContainer(from: url)
                self.complete(with: nil)
            } catch {
                self.complete(with: error)
            }
        }
    }

    private func copyToSharedContainer(from sourceURL: URL) throws {
        guard let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupIdentifier
        ) else {
            throw ShareError.sharedContainerUnavailable
        }

        let directory = containerURL.appendingPathComponent("SharedImports", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let originalName = sourceURL.lastPathComponent.isEmpty ? "未命名.md" : sourceURL.lastPathComponent
        let destination = directory.appendingPathComponent("\(UUID().uuidString)-\(originalName)")
        try FileManager.default.copyItem(at: sourceURL, to: destination)
    }

    private func complete(with error: Error?) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let error {
                let alert = UIAlertController(
                    title: "无法导入",
                    message: error.localizedDescription,
                    preferredStyle: .alert
                )
                alert.addAction(UIAlertAction(title: "好", style: .default) { _ in
                    self.extensionContext?.cancelRequest(withError: error)
                })
                self.present(alert, animated: true)
            } else {
                self.extensionContext?.completeRequest(returningItems: nil)
            }
        }
    }
}

private enum ShareError: LocalizedError {
    case noMarkdownFile
    case sharedContainerUnavailable

    var errorDescription: String? {
        switch self {
        case .noMarkdownFile:
            "没有可导入的 Markdown 文件。"
        case .sharedContainerUnavailable:
            "ColaMD 的共享存储不可用。"
        }
    }
}
