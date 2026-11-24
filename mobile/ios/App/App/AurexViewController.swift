import Capacitor
import UIKit

/// The app's web view, with Aurex's own native plugins registered (they live in this app, not in a package).
class AurexViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(AurexNfcPlugin())
    }
}
