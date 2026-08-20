import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { useAuth } from '../../providers/AuthProvider';
import { acceptGroupInvite, declineGroupInvite, fetchMyNotifications } from './api';

export function useMyNotifications() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['notifications', session?.user.id],
    queryFn: fetchMyNotifications,
    enabled: !!session,
  });
}

export function useInviteActions() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = useCallback(async () => {
    if (!session) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['notifications', session.user.id] }),
      queryClient.invalidateQueries({ queryKey: ['home', 'my-groups', session.user.id] }),
    ]);
  }, [queryClient, session]);

  const accept = useCallback(
    async (inviteId: string) => {
      setError(null);
      setPending(true);
      const result = await acceptGroupInvite(inviteId);
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
