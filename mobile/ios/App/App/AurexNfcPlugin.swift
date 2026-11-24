import Capacitor
import CoreNFC
import UIKit

/// NFC for pay links on iPhone: read an Aurex sticker (or an Android phone sharing a pay link) to pay,
/// and write a pay link to an NFC sticker. iPhones can't present a link to another phone themselves,
/// so `share` reports that it isn't available. Only https links are written; the web layer decides
/// which links it opens.
@objc(AurexNfcPlugin)
public class AurexNfcPlugin: CAPPlugin, CAPBridgedPlugin, NFCNDEFReaderSessionDelegate {
    public let identifier = "AurexNfcPlugin"
    public let jsName = "AurexNfc"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSharing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
    ]

    private var session: NFCNDEFReaderSession?
    private var pending: CAPPluginCall?
    private var message: NFCNDEFMessage?
    private var lock = false

    @objc func status(_ call: CAPPluginCall) {
        let ok = NFCNDEFReaderSession.readingAvailable
        call.resolve(["supported": ok, "enabled": ok, "canShare": false, "canRead": ok, "canWrite": ok, "sharing": false])
    }

    @objc func share(_ call: CAPPluginCall) {
        call.reject("iPhones can't share a link by tapping. Write it to an NFC sticker instead.", "unavailable")
    }

    @objc func stopSharing(_ call: CAPPluginCall) {
        call.resolve()
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        call.resolve() // NFC is always on for apps on iPhone.
    }

    @objc func read(_ call: CAPPluginCall) {
        start(call, message: nil, prompt: "Hold the top of your iPhone near the Aurex sticker or phone.")
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let url = call.getString("url"), url.hasPrefix("https://"),
              let record = NFCNDEFPayload.wellKnownTypeURIPayload(string: url) else {
            call.reject("Only https links can be written", "invalid_link")
            return
        }
        lock = call.getBool("lock") ?? false
        start(call, message: NFCNDEFMessage(records: [record]), prompt: "Hold the top of your iPhone near the NFC sticker.")
    }

    @objc func cancel(_ call: CAPPluginCall) {
        finish(error: ("Cancelled", "cancelled"))
        session?.invalidate()
        call.resolve()
    }

    private func start(_ call: CAPPluginCall, message: NFCNDEFMessage?, prompt: String) {
        guard NFCNDEFReaderSession.readingAvailable else {
            call.reject("This iPhone can't read NFC", "unavailable")
            return
        }
        finish(error: ("Cancelled", "cancelled"))
        pending = call
        self.message = message
        DispatchQueue.main.async {
            let s = NFCNDEFReaderSession(delegate: self, queue: nil, invalidateAfterFirstRead: false)
            s.alertMessage = prompt
            self.session = s
            s.begin()
        }
    }

    private func finish(result: [String: Any]? = nil, error: (String, String)? = nil) {
        guard let call = pending else { return }
        pending = nil
        message = nil
        if let result = result { call.resolve(result) } else if let (msg, code) = error { call.reject(msg, code) }
    }

    // MARK: NFCNDEFReaderSessionDelegate

    public func readerSession(_ session: NFCNDEFReaderSession, didInvalidateWithError error: Error) {
        let code = (error as? NFCReaderError)?.code
        if code == .readerSessionInvalidationErrorUserCanceled {
            finish(error: ("Cancelled", "cancelled"))
        } else if code != .readerSessionInvalidationErrorFirstNDEFTagRead {
            finish(error: (error.localizedDescription, "tag_error"))
        }
        self.session = nil
    }

    public func readerSession(_ session: NFCNDEFReaderSession, didDetectNDEFs messages: [NFCNDEFMessage]) {
        // Not used: tags are handled in didDetect below, which also allows writing.
    }

    public func readerSession(_ session: NFCNDEFReaderSession, didDetect tags: [NFCNDEFTag]) {
        guard let tag = tags.first else { return }
        session.connect(to: tag) { error in
            if error != nil {
                session.invalidate(errorMessage: "Couldn't connect. Hold still and try again.")
                return
            }
            tag.queryNDEFStatus { status, _, error in
                if error != nil {
                    session.invalidate(errorMessage: "Couldn't read this tag.")
                    return
                }
                if let message = self.message {
                    self.write(message, to: tag, status: status, in: session)
                } else {
                    tag.readNDEF { msg, _ in
                        let url = msg?.records.compactMap { $0.wellKnownTypeURIPayload()?.absoluteString }.first
                        if let url = url {
                            session.alertMessage = "Got it"
                            self.finish(result: ["url": url])
                            session.invalidate()
                        } else {
                            session.invalidate(errorMessage: "There's no link on this tag.")
                        }
                    }
                }
            }
        }
    }

    private func write(_ message: NFCNDEFMessage, to tag: NFCNDEFTag, status: NFCNDEFStatus, in session: NFCNDEFReaderSession) {
        switch status {
        case .readOnly:
            session.invalidate(errorMessage: "This sticker is locked and can't be changed.")
        case .notSupported:
            session.invalidate(errorMessage: "This tag can't hold a link. Use an NFC sticker such as NTAG213.")
        default:
            tag.writeNDEF(message) { error in
                if let error = error {
                    session.invalidate(errorMessage: "Couldn't write the link: \(error.localizedDescription)")
                    return
                }
                let done = { (locked: Bool) in
                    session.alertMessage = locked ? "Written and locked" : "Written"
                    self.finish(result: ["written": true, "locked": locked])
                    session.invalidate()
                }
                if self.lock {
                    tag.writeLock { lockError in done(lockError == nil) }
                } else {
                    done(false)
                }
            }
        }
    }
}
