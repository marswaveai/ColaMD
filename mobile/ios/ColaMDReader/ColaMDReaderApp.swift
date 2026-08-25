import SwiftUI

@main
struct ColaMDReaderApp: App {
    @StateObject private var store = ReaderStore()

    var body: some Scene {
        WindowGroup {
            ReaderHomeView()
                .environmentObject(store)
                .onOpenURL { url in
                    store.open(url: url)
                }
        }
    }
}
