import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  formatCountdown,
  formatGbp,
  formatLobbyDateTime,
  formatLockDeadline,
  hasGameEnded,
  isInsideLockWindow,
} from '../../../src/lib/format';
import { PrimaryButton } from '../../../src/features/auth/components/PrimaryButton';
import { EmptyState } from '../../../src/features/home/components/EmptyState';
import { ErrorState } from '../../../src/features/home/components/ErrorState';
import { PlayerLobbyRow } from '../../../src/features/games/components/PlayerLobbyRow';
import { TeamBoard, TeamDragOverlay, useTeamDrag } from '../../../src/features/games/components/TeamBoard';
import { useCancelGame, useGameDetail, useGameDetailRefresh, useGamePlayers, useJoinLeaveGame, useMoveGamePlayerTeam } from '../../../src/features/games/hooks';
import { teamColorById } from '../../../src/features/games/schemas';
import type { GamePlayerModel } from '../../../src/features/games/types';
import { colors } from '../../../src/theme/tokens';

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => new Date());
  useFocusEffect(
    useCallback(() => {
      setNow(new Date());
      const id = setInterval(() => setNow(new Date()), intervalMs);
      return () => clearInterval(id);
    }, [intervalMs]),
  );
  return now;
}

function PlayerList({ players }: { players: GamePlayerModel[] }) {
  return (
    <View
      className="w-full overflow-hidden rounded-3xl border border-[#F9FAFB] bg-white"
      style={{ shadowColor: '#000000', shadowOpacity: 0.02, shadowRadius: 24, shadowOffset: { width: 0, height: 4 } }}
    >
      {players.map((player, index) => (
        <PlayerLobbyRow key={player.id} player={player} showDivider={index > 0} />
      ))}
    </View>
  );
}

function confirmLeaveGame(input: { isWaitlisted: boolean; paid: boolean; onLeave: () => void }) {
  const title = input.isWaitlisted ? 'Leave the waitlist?' : 'Leave this game?';
  let message: string | undefined;
  if (!input.isWaitlisted) {
    message = input.paid
      ? 'Are you sure you want to leave? A refund will be processed for the pitch cost and PitchIn fee.'
      : 'Are you sure you want to leave this game?';
  }
  Alert.alert(title, message, [
    { text: 'Stay', style: 'cancel' },
    { text: 'Leave', style: 'destructive', onPress: input.onLeave },
  ]);
}

