const { withAndroidManifest, withInfoPlist } = require('expo/config-plugins');

const WHATSAPP_PACKAGES = ['com.whatsapp', 'com.whatsapp.w4b'];
const QUERY_SCHEMES = ['whatsapp', 'whatsapp-business'];

function withShareQueries(config) {
  config = withInfoPlist(config, (mod) => {
    const schemes = new Set(mod.modResults.LSApplicationQueriesSchemes ?? []);
    for (const scheme of QUERY_SCHEMES) schemes.add(scheme);
    mod.modResults.LSApplicationQueriesSchemes = [...schemes];
    return mod;
  });

  config = withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    if (!manifest.queries) manifest.queries = [{}];
    const queries = manifest.queries[0];
    queries.package = queries.package ?? [];
    const existing = new Set(queries.package.map((entry) => entry.$?.['android:name']));
    for (const name of WHATSAPP_PACKAGES) {
      if (!existing.has(name)) {
        queries.package.push({ $: { 'android:name': name } });
      }
    }
    queries.intent = queries.intent ?? [];
    const hasWhatsAppScheme = queries.intent.some((intent) =>
      (intent.data ?? []).some((data) => data.$?.['android:scheme'] === 'whatsapp'),
    );
    if (!hasWhatsAppScheme) {
      queries.intent.push({
        action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
        data: [{ $: { 'android:scheme': 'whatsapp' } }],
      });
    }
    return mod;
  });

  return config;
}

module.exports = withShareQueries;
