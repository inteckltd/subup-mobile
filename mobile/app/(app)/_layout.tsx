import { Stack } from 'expo-router';
import { useEffect } from 'react';

import { subscribeToNotificationTaps } from '../../src/features/push/notificationResponse';
import { registerPushToken } from '../../src/features/push/registerPushToken';
import { useAuth } from '../../src/providers/AuthProvider';

export default function AppLayout() {
  const { session } = useAuth();

  // Best-effort, once per login — see registerPushToken's doc comment for
  // why this never blocks or fails anything else in the app.
  useEffect(() => {
    if (!session) return;
    registerPushToken(session.user.id);
  }, [session]);

  useEffect(() => {
    const unsubscribe = subscribeToNotificationTaps();
    return unsubscribe;
  }, []);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="onboarding" options={{ presentation: 'fullScreenModal' }} />
      <Stack.Screen name="create-group" options={{ presentation: 'modal' }} />
      <Stack.Screen name="groups/index" />
      <Stack.Screen name="group/[id]" />
      <Stack.Screen name="group/invite" />
      <Stack.Screen name="group/edit" />
      <Stack.Screen name="games/index" />
      <Stack.Screen name="games/create" options={{ presentation: 'modal' }} />
      <Stack.Screen name="games/[id]" />
      <Stack.Screen name="games/enter-score" />
      <Stack.Screen name="games/motm" />
      <Stack.Screen name="profile/index" />
      <Stack.Screen name="profile/edit" />
      <Stack.Screen name="profile/settings" />
      <Stack.Screen name="notifications" />
    </Stack>
  );
}