export default function GameDetailsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const now = useNow();

  const gameQuery = useGameDetail(id);
  const playersQuery = useGamePlayers(id);
  const { refreshing, refresh } = useGameDetailRefresh(id);
  const { join, payAndJoin, leave, pending, error: actionError } = useJoinLeaveGame(id);
  const { cancel, pending: cancelling, error: cancelError } = useCancelGame(id);
  const { move, error: moveError } = useMoveGamePlayerTeam(id);

  const canDrag =
    !!gameQuery.data?.isAdmin &&
    !!gameQuery.data.teamsPickedAt &&
    gameQuery.data.status !== 'cancelled' &&
    gameQuery.data.status !== 'completed';
  const handleMove = useCallback(
    (userId: string, team: 'home' | 'away') => {
      void move(userId, team);
    },
    [move],
  );
  const drag = useTeamDrag(canDrag, handleMove);

  if (gameQuery.isPending) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (gameQuery.isError || !gameQuery.data) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background px-8" edges={['top', 'bottom']}>
        <ErrorState message="Couldn't load this game. Pull to refresh or try again." onRetry={() => gameQuery.refetch()} />
        <PrimaryButton label="Back" className="mt-6 w-auto px-8" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  const game = gameQuery.data;
  const players = playersQuery.data ?? [];
  const lockHours = game.cancelIfMinNotMetHours ?? 24;
  const percentFull = game.maxPlayers > 0 ? Math.min(game.spotsTaken / game.maxPlayers, 1) : 0;
  const insideLock = isInsideLockWindow(game.startsAt, lockHours, now);
  const minMet = (game.spotsPaid ?? 0) >= game.minPlayers;
  const teamsPicked = !!game.teamsPickedAt;
  const confirmed = (insideLock && minMet) || teamsPicked;
  const isCancelled = game.status === 'cancelled';
  const belowMin = game.spotsTaken < game.minPlayers && lockHours > 0 && !teamsPicked && !isCancelled;
  const needed = Math.max(game.minPlayers - game.spotsTaken, 0);
  const homeColor = teamColorById(game.homeColor);
  const awayColor = teamColorById(game.awayColor);
  const confirmedPlayers = players.filter((player) => !player.isWaitlisted);
  const waitlistedPlayers = players.filter((player) => player.isWaitlisted);
  const homePlayers = confirmedPlayers.filter((player) => player.team === 'home');
  const awayPlayers = confirmedPlayers.filter((player) => player.team === 'away');
  const unassignedPlayers = confirmedPlayers.filter((player) => !player.team);

  const canJoinOpen = !game.hasJoined && game.status === 'open' && game.spotsTaken < game.maxPlayers && !confirmed;
  const canJoinWaitlist =
    !game.hasJoined &&
    (game.status === 'full' || game.spotsTaken >= game.maxPlayers) &&
    game.allowWaitlist &&
    game.status !== 'cancelled' &&
    game.status !== 'completed' &&
    !confirmed;
  const isFullNoWaitlist =
    !game.hasJoined && (game.status === 'full' || game.spotsTaken >= game.maxPlayers) && !game.allowWaitlist && !confirmed;
  const leaveLocked = insideLock && game.hasJoined && !game.isWaitlisted;
  const isCompleted = game.status === 'completed';
  const isFinished = game.status === 'cancelled' || isCompleted;
  const hasEnded = !isFinished && hasGameEnded(game.startsAt, game.durationMinutes);
  const motmOpen =
    isCompleted &&
    !game.isWaitlisted &&
    game.hasJoined &&
    !game.motmClosedAt &&
    !!game.scoredAt &&
    new Date(game.scoredAt).getTime() + 24 * 60 * 60 * 1000 > now.getTime();

  return (
    <View className="flex-1 bg-background">
      <SafeAreaView edges={['top']} className="bg-white">
        <View className="w-full flex-row items-center justify-between border-b border-border px-4 py-4">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            className="h-10 w-10 items-center justify-center rounded-full bg-background"
          >
            <Ionicons name="chevron-back" size={18} color={colors.ink} />
          </Pressable>
          <Text className="font-sans-bold text-lg text-ink">Game Lobby</Text>
          {gameQuery.data?.isAdmin && gameQuery.data.status !== 'cancelled' && gameQuery.data.status !== 'completed' ? (
            <Pressable
              onPress={() => {
                const current = gameQuery.data;
                if (!current) return;
                const kickoffPassed = new Date(current.startsAt).getTime() <= Date.now();
                const insideLockNow = isInsideLockWindow(current.startsAt, current.cancelIfMinNotMetHours ?? 24);
                const options: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [
                  { text: 'Close', style: 'cancel' },
                ];
                if (!insideLockNow && !kickoffPassed && current.scoreHome == null) {
                  options.unshift({
                    text: 'Edit game',
                    onPress: () => router.push(`/games/create?editId=${current.id}`),
                  });
                }
                if (!kickoffPassed && current.scoreHome == null) {
                  options.unshift({
                    text: 'Cancel game',
                    style: 'destructive',
                    onPress: () => {
                      Alert.alert(
                        'Cancel this game?',
                        'Everyone who joined will be notified. Paid players are refunded. You can’t undo this.',
                        [
                          { text: 'Keep game', style: 'cancel' },
                          {
                            text: 'Cancel game',
                            style: 'destructive',
                            onPress: () => {
                              if (!cancelling) void cancel();
                            },
                          },
                        ],
                      );
                    },
                  });
                }
                Alert.alert('Manage game', undefined, options);
              }}
              hitSlop={8}
              className="h-10 w-10 items-center justify-center rounded-full bg-background"
            >
              <Ionicons name="ellipsis-horizontal" size={18} color={colors.ink} />
            </Pressable>
          ) : (
            <View className="h-10 w-10" />
          )}
        </View>
      </SafeAreaView>

      <ScrollView
        scrollEnabled={drag.scrollEnabled}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 16, paddingBottom: 160, gap: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
      >
        <View
          className="w-full gap-6 rounded-3xl bg-white p-6"
          style={{ shadowColor: '#000000', shadowOpacity: 0.04, shadowRadius: 15, shadowOffset: { width: 0, height: 8 } }}
        >
          <View className="flex-row items-center gap-3">
            <View className={`h-14 w-14 items-center justify-center rounded-2xl ${confirmed ? 'bg-primary/20' : 'bg-accent/20'}`}>
              <Ionicons name="football-outline" size={24} color={confirmed ? colors.primary : colors.ink} />
            </View>
            <View className="flex-1">
              <Text className="font-sans-bold text-xl text-ink" numberOfLines={2}>
                {game.title || game.groupName}
              </Text>
              <Text className="font-sans text-sm text-muted" numberOfLines={1}>
                {game.groupName}
              </Text>
              <Text className="font-sans text-sm text-muted">{formatLobbyDateTime(game.startsAt)}</Text>
            </View>
          </View>

          {isCancelled ? (
            <View className="flex-row items-center justify-between rounded-2xl bg-[#FEF2F2] p-4">
              <View>
                <Text className="font-sans-bold text-[10px] uppercase tracking-wider text-[#B91C1C]/70">Status</Text>
                <Text className="font-sans-bold text-lg text-[#B91C1C]">Cancelled</Text>
              </View>
              <View className="h-8 w-px bg-[#FECACA]" />
              <View className="items-end">
                <Text className="font-sans-bold text-[10px] uppercase tracking-wider text-[#B91C1C]/70">Players</Text>
                <Text className="font-sans-bold text-lg text-[#B91C1C]">
                  {game.spotsTaken}/{game.minPlayers} min
                </Text>
              </View>
            </View>
          ) : confirmed && !isFinished && !hasEnded ? (
            <View className="flex-row items-center justify-between rounded-2xl bg-primary p-4">
              <View>
                <Text className="font-sans-bold text-[10px] uppercase tracking-wider text-white/60">Status</Text>
                <Text className="font-sans-bold text-lg text-white">Game Confirmed</Text>
              </View>
              <View className="h-8 w-px bg-white/20" />
              <View className="items-end">
                <Text className="font-sans-bold text-[10px] uppercase tracking-wider text-white/60">Players</Text>
                <Text className="font-sans-bold text-lg text-white">
                  {game.spotsTaken}/{game.maxPlayers}
                  {game.spotsTaken >= game.maxPlayers ? ' Full' : ''}
                </Text>
              </View>
            </View>
          ) : (
            <View className="flex-row items-center justify-between rounded-2xl bg-ink p-4">
              <View>
                <Text className="font-sans-bold text-[10px] uppercase tracking-wider text-white/60">Starts in</Text>
                <Text className="font-sans-bold text-lg text-white">{formatCountdown(game.startsAt, now)}</Text>
              </View>
              <View className="h-8 w-px bg-white/20" />
              <View className="items-end">
                <Text className="font-sans-bold text-[10px] uppercase tracking-wider text-white/60">
                  {game.priceCents > 0 ? 'You pay' : 'Price'}
                </Text>
                <Text className="font-sans-bold text-lg text-white">{formatGbp(game.totalCents ?? game.priceCents)}</Text>
              </View>
            </View>
          )}

          {game.priceCents > 0 ? (
            <Text className="font-sans text-xs text-muted">
              {formatGbp(game.priceCents)} pitch + {formatGbp(game.feeCents ?? 0)} PitchIn fee
            </Text>
          ) : null}

          {game.venueName ? (
            <View className="flex-row items-start gap-3">
              <Ionicons name="location-outline" size={16} color={colors.primary} style={{ marginTop: 2 }} />
              <View className="flex-1">
                <Text className="font-sans-bold text-sm text-ink">{game.venueName}</Text>
                {game.venueAddress ? <Text className="font-sans text-xs text-muted">{game.venueAddress}</Text> : null}
              </View>
            </View>
          ) : null}

          <View className="flex-row items-start gap-3">
            <Ionicons name="person-outline" size={16} color={colors.primary} style={{ marginTop: 2 }} />
            <View className="flex-1">
              <Text className="font-sans-bold text-sm text-ink">
                Organized by {game.organizerName ?? 'a group admin'}
              </Text>
              <Text className="font-sans text-xs text-muted">Group admin</Text>
            </View>
          </View>

          <View className="flex-row items-center gap-4">
            <View className="flex-row items-center gap-1.5">
              <View
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: homeColor.hex, borderWidth: homeColor.id === 'white' ? 1 : 0, borderColor: '#E5E7EB' }}
              />
              <Text className="font-sans-bold text-xs text-ink">{homeColor.label}</Text>
            </View>
            <Text className="font-sans text-xs text-muted">vs</Text>
            <View className="flex-row items-center gap-1.5">
              <View
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: awayColor.hex, borderWidth: awayColor.id === 'white' ? 1 : 0, borderColor: '#E5E7EB' }}
              />
              <Text className="font-sans-bold text-xs text-ink">{awayColor.label}</Text>
            </View>
          </View>

          {!confirmed ? (
            <View className="gap-2">
              <View className="flex-row items-center justify-between">
                <Text className="font-sans-bold text-sm text-ink">Spots Filled</Text>
                <Text className="font-sans-bold text-sm text-primary">
                  {game.spotsTaken}/{game.maxPlayers}
                </Text>
              </View>
              <View className="h-2 w-full overflow-hidden rounded-full bg-border">
                <View className="h-full rounded-full bg-accent" style={{ width: `${percentFull * 100}%` }} />
              </View>
              <View className="flex-row items-center gap-1.5">
                <Ionicons name="information-circle-outline" size={12} color={colors.muted} />
                <Text className="font-sans text-[11px] text-muted">
                  Min {game.minPlayers} players required for game to go ahead.
                </Text>
              </View>
            </View>
          ) : null}
        </View>

        {isCompleted ? (
          <View className="w-full gap-3 rounded-3xl bg-white p-6">
            <Text className="font-sans-bold text-xs uppercase tracking-wider text-muted">Final score</Text>
            <View className="flex-row items-center justify-center gap-4 py-2">
              <View className="flex-1 items-center gap-1.5">
                <View
                  className="h-4 w-4 rounded-full"
                  style={{ backgroundColor: homeColor.hex, borderWidth: homeColor.id === 'white' ? 1 : 0, borderColor: '#E5E7EB' }}
                />
                <Text className="font-sans-bold text-xs text-muted">{homeColor.label}</Text>
                <Text className="font-sans-bold text-3xl text-ink">{game.scoreHome ?? 0}</Text>
              </View>
              <Text className="font-sans-bold text-lg text-muted">–</Text>
              <View className="flex-1 items-center gap-1.5">
                <View
                  className="h-4 w-4 rounded-full"
                  style={{ backgroundColor: awayColor.hex, borderWidth: awayColor.id === 'white' ? 1 : 0, borderColor: '#E5E7EB' }}
                />
                <Text className="font-sans-bold text-xs text-muted">{awayColor.label}</Text>
                <Text className="font-sans-bold text-3xl text-ink">{game.scoreAway ?? 0}</Text>
              </View>
            </View>
            {game.scoreNotes ? <Text className="font-sans text-sm text-muted">{game.scoreNotes}</Text> : null}
            {game.motmName ? (
              <Text className="pt-2 text-center font-sans-bold text-sm text-primary">MOTM: {game.motmName}</Text>
            ) : null}
          </View>
        ) : null}

        {belowMin && !isFinished && !hasEnded ? (
          <View className="flex-row items-start gap-3 rounded-2xl border border-[#FEF3C7] bg-[#FFFBEB] p-4">
            <Ionicons name="warning-outline" size={16} color="#92400E" style={{ marginTop: 1 }} />
            <View className="flex-1 gap-0.5">
              <Text className="font-sans-bold text-xs text-[#92400E]">Below Minimum Players</Text>
              <Text className="font-sans text-[10px] leading-4 text-[#B45309]">
                This game needs {needed} more {needed === 1 ? 'player' : 'players'} by {formatLockDeadline(game.startsAt, lockHours)}{' '}
                or it will be automatically cancelled.
              </Text>
            </View>
          </View>
        ) : null}

        {game.notes ? (
          <View className="w-full gap-1.5 rounded-3xl bg-white p-6">
            <Text className="font-sans-bold text-xs uppercase tracking-wider text-muted">Notes</Text>
            <Text className="font-sans text-sm text-ink">{game.notes}</Text>
          </View>
        ) : null}

        <View className="w-full gap-4">
          {playersQuery.isPending ? (
            <View className="items-center py-6">
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : playersQuery.isError ? (
            <ErrorState message="Couldn't load this game's players." onRetry={() => playersQuery.refetch()} />
          ) : teamsPicked || isCompleted ? (
            <>
              <TeamBoard
                homeColor={homeColor}
                awayColor={awayColor}
                homePlayers={homePlayers}
                awayPlayers={awayPlayers}
                drag={drag}
              />
              {unassignedPlayers.length > 0 ? (
                <View className="w-full gap-2">
                  <Text className="px-1 font-sans-bold text-lg text-ink">Unassigned</Text>
                  <PlayerList players={unassignedPlayers} />
                </View>
              ) : null}
              {waitlistedPlayers.length > 0 ? (
                <View className="w-full gap-2">
                  <Text className="px-1 font-sans-bold text-lg text-ink">Waitlist</Text>
                  <PlayerList players={waitlistedPlayers} />
                </View>
              ) : null}
            </>
          ) : (
            <>
              <View className="flex-row items-center justify-between px-1">
                <Text className="font-sans-bold text-lg text-ink">Player List</Text>
                <Text className="font-sans text-xs text-muted">{confirmedPlayers.length} Confirmed</Text>
              </View>
              {players.length === 0 ? (
                <EmptyState icon="people-outline" title="No one's joined yet" subtitle="Players who join this game will show up here." />
              ) : (
                <PlayerList players={players} />
              )}
            </>
          )}
        </View>

        {actionError || moveError || cancelError ? (
          <Text className="font-sans-medium text-sm text-danger">{actionError || moveError || cancelError}</Text>
        ) : null}
      </ScrollView>

      {!isFinished || motmOpen || (isCompleted && game.hasJoined && !game.isWaitlisted) ? (
        <View
          className="absolute bottom-0 left-0 right-0 border-t border-border bg-white px-4 pt-4"
          style={{ paddingBottom: Math.max(insets.bottom, 24) }}
        >
          {isCompleted && motmOpen && !game.myMotmVoteUserId ? (
            <PrimaryButton label="Vote for Man of the Match" onPress={() => router.push(`/games/motm?gameId=${game.id}`)} />
          ) : isCompleted && motmOpen && game.myMotmVoteUserId ? (
            <PrimaryButton
              label="Change MOTM vote"
              variant="outline"
              onPress={() => router.push(`/games/motm?gameId=${game.id}`)}
            />
          ) : isCompleted && game.motmName ? (
            <View className="w-full flex-row items-center justify-center gap-1.5 rounded-control bg-background py-4">
              <Ionicons name="trophy" size={14} color={colors.primary} />
              <Text className="font-sans-bold text-sm text-ink">MOTM: {game.motmName}</Text>
            </View>
          ) : isCompleted ? (
            <View className="w-full flex-row items-center justify-center gap-1.5 rounded-control bg-background py-4">
              <Ionicons name="hourglass-outline" size={14} color={colors.muted} />
              <Text className="font-sans-bold text-sm text-muted">MOTM voting closed</Text>
            </View>
          ) : hasEnded && game.isAdmin ? (
            <PrimaryButton label="Enter Score" onPress={() => router.push(`/games/enter-score?gameId=${game.id}`)} />
          ) : hasEnded ? (
            <View className="w-full flex-row items-center justify-center gap-1.5 rounded-control bg-background py-4">
              <Ionicons name="hourglass-outline" size={14} color={colors.muted} />
              <Text className="font-sans-bold text-sm text-muted">Score not yet entered</Text>
            </View>
          ) : canJoinOpen && game.priceCents > 0 ? (
            <PrimaryButton
              label={`Pay ${formatGbp(game.totalCents)} to join`}
              loading={pending}
              onPress={payAndJoin}
            />
          ) : canJoinOpen ? (
            <PrimaryButton label="Join Game" loading={pending} onPress={join} />
          ) : game.hasJoined && game.myPaymentStatus === 'pending' && !game.isWaitlisted ? (
            <PrimaryButton
              label={`Pay ${formatGbp(game.totalCents)} to stay in`}
              loading={pending}
              onPress={payAndJoin}
            />
          ) : canJoinWaitlist ? (
            <PrimaryButton label="Join Waitlist" loading={pending} onPress={join} />
          ) : isFullNoWaitlist ? (
            <PrimaryButton label="Game is full" disabled />
          ) : leaveLocked ? (
            <View className="items-center gap-1 py-2">
              <View className="flex-row items-center gap-1.5">
                <Ionicons name="lock-closed" size={14} color={colors.muted} />
                <Text className="font-sans-bold text-sm text-muted">Leave locked within {lockHours}h of kickoff</Text>
              </View>
            </View>
          ) : confirmed && !game.hasJoined ? (
            <View className="items-center gap-1 py-2">
              <View className="flex-row items-center gap-1.5">
                <Ionicons name="lock-closed" size={14} color={colors.muted} />
                <Text className="font-sans-bold text-sm text-muted">Joining is locked within {lockHours}h of kickoff</Text>
              </View>
            </View>
          ) : game.hasJoined ? (
            <PrimaryButton
              label={game.isWaitlisted ? 'Leave Waitlist' : 'Leave Game'}
              variant="outline"
              loading={pending}
              onPress={() => {
                const paid = game.priceCents > 0 && !game.isWaitlisted;
                confirmLeaveGame({
                  isWaitlisted: game.isWaitlisted,
                  paid,
                  onLeave: () => leave(paid),
                });
              }}
            />
          ) : isCancelled ? (
            <PrimaryButton label="Game cancelled" disabled />
          ) : (
            <View className="items-center gap-1 py-2">
              <Text className="font-sans-bold text-sm text-muted">You can’t join this game</Text>
            </View>
          )}
        </View>
      ) : null}

      <TeamDragOverlay drag={drag} />
    </View>
  );
}
