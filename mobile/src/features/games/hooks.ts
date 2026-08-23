import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { useAuth } from '../../providers/AuthProvider';
import {
  createGame as createGameRequest,
  updateGame as updateGameRequest,
  cancelGame as cancelGameRequest,
  fetchCreatableGroups,
  fetchGameDetail,
  fetchGamePlayers,
  joinGame as joinGameRequest,
  leaveGame as leaveGameRequest,
  submitGameScore as submitGameScoreRequest,
  fetchMotmBallot,
  voteMotm as voteMotmRequest,
  moveGamePlayerTeam as moveGamePlayerTeamRequest,
} from './api';
import { payToJoinGame } from '../payments/api';
import type { CreateGameFormValues } from './schemas';
import type { GamePlayerModel } from './types';

/**
 * Query keys include the signed-in user's id (same reasoning as
 * `features/home/hooks.ts`/`features/group-details/hooks.ts`) so cached
 * data can never leak across a sign-out/sign-in as a different user. All
 * hooks are `enabled: !!session` (and `!!gameId` where relevant) as
 * defence in depth.
 */

export function useCreatableGroups() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['games', 'creatable-groups', session?.user.id],
    queryFn: () => fetchCreatableGroups(session!.user.id),
    enabled: !!session,
  });
}

export function useGameDetail(gameId: string | undefined) {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['game', gameId, 'detail', session?.user.id],
    queryFn: () => fetchGameDetail(gameId as string),
    enabled: !!session && !!gameId,
  });
}

export function useGamePlayers(gameId: string | undefined) {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['game', gameId, 'players', session?.user.id],
    queryFn: () => fetchGamePlayers(gameId as string),
    enabled: !!session && !!gameId,
  });
}

/** Drives Game Details' pull-to-refresh: re-fetches detail + players in parallel. */
export function useGameDetailRefresh(gameId: string | undefined) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!session || !gameId) return;
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['game', gameId, 'detail', session.user.id] }),
        queryClient.invalidateQueries({ queryKey: ['game', gameId, 'players', session.user.id] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [queryClient, session, gameId]);

  return { refreshing, refresh };
}

/**
 * Drives Create Game's submit — manual async + `useState`, no
 * `useMutation`, matching this codebase's existing convention (see
 * `app/(app)/create-group.tsx`). Invalidates Home/group lists so the new
 * game shows up without a pull-to-refresh.
 */
export function useCreateGame() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async (values: CreateGameFormValues): Promise<string | null> => {
    setError(null);
    setSubmitting(true);
    const result = await createGameRequest(values);
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return null;
    }
    if (session) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['home'] }),
        queryClient.invalidateQueries({ queryKey: ['games'] }),
        queryClient.invalidateQueries({ queryKey: ['group', values.groupId] }),
      ]);
    }
    return result.id ?? null;
  }, [queryClient, session]);

  return { submit, submitting, error };
}

export function useUpdateGame() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async (gameId: string, values: CreateGameFormValues): Promise<boolean> => {
    setError(null);
    setSubmitting(true);
    const result = await updateGameRequest(gameId, values);
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return false;
    }
    if (session) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['home'] }),
        queryClient.invalidateQueries({ queryKey: ['games'] }),
        queryClient.invalidateQueries({ queryKey: ['group', values.groupId] }),
        queryClient.invalidateQueries({ queryKey: ['game', gameId] }),
      ]);
    }
    return true;
  }, [queryClient, session]);

  return { submit, submitting, error };
}

export function useCancelGame(gameId: string | undefined) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = useCallback(async (): Promise<boolean> => {
    if (!gameId) return false;
    setError(null);
    setPending(true);
    const result = await cancelGameRequest(gameId);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return false;
    }
    if (session) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['game', gameId, 'detail', session.user.id] }),
        queryClient.invalidateQueries({ queryKey: ['game', gameId, 'players', session.user.id] }),
        queryClient.invalidateQueries({ queryKey: ['home'] }),
        queryClient.invalidateQueries({ queryKey: ['games'] }),
      ]);
    }
    return true;
  }, [gameId, queryClient, session]);

  return { cancel, pending, error };
}

