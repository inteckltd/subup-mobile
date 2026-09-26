import { Platform } from 'react-native';
import Constants from 'expo-constants';

import { APP_STORE_ID, APP_STORE_URL, PLAY_STORE_URL } from '../../lib/storeUrls';

export function currentAppVersion(): string {
  return Constants.expoConfig?.version ?? Constants.nativeAppVersion ?? '1.0.0';
}

export function storeListingUrl(): string {
  return Platform.OS === 'ios' ? APP_STORE_URL : PLAY_STORE_URL;
}

/** 1 if a > b, -1 if a < b, 0 if equal. Non-numeric parts compare as 0. */
export function compareAppVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff > 0) return 1;
    if (diff < 0) return -1;
  }
  return 0;
}

type ItunesLookup = {
  resultCount?: number;
  results?: { version?: string }[];
};

/**
 * Latest store marketing version. Uses the App Store lookup for both
 * platforms — SubUp ships the same version number on iOS and Android.
 * Soft-only: failures return null so the badge stays hidden.
 */
export async function fetchLatestStoreVersion(): Promise<string | null> {
  try {
    const response = await fetch(`https://itunes.apple.com/lookup?id=${APP_STORE_ID}&country=gb`);
    if (!response.ok) return null;
    const body = (await response.json()) as ItunesLookup;
    const version = body.results?.[0]?.version?.trim();
    return version || null;
  } catch {
    return null;
  }
}

export function isStoreUpdateAvailable(installed: string, latest: string | null): boolean {
  if (!latest) return false;
  return compareAppVersions(latest, installed) > 0;
}
