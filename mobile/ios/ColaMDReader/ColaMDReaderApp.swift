import SwiftUI

@main
struct ColaMDReaderApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var store = ReaderStore()

    var body: some Scene {
        WindowGroup {
            ReaderHomeView()
                .environmentObject(store)
                .onOpenURL { url in
                    store.open(url: url)
                }
                .onChange(of: scenePhase) { phase in
                    if phase == .active {
                        store.importPendingSharedDocuments()
                    }
                }
        }
    }
}
