import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The iOS and Android apps. Their pages are this web app, built with `npm run build:app` (which
 * points it at AUREX_API_ORIGIN); the native projects live in ../mobile.
 *
 * appId is the app's permanent identity in the App Store and Google Play: it can't change once the
 * app is published, so set AUREX_APP_ID to a reverse domain you control before the first release.
 */
const config: CapacitorConfig = {
  appId: process.env.AUREX_APP_ID ?? "com.pizzatechies.aurex",
  appName: "Aurex",
  webDir: "dist-app",
  android: { path: "../mobile/android", allowMixedContent: false },
  ios: { path: "../mobile/ios", contentInset: "never" },
  server: { androidScheme: "https", iosScheme: "capacitor" },
  plugins: {
    SplashScreen: { launchAutoHide: false, backgroundColor: "#faf8f3", showSpinner: false },
    StatusBar: { overlaysWebView: true },
  },
};

export default config;
