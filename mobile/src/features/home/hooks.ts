import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { useAuth } from '../../providers/AuthProvider';
import { fetchHasPendingInvites, fetchMyGroups, fetchUpcomingGames } from './api';

/**
 * Query keys include the signed-in user's id so cached data can never leak
 * across a sign-out/sign-in as a different user, and both hooks are
 * `enabled: !!session` so no domain request is ever attempted without an
 * authenticated session (Phase 1's auth gate should already prevent this,
 * this is defence in depth for a stray render mid-transition).
 */

export function useMyGroups() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['home', 'my-groups', session?.user.id],
    queryFn: fetchMyGroups,
    enabled: !!session,
  });
}

export function useUpcomingGames() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['home', 'upcoming-games', session?.user.id],
    queryFn: fetchUpcomingGames,
    enabled: !!session,
  });
}

export function useHasPendingInvites(adminGroupIds: string[]) {
  const { session } = useAuth();
  const idsKey = [...adminGroupIds].sort().join(',');
  return useQuery({
    queryKey: ['home', 'pending-invites', session?.user.id, idsKey],
    queryFn: () => fetchHasPendingInvites(adminGroupIds),
    enabled: !!session && adminGroupIds.length > 0,
  });
}

/** Drives Home's pull-to-refresh: re-fetches groups, games, and pending invites. */
export function useHomeRefresh() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!session) return;
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['home', 'my-groups', session.user.id] }),
        queryClient.invalidateQueries({ queryKey: ['home', 'upcoming-games', session.user.id] }),
        queryClient.invalidateQueries({ queryKey: ['home', 'pending-invites', session.user.id] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [queryClient, session]);

  return { refreshing, refresh };
}
