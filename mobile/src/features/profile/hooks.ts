import { useQuery } from '@tanstack/react-query';

import { useAuth } from '../../providers/AuthProvider';
import { fetchMyGroupRatings, fetchMyProfileStats, fetchMyRecentGames, fetchMySportBreakdown } from './api';

export function useMyGroupRatings() {
  const { session } = useAuth();
  return useQuery({
    // Under 'home' so Home's focus refetch and pull-to-refresh keep ratings fresh.
    queryKey: ['home', 'group-ratings', session?.user.id],
    queryFn: fetchMyGroupRatings,
    enabled: !!session,
  });
}

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
