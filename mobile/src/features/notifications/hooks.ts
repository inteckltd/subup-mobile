import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useCallback, useState } from 'react';

import { useAuth } from '../../providers/AuthProvider';
import { beginInviteAcceptance } from '../join-questions/api';
import { acceptGroupInvite, declineGroupInvite, deleteNotification, fetchMyNotifications, markMyNotificationsRead } from './api';
import type { NotificationModel } from './types';

export function notificationsQueryKey(userId: string | undefined) {
  return ['notifications', userId] as const;
}

export function useMyNotifications() {
  const { session } = useAuth();
  return useQuery({
    queryKey: notificationsQueryKey(session?.user.id),
    queryFn: fetchMyNotifications,
    enabled: !!session,
  });
}

export function useUnreadNotificationCount() {
  const query = useMyNotifications();
  return (query.data ?? []).filter((row) => !row.readAt).length;
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  const { session } = useAuth();

  return useCallback(async () => {
    if (!session) return;
    const key = notificationsQueryKey(session.user.id);
    const current = queryClient.getQueryData<NotificationModel[]>(key);
    if (current && !current.some((row) => !row.readAt)) return;

    const now = new Date().toISOString();
    await queryClient.cancelQueries({ queryKey: key });
    queryClient.setQueryData<NotificationModel[]>(key, (old) =>
      (old ?? []).map((row) => (row.readAt ? row : { ...row, readAt: now })),
    );

    try {
      await markMyNotificationsRead();
    } catch {
      await queryClient.invalidateQueries({ queryKey: key });
    }
  }, [queryClient, session]);
}

export function useDeleteNotification() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const remove = useCallback(
    async (id: string) => {
      if (!session) return false;
      const key = notificationsQueryKey(session.user.id);
      const previous = queryClient.getQueryData<NotificationModel[]>(key);
      queryClient.setQueryData<NotificationModel[]>(key, (old) => (old ?? []).filter((row) => row.id !== id));
      setError(null);
      const result = await deleteNotification(id);
      if (result.error) {
        if (previous) queryClient.setQueryData(key, previous);
        setError(result.error);
        return false;
      }
      return true;
    },
    [queryClient, session],
  );

  return { remove, error };
}

export function useInviteActions() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = useCallback(async () => {
    if (!session) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: notificationsQueryKey(session.user.id) }),
      queryClient.invalidateQueries({ queryKey: ['home', 'my-groups', session.user.id] }),
    ]);
  }, [queryClient, session]);

  const accept = useCallback(
    async (inviteId: string) => {
      setError(null);
      setPending(true);
      const start = await beginInviteAcceptance(inviteId, acceptGroupInvite);
      setPending(false);
      if (start.kind === 'error') {
        setError(start.error);
        await invalidate();
        return false;
      }
      if (start.kind === 'questions') {
        // Nothing is saved until the questions screen succeeds; the invite and
        // this notification stay put if the user backs out.
        router.push(`/group/join-questions?inviteId=${inviteId}`);
        return false;
      }
      await invalidate();
      return true;
    },
    [invalidate],
  );

  const decline = useCallback(
    async (inviteId: string) => {
      setError(null);
      setPending(true);
      const result = await declineGroupInvite(inviteId);
      setPending(false);
      if (result.error) {
        setError(result.error);
        return false;
      }
      await invalidate();
      return true;
    },
    [invalidate],
  );

  return { accept, decline, pending, error };
}
