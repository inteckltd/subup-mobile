import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { supabase } from '../../lib/supabase';

const LOG_PREFIX = '[push]';

// Foreground notifications still show a banner/sound while the app is open
// — module-scope, so this only runs once per app load. This is the only
// global push config in the app; nothing else about notification
// presentation is customised.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function resolvePlatform(): 'ios' | 'android' | 'web' {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return 'web';
}

/**
 * Requests notification permission and registers this device's Expo push
 * token against the signed-in user's `push_tokens` row (own-row RLS only —
 * see supabase/migrations/006_create_game_push.sql). Called once per
 * login from `app/(app)/_layout.tsx`.
 *
 * Deliberately best-effort end to end: no EAS project configured, denied
 * permission, no push capability (e.g. iOS Simulator), or a failed upsert
 * are all caught and logged here, never surfaced to the user — push is
 * additive to Create Game, never a dependency for it (see
 * PLAN_CREATE_GAME.md "Push implementation notes").
 */
export async function registerPushToken(userId: string): Promise<void> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let status = existingStatus;
    if (status !== 'granted') {
      const { status: requestedStatus } = await Notifications.requestPermissionsAsync();
      status = requestedStatus;
    }
    if (status !== 'granted') {
      console.log(`${LOG_PREFIX} Notification permission not granted — skipping token registration.`);
      return;
    }

    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    if (!projectId || projectId === 'REPLACE_WITH_EAS_PROJECT_ID') {
      console.log(`${LOG_PREFIX} No EAS projectId configured (see mobile/README.md "Push notifications") — skipping.`);
      return;
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) return;

    const { error } = await supabase
      .from('push_tokens')
      .upsert({ user_id: userId, token, platform: resolvePlatform() }, { onConflict: 'user_id,token' });

    if (error) {
      console.error(`${LOG_PREFIX} Failed to register push token`, error);
    }
  } catch (error) {
    // Covers getExpoPushTokenAsync throwing outright (e.g. no EAS project,
    // no physical push capability) — never lets a push failure affect app startup.
    console.error(`${LOG_PREFIX} registerPushToken failed`, error);
  }
}
