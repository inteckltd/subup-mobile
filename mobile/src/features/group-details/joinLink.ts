import * as SecureStore from 'expo-secure-store';

import { env } from '../../lib/env';

const PENDING_JOIN_TOKEN_KEY = 'pending_join_token';

export function isJoinToken(token: string): boolean {
  return /^[0-9a-f]{32,64}$/i.test(token.trim());
}

export function groupJoinUrl(token: string): string {
  const base = env.EXPO_PUBLIC_INVITE_APP_URL.replace(/\/$/, '');
  return `${base}/join/${token.trim()}`;
}

export async function stashPendingJoinToken(token: string): Promise<void> {
  if (!isJoinToken(token)) return;
  await SecureStore.setItemAsync(PENDING_JOIN_TOKEN_KEY, token.trim());
}

export async function peekPendingJoinToken(): Promise<string | null> {
  const token = await SecureStore.getItemAsync(PENDING_JOIN_TOKEN_KEY);
  if (!token || !isJoinToken(token)) return null;
  return token;
}

export async function clearPendingJoinToken(): Promise<void> {
  await SecureStore.deleteItemAsync(PENDING_JOIN_TOKEN_KEY);
}
