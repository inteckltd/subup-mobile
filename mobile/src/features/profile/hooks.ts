import { useQuery } from '@tanstack/react-query';

import { useAuth } from '../../providers/AuthProvider';
import { fetchMyProfileStats, fetchMyRecentGames, fetchMySportBreakdown } from './api';

export function useMyProfileStats() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['profile', 'stats', session?.user.id],
    queryFn: fetchMyProfileStats,
    enabled: !!session,
  });
}

export function useMySportBreakdown() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['profile', 'sports', session?.user.id],
    queryFn: fetchMySportBreakdown,
    enabled: !!session,
  });
}

export function useMyRecentGames() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['profile', 'recent-games', session?.user.id],
    queryFn: fetchMyRecentGames,
    enabled: !!session,
  });
}
