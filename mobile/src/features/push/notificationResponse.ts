import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';

type NotificationTapData = {
  gameId?: string;
  type?: string;
};

/**
 * Subscribes to notification taps (app opened/foregrounded from a tap, or
 * a tap while already open) and navigates from the payload:
 *   - `type === 'group_invite'` → Notifications (Accept / Decline)
 *   - otherwise a `gameId` → Game Details
 * Matches the `data` shapes `create_game` / `notify-game-created` and
 * `invite_group_member` / `notify-group-invite` use. Returns an
 * unsubscribe function; called once from `app/(app)/_layout.tsx`.
 */
export function subscribeToNotificationTaps(): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as NotificationTapData | undefined;
    if (data?.type === 'group_invite') {
      router.push('/notifications');
      return;
    }
    if ((data?.type === 'motm_vote' || data?.type === 'motm_result') && data.gameId) {
      router.push(`/games/motm?gameId=${data.gameId}`);
      return;
    }
    if (data?.gameId) {
      router.push(`/games/${data.gameId}`);
    }
  });

  return () => subscription.remove();
}