/** Drives Game Details' Join/Leave CTA — refetches detail + players on success. */
export function useJoinLeaveGame(gameId: string | undefined) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetchGame = useCallback(async () => {
    if (!session || !gameId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['game', gameId, 'detail', session.user.id] }),
      queryClient.invalidateQueries({ queryKey: ['game', gameId, 'players', session.user.id] }),
    ]);
  }, [queryClient, session, gameId]);

  const join = useCallback(async () => {
    if (!gameId) return;
    setError(null);
    setPending(true);
    const result = await joinGameRequest(gameId);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    await refetchGame();
  }, [gameId, refetchGame]);

  const payAndJoin = useCallback(async () => {
    if (!gameId) return;
    setError(null);
    setPending(true);
    const result = await payToJoinGame(gameId);
    setPending(false);
    if (result.error) {
      if (result.error !== 'Payment cancelled') setError(result.error);
      await refetchGame();
      return;
    }
    await refetchGame();
  }, [gameId, refetchGame]);

  const leave = useCallback(async (paid = false) => {
    if (!gameId) return;
    setError(null);
    setPending(true);
    const result = await leaveGameRequest(gameId, { paid });
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    await refetchGame();
  }, [gameId, refetchGame]);

  return { join, payAndJoin, leave, pending, error };
}

/** Admin moves a confirmed player between home and away after teams are picked. */
export function useMoveGamePlayerTeam(gameId: string | undefined) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const move = useCallback(
    async (userId: string, team: 'home' | 'away'): Promise<boolean> => {
      if (!gameId || !session || !userId) return false;
      const key = ['game', gameId, 'players', session.user.id] as const;
      const previous = queryClient.getQueryData<GamePlayerModel[]>(key);
      queryClient.setQueryData<GamePlayerModel[]>(key, (current) =>
        (current ?? []).map((player) => (player.userId && player.userId === userId ? { ...player, team } : player)),
      );
      setError(null);
      setPending(true);
      const result = await moveGamePlayerTeamRequest(gameId, userId, team);
      setPending(false);
      if (result.error) {
        if (previous) queryClient.setQueryData(key, previous);
        setError(result.error);
        return false;
      }
      await queryClient.invalidateQueries({ queryKey: key });
      return true;
    },
    [gameId, queryClient, session],
  );

  return { move, pending, error };
}

/** Drives the Enter Score screen's submit — same manual async + `useState` shape as `useCreateGame`, refetching detail + players on success (players aren't affected, but detail's status/score fields are). */
export function useSubmitGameScore(gameId: string | undefined) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (scoreHome: number, scoreAway: number, scoreNotes: string | null): Promise<boolean> => {
      if (!gameId) return false;
      setError(null);
      setSubmitting(true);
      const result = await submitGameScoreRequest(gameId, scoreHome, scoreAway, scoreNotes);
      setSubmitting(false);
      if (result.error) {
        setError(result.error);
        return false;
      }
      if (session) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['game', gameId, 'detail', session.user.id] }),
          queryClient.invalidateQueries({ queryKey: ['game', gameId, 'players', session.user.id] }),
        ]);
      }
      return true;
    },
    [gameId, queryClient, session],
  );

  return { submit, submitting, error };
}

export function useMotmBallot(gameId: string | undefined) {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['game', gameId, 'motm', session?.user.id],
    queryFn: () => fetchMotmBallot(gameId as string),
    enabled: !!session && !!gameId,
  });
}

export function useVoteMotm(gameId: string | undefined) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vote = useCallback(
    async (votedForId: string): Promise<boolean> => {
      if (!gameId) return false;
      setError(null);
      setPending(true);
      const result = await voteMotmRequest(gameId, votedForId);
      setPending(false);
      if (result.error) {
        setError(result.error);
        return false;
      }
      if (session) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['game', gameId, 'motm', session.user.id] }),
          queryClient.invalidateQueries({ queryKey: ['game', gameId, 'detail', session.user.id] }),
        ]);
      }
      return true;
    },
    [gameId, queryClient, session],
  );

  return { vote, pending, error };
}
