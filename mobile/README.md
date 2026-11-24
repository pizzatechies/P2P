# Aurex for iOS and Android

The apps are the Aurex web app inside native iOS and Android shells, built with [Capacitor](https://capacitorjs.com).
- `web/capacitor.config.ts` holds the settings.
- `mobile/android` and `mobile/ios` are the native projects.

## How the apps work

- **The pages are bundled in the app.** They're built from `web/` with `npm run build:app`, which points them at the Aurex server in `AUREX_API_ORIGIN` (default `https://aurex.dpdns.org`).
- **Signing in uses a token, not a cookie.** The apps run at `capacitor://localhost` (iOS) and `https://localhost` (Android).
  - The server recognises those origins (`APP_ORIGINS`) and returns a session token when someone signs in from them.
  - The app keeps the token in the phone's secure storage (the Keychain on iOS, an Android Keystore key) and sends it as `Authorization: Bearer`.
  - Browsers never receive a token.
  - Sessions follow the same expiry, idle timeout and "sign out everywhere" rules as on the web.
- **Phone features:**
  - **Unlock with Face ID, Touch ID or fingerprint** (Settings → Unlock with …): asked when the app opens and when it comes back after a minute away. The phone's passcode works too.
  - **Screen privacy:** screenshots and screen recording are blocked on Android, and the screen is covered in the iOS app switcher.
  - **Camera:** for ID photos, selfies and Smile ID's live selfie.
  - **Files:** statements, exports and documents open in the share sheet (save to Files, open in a PDF viewer). Images open in a viewer.
  - **Links:** links to other sites open in the phone's browser. `aurex://pay/@handle` links open the pay screen, and `aurex://app/...` links (from notifications) open that screen.
  - **Tap to pay (NFC):**
    - Android shares the pay link phone to phone (host card emulation of an NFC tag) and reads and writes NFC stickers. Tapping an Aurex sticker opens the pay screen, even from the home screen.
    - iPhone reads and writes stickers in the app (Core NFC). iPhones can't present a link to another phone.
    - In a build you sign yourself, the "NFC Tag Reading" capability must be on your App ID. The unsigned CI build can't use NFC until it's signed with it.
  - **Tap to Pay for businesses:** Stripe Terminal (`@capacitor-community/stripe-terminal`).
    - Android: version 8.0+ (minSdk 26), NFC, and location permission, which Stripe's SDK requires. The plugin also declares Bluetooth permissions for card readers.
    - iPhone: Apple's Tap to Pay entitlement, `com.apple.developer.proximity-reader.payment.acceptance`. Request it from Apple, add it to `App.entitlements`, and use a provisioning profile that includes it.
  - **Notifications:** through the free ntfy app, with no Firebase and no Apple push key (Settings → Notifications; see "Push notifications" in the main README). On Android, "Subscribe in ntfy" opens the ntfy app with the channel filled in. On iPhone, the customer copies the channel name and server into ntfy. Tapping a notification opens Aurex on the right screen.
  - **Backups:** the app keeps nothing worth restoring, and its session is tied to the phone, so Android backups are switched off.

## Build it yourself

You need Node 22. Android also needs Java 21 and the Android SDK (platform 36). iOS also needs a Mac with Xcode.

```bash
npm ci
npm run cap:sync -w web        # build the pages and copy them into both native projects
```

```bash
cd mobile/android && ./gradlew assembleDebug    # app/build/outputs/apk/debug/app-debug.apk
```

On a Mac, open the iOS project in Xcode and press Run:

```bash
open mobile/ios/App/App.xcodeproj
```

To point a build at a different server (a test server, say), set `AUREX_API_ORIGIN` when building. The server must allow the app origins (`APP_ORIGINS`; the default already does).

## Automatic builds (GitHub Actions)

`.github/workflows/mobile.yml` runs on every push that touches the app:

| Build | Needs | What you get |
|---|---|---|
| Android debug APK | nothing | `aurex-android-debug`: install it on any Android phone (allow "install unknown apps") |
| iOS simulator app | nothing | `aurex-ios-simulator`: runs in Xcode's iPhone simulator on a Mac |
| Unsigned iPhone app (`.ipa`) | nothing | `aurex-ios-unsigned-ipa`: install it on your own iPhone with Sideloadly (or a similar tool), which signs it with your Apple ID |
| Android release bundle (for Google Play) | the signing secrets below | `aurex-android-release` (`.aab`) |

### Android signing (for Google Play)

1. Create an upload key once, and keep the file and passwords somewhere safe. Losing it means asking Google to reset it.

   ```bash
   keytool -genkeypair -v -keystore aurex-upload.jks -alias aurex -keyalg RSA -keysize 4096 -validity 10000
   ```

2. In the GitHub repository, open Settings → Secrets and variables → Actions, and add:
   - `ANDROID_KEYSTORE_BASE64`: the output of `base64 -w0 aurex-upload.jks`;
   - `ANDROID_KEYSTORE_PASSWORD`;
   - `ANDROID_KEY_ALIAS`: `aurex`;
   - `ANDROID_KEY_PASSWORD`.

The next build produces a signed `.aab` to upload in the Google Play Console. Turn on Play App Signing when you upload it. The version code goes up with each CI run.

### iOS (TestFlight and the App Store)

Signed iOS builds need an Apple Developer Program membership (US$99 a year) and a Mac or a CI Mac. Steps:
1. Register the bundle ID in your Apple Developer account. It's `com.pizzatechies.aurex` unless you set `AUREX_APP_ID`; decide before the first release, because it can't change afterwards.
2. In Xcode, set your team under Signing & Capabilities.
3. Choose Product → Archive, then upload to App Store Connect and test with TestFlight.

Automating this in CI needs an App Store Connect API key and signing certificate as secrets. That's the next step once you have the account.

## Before submitting to the stores

- **Who submits:** Apple's guideline 3.2.1(viii) says apps for trading, investing or managing money should be submitted by the financial institution providing the service. Submit under the company's own developer account (or your licensed partner's).
- **Google Play's financial services policy** may ask for licence documents in some countries.
- **Store listings need:** a privacy policy URL (`/privacy`), the data-safety form or privacy "nutrition label" answers, screenshots, and a support contact.
- **Bot protection:** if Cloudflare Turnstile is switched on for sign-up, add `localhost` to the widget's hostnames. That's the app's own address.
