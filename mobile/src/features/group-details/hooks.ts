import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { useAuth } from '../../providers/AuthProvider';
import { fetchGroupDetail, fetchGroupHistory, fetchGroupMembers, fetchGroupPendingInvites, fetchGroupUpcomingGames } from './api';

/**
 * Query keys include both the group id and the signed-in user's id — the
 * latter so cached data can never leak across a sign-out/sign-in as a
 * different user, same reasoning as `features/home/hooks.ts`. All three
 * hooks are `enabled: !!session && !!groupId` as defence in depth.
 */

export function useGroupDetail(groupId: string | undefined) {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['group', groupId, 'detail', session?.user.id],
    queryFn: () => fetchGroupDetail(groupId as string),
    enabled: !!session && !!groupId,
  });
}

export function useGroupMembers(groupId: string | undefined) {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['group', groupId, 'members', session?.user.id],
    queryFn: () => fetchGroupMembers(groupId as string),
    enabled: !!session && !!groupId,
  });
}

export function useGroupUpcomingGames(groupId: string | undefined) {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['group', groupId, 'games', session?.user.id],
    queryFn: () => fetchGroupUpcomingGames(groupId as string),
    enabled: !!session && !!groupId,
  });
}

export function useGroupPendingInvites(groupId: string | undefined) {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['group', groupId, 'invites', session?.user.id],
    queryFn: () => fetchGroupPendingInvites(groupId as string),
    enabled: !!session && !!groupId,
  });
}

export function useGroupHistory(groupId: string | undefined) {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['group', groupId, 'history', session?.user.id],
    queryFn: () => fetchGroupHistory(groupId as string),
    enabled: !!session && !!groupId,
  });
}

/** Drives Group Details' pull-to-refresh: re-fetches all queries in parallel. */
export function useGroupDetailRefresh(groupId: string | undefined) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!session || !groupId) return;
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['group', groupId, 'detail', session.user.id] }),
        queryClient.invalidateQueries({ queryKey: ['group', groupId, 'members', session.user.id] }),
        queryClient.invalidateQueries({ queryKey: ['group', groupId, 'games', session.user.id] }),
        queryClient.invalidateQueries({ queryKey: ['group', groupId, 'invites', session.user.id] }),
        queryClient.invalidateQueries({ queryKey: ['group', groupId, 'history', session.user.id] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [queryClient, session, groupId]);

  return { refreshing, refresh };
}
