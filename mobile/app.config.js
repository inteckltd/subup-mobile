// Expo evaluates this on top of app.json. EAS environment variables are
// available here as process.env during prebuild and EAS builds. Static
// app.json cannot read those variables, and the Meta plugin rejects an
// empty app ID, so the plugin is added only when both values are set.
//
// ios/ and android/ are committed, so EAS Build does not run prebuild on
// its own. mobile/scripts/apply-meta-native-config.js applies this plugin
// to those projects in eas-build-post-install.

const META_PLUGIN = 'react-native-fbsdk-next';
const TRACKING_PLUGIN = 'expo-tracking-transparency';

const TRACKING_USAGE_DESCRIPTION =
  'SubUp uses this to measure ad performance and improve your experience.';

function pluginName(plugin) {
  return Array.isArray(plugin) ? plugin[0] : plugin;
}

function readMetaCredentials() {
  const appID = process.env.EXPO_PUBLIC_META_APP_ID;
  const clientToken = process.env.EXPO_PUBLIC_META_CLIENT_TOKEN;
  if (!appID || !clientToken) return null;
  return {
    appID,
    clientToken,
    displayName: 'SubUp',
    scheme: `fb${appID}`,
    advertiserIDCollectionEnabled: true,
    autoLogAppEventsEnabled: true,
    isAutoInitEnabled: true,
    iosUserTrackingPermission: TRACKING_USAGE_DESCRIPTION,
  };
}

module.exports = ({ config }) => {
  const meta = readMetaCredentials();

  const plugins = (config.plugins ?? []).filter((plugin) => {
    const name = pluginName(plugin);
    return name !== META_PLUGIN && name !== TRACKING_PLUGIN;
  });

  if (meta) {
    plugins.push([META_PLUGIN, meta], TRACKING_PLUGIN);
  }

  return {
    ...config,
    ios: {
      ...config.ios,
      infoPlist: {
        ...config.ios?.infoPlist,
        NSUserTrackingUsageDescription: TRACKING_USAGE_DESCRIPTION,
      },
    },
    plugins,
  };
};

module.exports.readMetaCredentials = readMetaCredentials;
module.exports.TRACKING_USAGE_DESCRIPTION = TRACKING_USAGE_DESCRIPTION;
