import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';

import { AvatarLightbox } from '../../../src/features/home/components/AvatarLightbox';
import { BottomNavBar } from '../../../src/features/home/components/BottomNavBar';
import { CreateFab } from '../../../src/features/home/components/CreateFab';
import { EmptyState } from '../../../src/features/home/components/EmptyState';
import { ErrorState } from '../../../src/features/home/components/ErrorState';
import { HomeHeader } from '../../../src/features/home/components/HomeHeader';
import { GameCardSkeleton } from '../../../src/features/home/components/Skeleton';
import { useMyGroups, useUpcomingGames } from '../../../src/features/home/hooks';
import { formatFullDateLabel, formatGbp, formatUkTime, londonDateKey } from '../../../src/lib/format';
import { useAuth } from '../../../src/providers/AuthProvider';
import { colors } from '../../../src/theme/tokens';
import type { GameCardModel } from '../../../src/features/home/types';

function groupByDate(games: GameCardModel[]): { key: string; label: string; games: GameCardModel[] }[] {
  const groups: { key: string; label: string; games: GameCardModel[] }[] = [];
  for (const game of games) {
    const key = londonDateKey(game.startsAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.games.push(game);
    } else {
      groups.push({ key, label: formatFullDateLabel(game.startsAt), games: [game] });
    }
  }
  return groups;
}

export default function GamesScreen() {
  const { profile } = useAuth();
  const gamesQuery = useUpcomingGames();
  const groupsQuery = useMyGroups();
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const games = gamesQuery.data ?? [];
  const grouped = groupByDate(games);
  const firstAdminGroupId = (groupsQuery.data ?? []).find((group) => group.role === 'admin')?.id;
  const hasNoGroups = groupsQuery.isSuccess && (groupsQuery.data ?? []).length === 0;

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 140 }}
        refreshControl={
          <RefreshControl refreshing={gamesQuery.isRefetching} onRefresh={() => gamesQuery.refetch()} tintColor={colors.primary} />
        }
      >
        <HomeHeader
          profile={profile}
          onPressNotifications={() => router.push('/notifications')}
          onPressSettings={() => router.push('/profile/settings')}
          onPressSmallAvatar={() => router.push('/profile')}
          onPressLargeAvatar={() => setLightboxOpen(true)}
        />

        <View className="gap-6 px-5 pt-6">
          {gamesQuery.isPending ? (
            <View className="gap-3">
              <GameCardSkeleton />
              <GameCardSkeleton />
            </View>
          ) : gamesQuery.isError ? (
            <ErrorState message="Couldn't load your upcoming games." onRetry={() => gamesQuery.refetch()} />
          ) : games.length === 0 ? (
            <EmptyState
              icon="calendar-outline"
              title="No upcoming games"
              subtitle="Games from groups you belong to will show up here."
              actionLabel={firstAdminGroupId ? 'Schedule a game' : hasNoGroups ? 'Create a group' : undefined}
              onPressAction={
                firstAdminGroupId
                  ? () => router.push({ pathname: '/games/create', params: { groupId: firstAdminGroupId } })
                  : hasNoGroups
                    ? () => router.push('/create-group')
                    : undefined
              }
            />
          ) : (
            grouped.map((group) => (
              <View key={group.key} className="gap-3">
                <Text className="font-sans-bold text-xs uppercase tracking-wider text-muted">{group.label}</Text>
                {group.games.map((game) => {
                  const venue = [game.venueName, game.venueAddress].filter(Boolean).join(' · ');
                  return (
                    <Pressable
                      key={game.id}
                      onPress={() => router.push(`/games/${game.id}`)}
                      className="gap-2 rounded-2xl border border-border bg-white p-4"
                    >
                      <View className="flex-row items-center justify-between">
                        <Text className="flex-1 font-sans-bold text-base text-ink" numberOfLines={1}>
                          {game.title || game.groupName}
                        </Text>
                        <Text className="font-sans text-xs text-muted">{formatUkTime(game.startsAt)}</Text>
                      </View>
                      <Text className="font-sans text-xs text-muted">{game.groupName}</Text>
                      {venue ? <Text className="font-sans text-xs text-muted">{venue}</Text> : null}
                      <View className="flex-row items-center justify-between pt-1">
                        <Text className="font-sans text-xs text-ink">
                          {game.spotsTaken}/{game.maxPlayers} spots
                        </Text>
                        <Text className="font-sans-bold text-xs text-primary">{formatGbp(game.priceCents)}</Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            ))
          )}
        </View>
      </ScrollView>

      <CreateFab
        onCreateGame={() => router.push('/games/create')}
        onCreateGroup={() => router.push('/create-group')}
      />

      <BottomNavBar activeKey="games" />

      <AvatarLightbox
        visible={lightboxOpen}
        uri={profile?.avatar_url}
        name={profile?.full_name}
        onClose={() => setLightboxOpen(false)}
      />
    </View>
  );
}
