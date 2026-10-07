// Mark's Render PDF Editor – macOS app.
// A native window (WKWebView, the Safari engine built into macOS) showing the same editor as on Windows,
// plus native services the web page asks for through `window.webkit.messageHandlers.native`:
//   ocr        – Apple Vision text recognition (offline)
//   save/saveTo – Save dialog / save again to the same file
//   saveFolder – write several files into a folder you choose (ZIP extract)
//   print      – print a PDF with the macOS print dialog
//   font       – read an installed font file (full fonts when editing text)
import Cocoa
import WebKit
import Vision
import PDFKit
import UniformTypeIdentifiers

let appName = "Mark's Render PDF Editor"

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler,
    WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var pageReady = false
    var pendingOpen: [URL] = []
    var savedURLs: [String: URL] = [:]
    var allowClose = false
    var titleObserver: NSKeyValueObservation?

    // ---------------- startup ----------------
    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "native")
        cfg.websiteDataStore = .default() // keeps saved signatures / profiles between launches
        web = WKWebView(frame: .zero, configuration: cfg)
        web.uiDelegate = self
        web.navigationDelegate = self
        if #available(macOS 13.3, *) { web.isInspectable = true }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = appName
        window.contentView = web
        window.delegate = self
        window.setFrameAutosaveName("MainWindow")
        if !window.setFrameUsingName("MainWindow") { window.center() }
        window.makeKeyAndOrderFront(nil)
        titleObserver = web.observe(\.title, options: [.new]) { [weak self] w, _ in
            if let t = w.title, !t.isEmpty { self?.window.title = t }
        }
        let res = Bundle.main.resourceURL!
        web.loadFileURL(res.appendingPathComponent("PDFEditor.html"), allowingReadAccessTo: res)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
        if allowClose || window == nil || !window.isVisible { return .terminateNow }
        window.performClose(nil) // asks about unsaved changes, then quits
        return .terminateCancel
    }

    // ---------------- unsaved changes ----------------
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if allowClose { return true }
        web.evaluateJavaScript("typeof S !== 'undefined' && !!(S.dirty && S.pages.length)") { [weak self] r, _ in
            guard let self = self else { return }
            if (r as? Bool) == true {
                let a = NSAlert()
                a.messageText = "You have unsaved changes."
                a.informativeText = "Close without saving?"
                a.addButton(withTitle: "Close Without Saving")
                a.addButton(withTitle: "Cancel")
                a.beginSheetModal(for: self.window) { res in
                    if res == .alertFirstButtonReturn { self.allowClose = true; self.window.close() }
                }
            } else { self.allowClose = true; self.window.close() }
        }
        return false
    }

    // ---------------- opening files from Finder / Dock ----------------
    func application(_ app: NSApplication, open urls: [URL]) { pendingOpen += urls; flushOpen() }

    func flushOpen() {
        guard pageReady, !pendingOpen.isEmpty else { return }
        for (i, u) in pendingOpen.enumerated() {
            guard let d = try? Data(contentsOf: u) else { continue }
            let js = "window.__openPending(\(jsString(u.lastPathComponent)), \"\(d.base64EncodedString())\", \(i > 0))"
            web.evaluateJavaScript(js, completionHandler: nil)
        }
        pendingOpen.removeAll()
    }

    func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) { pageReady = true; flushOpen() }

    // ---------------- bridge ----------------
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let body = m.body as? [String: Any], let cmd = body["cmd"] as? String, let id = body["id"] as? Int else { return }
        let reply: (Any?, String?) -> Void = { [weak self] result, err in self?.reply(id, result, err) }
        switch cmd {
        case "ocr": ocr(body["png"] as? String ?? "", reply)
        case "save": save(body, reply)
        case "saveTo": saveTo(body, reply)
        case "saveFolder": saveFolder(body, reply)
        case "print": printPdf(body["b64"] as? String ?? "", reply)
        case "font": font(body["ps"] as? String ?? "", reply)
        default: reply(nil, "Unknown command: \(cmd)")
        }
    }

    func reply(_ id: Int, _ result: Any?, _ err: String?) {
        var payload: [String: Any] = ["id": id]
        if let e = err { payload["error"] = e } else { payload["result"] = result ?? NSNull() }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { self.web.evaluateJavaScript("window.__nativeReply(\(json))", completionHandler: nil) }
    }

    func jsString(_ s: String) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: [s]), let a = String(data: d, encoding: .utf8) else { return "\"\"" }
        return String(a.dropFirst().dropLast()) // ["…"] -> "…"
    }

    // OCR with Apple's Vision framework – returns lines with pixel boxes (top-left origin), like the Windows helper
    func ocr(_ b64: String, _ reply: @escaping (Any?, String?) -> Void) {
        guard let data = Data(base64Encoded: b64), let img = NSImage(data: data),
              let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return reply(nil, "Could not read the image.") }
        let W = CGFloat(cg.width), H = CGFloat(cg.height)
        let req = VNRecognizeTextRequest { r, e in
            if let e = e { return reply(nil, e.localizedDescription) }
            let obs = (r.results as? [VNRecognizedTextObservation]) ?? []
            let lines: [[String: Any]] = obs.compactMap { o in
                guard let t = o.topCandidates(1).first else { return nil }
                let b = o.boundingBox
                return ["text": t.string, "x": Int(b.minX * W), "y": Int((1 - b.maxY) * H), "w": Int(b.width * W), "h": Int(b.height * H)]
            }
            reply(["lines": lines], nil)
        }
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = true
        DispatchQueue.global(qos: .userInitiated).async {
            do { try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req]) }
            catch { reply(nil, error.localizedDescription) }
        }
    }

    func save(_ body: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let data = Data(base64Encoded: body["b64"] as? String ?? "") else { return reply(nil, "Nothing to save.") }
        let p = NSSavePanel()
        p.nameFieldStringValue = body["name"] as? String ?? "document.pdf"
        p.canCreateDirectories = true
        let ext = (p.nameFieldStringValue as NSString).pathExtension
        if !ext.isEmpty, let t = UTType(filenameExtension: ext) { p.allowedContentTypes = [t] }
        p.beginSheetModal(for: window) { r in
            guard r == .OK, let url = p.url else { return reply(false, nil) }
            do {
                try data.write(to: url, options: .atomic)
                let token = UUID().uuidString
                self.savedURLs[token] = url
                reply(["name": url.lastPathComponent, "token": token], nil)
            } catch { reply(nil, error.localizedDescription) }
        }
    }

    func saveTo(_ body: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let t = body["token"] as? String, let url = savedURLs[t],
              let data = Data(base64Encoded: body["b64"] as? String ?? "") else { return reply(nil, "Not saved yet.") }
        do { try data.write(to: url, options: .atomic); reply(["name": url.lastPathComponent, "token": t], nil) }
        catch { reply(nil, error.localizedDescription) }
    }

    func saveFolder(_ body: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let files = body["files"] as? [[String: Any]] else { return reply(nil, "No files.") }
        let p = NSOpenPanel()
        p.canChooseDirectories = true; p.canChooseFiles = false; p.canCreateDirectories = true
        p.prompt = "Extract Here"
        p.beginSheetModal(for: window) { r in
            guard r == .OK, let dir = p.url else { return reply(0, nil) }
            var n = 0
            for f in files {
                guard let path = f["path"] as? String, let d = Data(base64Encoded: f["b64"] as? String ?? "") else { continue }
                // only safe path parts – never write outside the chosen folder
                let parts = path.split(separator: "/").map(String.init).filter { !$0.isEmpty && $0 != "." && $0 != ".." }
                guard !parts.isEmpty else { continue }
                var url = dir
                for part in parts { url.appendPathComponent(part) }
                try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                if (try? d.write(to: url)) != nil { n += 1 }
            }
            reply(n, nil)
        }
    }

    func printPdf(_ b64: String, _ reply: @escaping (Any?, String?) -> Void) {
        guard let d = Data(base64Encoded: b64), let doc = PDFDocument(data: d),
              let op = doc.printOperation(for: NSPrintInfo.shared, scalingMode: .pageScaleToFit, autoRotate: true)
        else { return reply(nil, "Could not prepare the document for printing.") }
        op.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
        reply(true, nil)
    }

    // Full version of a font the PDF only partly contains (single .ttf/.otf files only)
    func font(_ ps: String, _ reply: @escaping (Any?, String?) -> Void) {
        let f = CTFontCreateWithName(ps as CFString, 12, nil)
        let real = CTFontCopyPostScriptName(f) as String
        guard real.caseInsensitiveCompare(ps) == .orderedSame,
              let url = CTFontCopyAttribute(f, kCTFontURLAttribute) as? URL,
              ["ttf", "otf"].contains(url.pathExtension.lowercased()),
              let d = try? Data(contentsOf: url) else { return reply(nil, nil) }
        reply(["b64": d.base64EncodedString(), "family": CTFontCopyFamilyName(f) as String], nil)
    }

    // ---------------- dialogs the page uses ----------------
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText d: String?,
                 initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = p; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24)); tf.stringValue = d ?? ""
        a.accessoryView = tf
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn ? tf.stringValue : nil) }
        a.window.initialFirstResponder = tf
    }

    func webView(_ w: WKWebView, runOpenPanelWith params: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let p = NSOpenPanel()
        p.allowsMultipleSelection = params.allowsMultipleSelection
        p.canChooseDirectories = params.allowsDirectories
        p.canChooseFiles = true
        p.beginSheetModal(for: window) { r in completionHandler(r == .OK ? p.urls : nil) }
    }

    // links that would open a new window → default browser
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url, ["http", "https", "mailto"].contains(u.scheme ?? "") { NSWorkspace.shared.open(u) }
        return nil
    }

    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if a.shouldPerformDownload { return decisionHandler(.download) }
        if let u = a.request.url, a.navigationType == .linkActivated, !["file", "blob", "data", "about"].contains(u.scheme ?? "") {
            NSWorkspace.shared.open(u); return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    // any remaining browser-style downloads get a normal Save dialog
    func webView(_ w: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ w: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ d: WKDownload, decideDestinationUsing r: URLResponse, suggestedFilename name: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let p = NSSavePanel(); p.nameFieldStringValue = name
        p.beginSheetModal(for: window) { res in
            guard res == .OK, let url = p.url else { return completionHandler(nil) }
            try? FileManager.default.removeItem(at: url)
            completionHandler(url)
        }
    }

    // ---------------- menu ----------------
    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About \(appName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        winItem.submenu = win
        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
