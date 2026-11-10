/**
 * Writes the Meta SDK and ATT config plugins into the committed native projects.
 *
 * EAS Build skips prebuild when ios/ and android/ are already in the repo, and a
 * full prebuild also rewrites the iOS product name (PitchIn) and splash assets.
 * This script evaluates only the Meta and tracking-transparency plugins, which
 * update Info.plist, AndroidManifest.xml, and strings.xml.
 *
 * App ID and client token come from EXPO_PUBLIC_META_APP_ID and
 * EXPO_PUBLIC_META_CLIENT_TOKEN. They are not stored in git.
 */
const path = require('path');

const { compileModsAsync } = require('@expo/config-plugins');
const { readMetaCredentials, TRACKING_USAGE_DESCRIPTION } = require('../app.config.js');

const projectRoot = path.join(__dirname, '..');

function resolvePlugin(mod) {
  if (typeof mod === 'function') return mod;
  if (mod && typeof mod.default === 'function') return mod.default;
  throw new Error('Expected a config plugin function export.');
}

async function main() {
  const meta = readMetaCredentials();

  if (!meta) {
    const message = [
      '[Meta] EXPO_PUBLIC_META_APP_ID and EXPO_PUBLIC_META_CLIENT_TOKEN are required.',
      'The Facebook SDK crashes on Android launch without an Application ID.',
      'Set both in the Expo environment used by this EAS build profile.',
    ].join(' ');
    if (process.env.EAS_BUILD === 'true') {
      console.error(message);
      process.exit(1);
    }
    console.log(`${message} Skipping native config outside EAS.`);
    return;
  }

  const withFacebook = resolvePlugin(require('react-native-fbsdk-next/app.plugin.js'));
  const withTrackingTransparency = resolvePlugin(require('expo-tracking-transparency/app.plugin.js'));

  let config = {
    name: 'SubUp',
    slug: 'pitchin',
    ios: { bundleIdentifier: 'com.inteck.subup' },
    android: { package: 'com.inteck.subup' },
  };

  config = withFacebook(config, meta);

  config = withTrackingTransparency(config, {
    userTrackingPermission: TRACKING_USAGE_DESCRIPTION,
  });

  await compileModsAsync(config, {
    projectRoot,
    platforms: ['ios', 'android'],
    assertMissingModProviders: false,
  });

  console.log(`[Meta] Applied iOS and Android config for app ${meta.appID} (scheme ${meta.scheme}).`);
}

main().catch((error) => {
  console.error('[Meta] Failed to apply native config.');
  console.error(error);
  process.exit(1);
});
