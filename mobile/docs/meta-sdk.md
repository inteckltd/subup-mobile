# Meta (Facebook) SDK Integration

This document outlines the Meta SDK integration for app event tracking and install attribution.

## Overview

The SubUp mobile app uses the Meta SDK to track:
- App installs and activations (automatic)
- Group creation
- Player joining games (free and paid)
- Payment completion (purchases)

This enables Meta Ads to measure campaign performance and optimize ad delivery.

## Required Environment Variables

Add these environment variables to your `.env` file and EAS build secrets:

```bash
EXPO_PUBLIC_META_APP_ID=your_meta_app_id_here
EXPO_PUBLIC_META_CLIENT_TOKEN=your_meta_client_token_here
```

**IMPORTANT:** Never commit real Meta credentials to the repository. The app will function without these variables but tracking will be disabled.

## Configuration Files

### app.config.js
`app.json` cannot read environment variables. `app.config.js` adds the `react-native-fbsdk-next` plugin when `EXPO_PUBLIC_META_APP_ID` and `EXPO_PUBLIC_META_CLIENT_TOKEN` are set (they are Expo environment variables, including on EAS):

- `appID` and `clientToken` come from those variables. Do not commit them.
- The iOS/Android URL scheme is `fb` plus the app ID (for example `fb1687468766300717`).
- Automatic app event logging, SDK auto-init, and advertiser ID collection are enabled.
- iOS user tracking permission message: "SubUp uses this to measure ad performance and improve your experience."

`ios/` and `android/` are committed, so EAS Build does not run prebuild by itself. `eas-build-post-install` runs `scripts/apply-meta-native-config.js`, which applies this plugin to the native projects after install. That writes the App ID, client token, ATT usage string, Facebook URL scheme, and advertiser-tracking flags into Info.plist and the Android manifest. A production build fails if either variable is missing, because the Facebook SDK crashes on Android without an Application ID.

### iOS Privacy Manifest
The `ios/PitchIn/PrivacyInfo.xcprivacy` file has been updated to:
- Include `NSPrivacyAccessedAPICategoryUserIDFA` with reason code `3B52.1` (app advertising)
- Set `NSPrivacyTracking` to `true` (indicates the app tracks users)

### App Tracking Transparency
The app requests tracking permission on iOS using `expo-tracking-transparency`:
- Permission is requested at app startup
- User receives the message: "SubUp uses this to measure ad performance and improve your experience."
- If denied, advertiser tracking is disabled but app functionality is unaffected

## Events Tracked

### Automatic Events
- `fb_mobile_activate_app` - App launched/activated
- Install attribution (via Meta App Events)

### Custom Events
- `GroupCreated` - Triggered when a user creates a new group
  - Parameters: `group_id`
  
- `PlayerJoinedGame` - Triggered when a player joins a game
  - Parameters: `game_id`, `paid` (optional, "true" for paid games)

### Standard Events
- `fb_mobile_purchase` - Triggered after successful payment
  - Parameters: `currency`, `content_type`
  - Value: Payment amount in GBP

## Implementation Details

### Initialization
The SDK is initialized in `app/_layout.tsx` at app startup:
1. Checks for Meta credentials
2. Requests iOS tracking permission if on iOS
3. Enables advertiser tracking based on permission
4. Enables automatic event logging

### Event Logging
Events are logged via `src/lib/metaTracking.ts` which provides:
- `logMetaEvent(name, params)` - Custom events
- `logMetaStandardEvent(name, value, params)` - Standard events with monetary value
- Safe error handling (logs errors but doesn't crash the app)

## Manual Setup Steps

After deploying these changes, complete these steps in Meta Events Manager:

1. **Create or Configure App**
   - Go to [Meta for Developers](https://developers.facebook.com/)
   - Create a new app or select your existing SubUp app
   - Note the App ID and Client Token

2. **Configure App Events**
   - Navigate to Events Manager
   - Set up your app for iOS and Android
   - Add key hashes for Android release builds

3. **Android Key Hash**
   Generate and add your Android release key hash:
   ```bash
   keytool -exportcert -alias YOUR_RELEASE_KEY_ALIAS -keystore YOUR_RELEASE_KEY_PATH | openssl sha1 -binary | openssl base64
   ```

4. **iOS Configuration**
   - Add your iOS Bundle ID: `com.inteck.subup`
   - No additional keys required for iOS

5. **Test Events**
   - Build and deploy a test version
   - Trigger events (create group, join game, make payment)
   - Verify events appear in Events Manager (may take a few minutes)

6. **Store Release**
   - Add environment variables to EAS Build secrets
   - Submit new builds to App Store and Google Play
   - Events will only be tracked in production builds with valid credentials

## Verification

To verify the integration is working:

1. Check console logs for Meta SDK initialization messages
2. Trigger events in the app
3. View real-time events in Meta Events Manager (Test Events mode)
4. Verify install attribution works by clicking a Meta ad and installing

## Troubleshooting

**Events not appearing:**
- Check that environment variables are set correctly
- Verify the app is built with the Meta SDK (check console logs)
- Ensure iOS tracking permission was granted
- Wait up to 30 minutes for events to appear in Events Manager

**iOS tracking permission not requested:**
- Check Info.plist for NSUserTrackingUsageDescription
- Verify expo-tracking-transparency is installed
- Test on a physical device (simulator may behave differently)

**Android events missing:**
- Verify key hash is correct in Meta app settings
- Check that the package name matches: `com.inteck.subup`
- Enable Google advertising ID in Google Play Console

## References

- [React Native FBSDK Next Documentation](https://github.com/thebergamo/react-native-fbsdk-next)
- [Meta App Events Documentation](https://developers.facebook.com/docs/app-events)
- [Expo Tracking Transparency](https://docs.expo.dev/versions/latest/sdk/tracking-transparency/)
