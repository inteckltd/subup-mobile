import 'react-native-get-random-values';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import * as aesjs from 'aes-js';
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';

import { env } from './env';

/**
 * Expo SecureStore (iOS Keychain / Android Keystore) can't hold values
 * larger than ~2048 bytes, and a Supabase session (access + refresh token)
 * regularly exceeds that. This is Supabase's own documented workaround:
 * generate a fresh AES-256 key per write, store the key in SecureStore, and
 * store the (much larger) encrypted session blob in AsyncStorage.
 *
 * See: https://supabase.com/docs/guides/getting-started/tutorials/with-expo-react-native
 */
class LargeSecureStore {
  private async encrypt(key: string, value: string): Promise<string> {
    const encryptionKey = crypto.getRandomValues(new Uint8Array(32));

    const cipher = new aesjs.ModeOfOperation.ctr(encryptionKey, new aesjs.Counter(1));
    const encryptedBytes = cipher.encrypt(aesjs.utils.utf8.toBytes(value));

    await SecureStore.setItemAsync(key, aesjs.utils.hex.fromBytes(encryptionKey));

    return aesjs.utils.hex.fromBytes(encryptedBytes);
  }

  private async decrypt(key: string, value: string): Promise<string | null> {
    const encryptionKeyHex = await SecureStore.getItemAsync(key);
    if (!encryptionKeyHex) {
      return null;
    }

    const cipher = new aesjs.ModeOfOperation.ctr(aesjs.utils.hex.toBytes(encryptionKeyHex), new aesjs.Counter(1));
    const decryptedBytes = cipher.decrypt(aesjs.utils.hex.toBytes(value));

    return aesjs.utils.utf8.fromBytes(decryptedBytes);
  }

  async getItem(key: string): Promise<string | null> {
    const encrypted = await AsyncStorage.getItem(key);
    if (!encrypted) return null;
    return this.decrypt(key, encrypted);
  }

  async removeItem(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
    await SecureStore.deleteItemAsync(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    const encrypted = await this.encrypt(key, value);
    await AsyncStorage.setItem(key, encrypted);
  }
}

/**
 * Retries once (or twice) on PostgREST's `PGRST303` ("JWT issued at
 * future") — a transient clock-skew race between Supabase's auth server
 * (which stamps a token's `iat` at mint time) and whichever PostgREST node
 * ends up validating it a moment later, most visible right after the app
 * resumes from the background and its very first request rides in on a
 * token that was *just* refreshed. It isn't a genuinely stale/bad token
 * (that would be "JWT expired" instead) and self-resolves within ~1s as
 * clocks reconcile, so a short delay + same-request retry is the standard
 * mitigation — see e.g. https://github.com/orgs/supabase/discussions
 * (search "JWT issued at future"). This wraps every Supabase request
 * (PostgREST queries/RPCs, Storage, Auth) in one place via the client's
 * `global.fetch` override, rather than special-casing each call site.
 */
async function fetchWithJwtSkewRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const maxAttempts = 3;
  let response: Response | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    response = await fetch(input, init);
    if (response.ok) return response;

    let code: string | undefined;
    try {
      code = (await response.clone().json())?.code;
    } catch {
      return response; // Not a JSON error body — nothing to retry on.
    }
    if (code !== 'PGRST303' || attempt === maxAttempts) return response;

    await new Promise((resolve) => setTimeout(resolve, attempt * 400));
  }

  return response!;
}

export const supabase = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: new LargeSecureStore(),
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
  global: {
    fetch: fetchWithJwtSkewRetry,
  },
});

/**
 * Supabase's documented React Native pattern (see "Supabase + Expo" quickstart):
 * `autoRefreshToken` only ticks its refresh timer while JS is actively
 * running, so a session sitting untouched while the app is backgrounded (or,
 * in dev, across an Expo Go Fast Refresh reload) won't get refreshed until
 * the app is foregrounded again. Explicitly starting/stopping the refresh
 * loop here means that refresh happens as early as possible on resume,
 * rather than lazily on whatever request happens to notice the token is
 * expired first — shrinking (but not eliminating; see
 * `fetchWithJwtSkewRetry` above) the window where the very next request
 * can race a token that was *just* minted into PGRST303.
 */
AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    supabase.auth.startAutoRefresh();
  } else {
    supabase.auth.stopAutoRefresh();
  }
});
