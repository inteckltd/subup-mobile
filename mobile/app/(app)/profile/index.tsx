import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from 'react-native';

import { SPORT_OPTIONS } from '../../../src/features/groups/schemas';
import { AvatarLightbox } from '../../../src/features/home/components/AvatarLightbox';
import { BottomNavBar } from '../../../src/features/home/components/BottomNavBar';
import { EmptyState } from '../../../src/features/home/components/EmptyState';
import { ErrorState } from '../../../src/features/home/components/ErrorState';
import { HomeHeader } from '../../../src/features/home/components/HomeHeader';
import { sportIcon } from '../../../src/features/home/sportIcon';
import { useMyProfileStats, useMyRecentGames, useMySportBreakdown } from '../../../src/features/profile/hooks';
import type { FormResult } from '../../../src/features/profile/types';
import { useAuth } from '../../../src/providers/AuthProvider';
import { colors } from '../../../src/theme/tokens';

function sportLabel(sport: string): string {
  return SPORT_OPTIONS.find((option) => option.value === sport)?.label ?? sport;
}

function formLetterStyle(result: FormResult): { bg: string; text: string } {
  if (result === 'W') return { bg: colors.primary, text: colors.white };
  if (result === 'L') return { bg: colors.danger, text: colors.white };
  return { bg: colors.border, text: colors.muted };
}

export default function ProfileScreen() {
  const { profile, session } = useAuth();
  const statsQuery = useMyProfileStats();
  const sportsQuery = useMySportBreakdown();
  const recentQuery = useMyRecentGames();
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const refreshing = statsQuery.isRefetching || sportsQuery.isRefetching || recentQuery.isRefetching;
  const refresh = () => {
    void statsQuery.refetch();
    void sportsQuery.refetch();
    void recentQuery.refetch();
  };

  const stats = statsQuery.data;
  const sports = sportsQuery.data ?? [];
  const recent = recentQuery.data ?? [];
  const form = [...recent].reverse();
  const winRateLabel = stats?.winRate == null ? '—' : `${stats.winRate}%`;

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 140 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
      >
        <HomeHeader
          profile={profile}
          onPressNotifications={() => router.push('/notifications')}
          onPressLargeAvatar={() => setLightboxOpen(true)}
          onPressEdit={() => router.push('/profile/edit')}
          onPressSettings={() => router.push('/profile/settings')}
        />

        <View className="gap-8 px-4 pt-8">
          {statsQuery.isPending ? (
            <ActivityIndicator color={colors.primary} />
          ) : statsQuery.isError ? (
            <ErrorState message="Couldn't load your stats." onRetry={() => statsQuery.refetch()} />
          ) : (
            <View className="flex-row gap-3">
              <View className="flex-1 items-center rounded-2xl border border-border bg-white p-4">
                <Ionicons name="football-outline" size={18} color={colors.primary} />
                <Text className="pt-1 font-sans-bold text-lg text-ink">{stats?.gamesPlayed ?? 0}</Text>
                <Text className="font-sans-bold text-[9px] uppercase tracking-wide text-muted">Games</Text>
              </View>
              <View className="flex-1 items-center rounded-2xl border border-border bg-white p-4">
                <Ionicons name="trending-up-outline" size={18} color={colors.primary} />
                <Text className="pt-1 font-sans-bold text-lg text-ink">{winRateLabel}</Text>
                <Text className="font-sans-bold text-[9px] uppercase tracking-wide text-muted">Win rate</Text>
              </View>
              <View className="flex-1 items-center rounded-2xl border border-border bg-white p-4">
                <Ionicons name="trophy-outline" size={18} color={colors.primary} />
                <Text className="pt-1 font-sans-bold text-lg text-ink">{stats?.motmCount ?? 0}</Text>
                <Text className="font-sans-bold text-[9px] uppercase tracking-wide text-muted">MOTM</Text>
              </View>
            </View>
          )}

          <View className="gap-4 rounded-3xl border border-border bg-white p-6">
            <View className="flex-row items-center justify-between">
              <Text className="font-sans-bold text-sm text-ink">Recent Form</Text>
              <Text className="font-sans-bold text-[10px] uppercase tracking-wide text-muted">Last 5 games</Text>
            </View>
            {recentQuery.isPending ? (
              <ActivityIndicator color={colors.primary} />
            ) : form.length === 0 ? (
              <Text className="font-sans text-sm text-muted">Play some games to build your recent form.</Text>
            ) : (
              <View className="flex-row gap-2">
                {form.map((game) => {
                  const style = formLetterStyle(game.result);
                  return (
                    <View
                      key={game.id}
                      className="h-10 w-10 items-center justify-center rounded-xl"
                      style={{ backgroundColor: style.bg }}
                    >
                      <Text className="font-sans-extrabold text-sm" style={{ color: style.text }}>
                        {game.result}
                      </Text>
                    </View>
                  );
                })}
              </View>
            )}
          </View>

          <View className="gap-3">
            <Text className="font-sans-bold text-sm text-ink">Sport Breakdown</Text>
            {sportsQuery.isPending ? (
              <ActivityIndicator color={colors.primary} />
            ) : sports.length === 0 ? (
              <EmptyState icon="football-outline" title="No sports yet" subtitle="Completed games will show a breakdown here." />
            ) : (
              sports.map((row) => (
                <View key={row.sport} className="flex-row items-center gap-4 rounded-2xl border border-border bg-white p-4">
                  <View className="h-12 w-12 items-center justify-center rounded-xl bg-accent/20">
                    <Ionicons name={sportIcon(row.sport)} size={20} color={colors.primary} />
                  </View>
                  <View className="flex-1">
                    <Text className="font-sans-bold text-sm text-ink">{sportLabel(row.sport)}</Text>
                    <Text className="font-sans text-[10px] text-muted">{row.gamesPlayed} Games</Text>
                  </View>
                  <Text className="font-sans-bold text-xs text-ink">
                    MMR {(stats?.globalMmr ?? 1000).toLocaleString('en-GB')}
                  </Text>
                </View>
              ))
            )}
          </View>
        </View>
      </ScrollView>
      {session ? <BottomNavBar activeKey="profile" /> : null}
      <AvatarLightbox
        visible={lightboxOpen}
        uri={profile?.avatar_url}
        name={profile?.full_name}
        onClose={() => setLightboxOpen(false)}
      />
    </View>
  );
}
