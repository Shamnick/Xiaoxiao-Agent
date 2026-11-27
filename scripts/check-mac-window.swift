// Exercise the Launch Services path in a fresh profile without debugger flags.
import AppKit
import CoreGraphics

func checkWindow(_ bundle: URL) throws {
    let fm = FileManager.default
    let profile = fm.temporaryDirectory.appendingPathComponent("xiaoxiao-window-" + UUID().uuidString)
    try fm.createDirectory(at: profile, withIntermediateDirectories: false)
    let config = NSWorkspace.OpenConfiguration()
    config.createsNewApplicationInstance = true
    config.environment = ["XIAOXIAO_SMOKE_DIR": profile.path, "XIAOXIAO_SMOKE_SHOW": "1"]
    var launched: NSRunningApplication?
    var launchError: Error?
    let before = Set(NSWorkspace.shared.runningApplications.map { $0.processIdentifier })
    NSWorkspace.shared.openApplication(at: bundle, configuration: config) { app, error in
        launched = app
        launchError = error
    }
    defer {
        if let app = launched, !before.contains(app.processIdentifier) {
            if !app.isTerminated {
                app.terminate()
                let deadline = Date().addingTimeInterval(3)
                while !app.isTerminated && Date() < deadline {
                    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
                }
            }
            if !app.isTerminated { app.forceTerminate() }
        }
        try? fm.removeItem(at: profile)
    }
    let deadline = Date().addingTimeInterval(20)
    while Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        if let error = launchError { throw error }
        guard let app = launched else { continue }
        guard !before.contains(app.processIdentifier),
              app.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == bundle.resolvingSymlinksInPath().standardizedFileURL.path,
              !app.isTerminated else { throw CheckError.wrongInstance }
        guard app.isFinishedLaunching,
              fm.fileExists(atPath: profile.appendingPathComponent("Session").path) else { continue }
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
        if windows.contains(where: { w in
            guard w[kCGWindowOwnerPID as String] as? pid_t == app.processIdentifier,
                  w[kCGWindowLayer as String] as? Int == 0,
                  let bounds = w[kCGWindowBounds as String] as? [String: Double] else { return false }
            return (bounds["Width"] ?? 0) >= 600 && (bounds["Height"] ?? 0) >= 400
        }) {
            print("PASS: Launch Services opened a visible window in the isolated profile.")
            return
        }
    }
    throw CheckError.noWindow
}

enum CheckError: Error { case wrongInstance, noWindow }
guard CommandLine.arguments.count == 2 else { exit(2) }
do {
    try checkWindow(URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true).standardizedFileURL)
} catch {
    fputs("Mac window check failed: \(error)\n", stderr)
    exit(1)
}
