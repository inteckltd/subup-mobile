import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '../../../src/features/auth/components/PrimaryButton';
import { useMotmBallot, useVoteMotm } from '../../../src/features/games/hooks';
import type { MotmBallotModel } from '../../../src/features/games/types';
import { Avatar } from '../../../src/features/home/components/Avatar';
import { EmptyState } from '../../../src/features/home/components/EmptyState';
import { ErrorState } from '../../../src/features/home/components/ErrorState';
import { formatCountdown } from '../../../src/lib/format';
import { useUnsavedChangesGuard } from '../../../src/lib/useUnsavedChangesGuard';
import { colors } from '../../../src/theme/tokens';

function leadingVoteCount(ballot: MotmBallotModel): number {
  return ballot.candidates.reduce((max, candidate) => Math.max(max, candidate.voteCount ?? 0), 0);
}

function isMotmTie(ballot: MotmBallotModel): boolean {
  const lead = leadingVoteCount(ballot);
  if (lead <= 0) return false;
  return ballot.candidates.filter((candidate) => (candidate.voteCount ?? 0) === lead).length > 1;
}

function motmBarWidth(voteCount: number | null, lead: number): number {
  if (voteCount == null || lead <= 0) return 0;
  return Math.round((voteCount / lead) * 100);
}

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

export default function MotmVoteScreen() {
  const { gameId } = useLocalSearchParams<{ gameId: string }>();
  const now = useNow();
  const ballotQuery = useMotmBallot(gameId);
  const { vote, pending, error } = useVoteMotm(gameId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const ballot = ballotQuery.data;
  const leadVotes = ballot ? leadingVoteCount(ballot) : 0;
  const selected = selectedId ?? ballot?.myVoteUserId ?? null;
  const isDirty = ballot?.isOpen === true && selectedId != null && selectedId !== ballot.myVoteUserId;
  const { allowLeave } = useUnsavedChangesGuard(isDirty);

  return (
    <View className="flex-1 bg-background">
      <SafeAreaView edges={['top']} className="bg-white">
        <View className="w-full flex-row items-center gap-4 border-b border-border px-4 py-4">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            className="h-10 w-10 items-center justify-center rounded-full bg-background"
          >
            <Ionicons name="chevron-back" size={18} color={colors.ink} />
          </Pressable>
          <Text className="font-sans-bold text-lg text-ink">Man of the Match</Text>
        </View>
      </SafeAreaView>

      {ballotQuery.isPending ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : ballotQuery.isError || !ballot ? (
        <View className="flex-1 items-center justify-center px-8">
          <ErrorState message="Couldn't load MOTM voting." onRetry={() => ballotQuery.refetch()} />
          <PrimaryButton label="Back" className="mt-6 w-auto px-8" onPress={() => router.back()} />
        </View>
      ) : (
        <>
          <ScrollView
            contentContainerStyle={{ padding: 20, paddingBottom: 140, gap: 16 }}
            refreshControl={
              <RefreshControl refreshing={ballotQuery.isRefetching} onRefresh={() => ballotQuery.refetch()} tintColor={colors.primary} />
            }
          >
            <View className="gap-1">
              <Text className="font-sans-bold text-xl text-ink">{ballot.title || ballot.groupName}</Text>
              {ballot.isOpen && ballot.closesAt ? (
                <Text className="font-sans text-sm text-muted">Voting closes in {formatCountdown(ballot.closesAt, now)}</Text>
              ) : ballot.motmName ? (
                <Text className="font-sans-bold text-sm text-primary">Winner: {ballot.motmName}</Text>
              ) : (
                <Text className="font-sans text-sm text-muted">Voting has closed.</Text>
              )}
              {!ballot.isOpen && ballot.voteTotal != null ? (
                <Text className="font-sans text-sm text-muted">
                  {ballot.voteTotal} {ballot.voteTotal === 1 ? 'vote' : 'votes'}
                </Text>
              ) : null}
              {!ballot.isOpen && isMotmTie(ballot) ? (
                <Text className="font-sans text-sm text-muted">Tied — winner decided by tie-break</Text>
              ) : null}
            </View>

            {ballot.candidates.length === 0 ? (
              <EmptyState
                icon="trophy-outline"
                title="No one to vote for"
                subtitle="MOTM needs at least two confirmed players."
              />
            ) : (
              <View className="overflow-hidden rounded-3xl border border-border bg-white">
                {ballot.candidates.map((candidate, index) => {
                  const isSelected = selected === candidate.userId;
                  const isWinner = !ballot.isOpen && ballot.motmUserId === candidate.userId;
                  const voteCount = candidate.voteCount;
                  const barWidth = motmBarWidth(voteCount, leadVotes);
                  return (
                    <Pressable
                      key={candidate.userId}
                      disabled={!ballot.isOpen}
                      onPress={() => setSelectedId(candidate.userId)}
                      className={`gap-2 px-4 py-4 ${index > 0 ? 'border-t border-[#F9FAFB]' : ''} ${
                        isWinner ? 'bg-accent/15' : isSelected ? 'bg-accent/15' : ''
                      }`}
                    >
                      <View className="flex-row items-center gap-3">
                        <Avatar uri={candidate.avatarUrl} name={candidate.name} size={44} />
                        <View className="flex-1">
                          <Text className="font-sans-bold text-sm text-ink">{candidate.name}</Text>
                          <Text className="font-sans text-[10px] text-muted">
                            {isWinner ? 'Man of the Match' : `MMR ${candidate.mmr}`}
                          </Text>
                        </View>
                        {!ballot.isOpen && voteCount != null ? (
                          <Text className="font-sans-bold text-sm text-ink">
                            {voteCount} {voteCount === 1 ? 'vote' : 'votes'}
                          </Text>
                        ) : null}
                        {isWinner ? <Ionicons name="trophy" size={20} color={colors.gold} /> : null}
                        {ballot.isOpen && isSelected ? (
                          <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
                        ) : null}
                      </View>
                      {!ballot.isOpen && voteCount != null ? (
                        <View className="h-1.5 overflow-hidden rounded-full bg-border">
                          <View className="h-full rounded-full bg-primary" style={{ width: `${barWidth}%` }} />
                        </View>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            )}
            {error ? <Text className="font-sans-medium text-sm text-danger">{error}</Text> : null}
          </ScrollView>

          {ballot.isOpen && ballot.candidates.length > 0 ? (
            <View className="border-t border-border bg-white px-4 py-4">
              <PrimaryButton
                label={ballot.myVoteUserId ? 'Update vote' : 'Submit vote'}
                loading={pending}
                disabled={!selected}
                onPress={() => {
                  if (!selected) return;
                  void vote(selected).then((ok) => {
                    if (ok) {
                      allowLeave();
                      router.back();
                    }
                  });
                }}
              />
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}
