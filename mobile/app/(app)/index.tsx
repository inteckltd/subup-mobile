import { router } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { AvatarLightbox } from '../../src/features/home/components/AvatarLightbox';
import { BottomNavBar } from '../../src/features/home/components/BottomNavBar';
import { CreateFab } from '../../src/features/home/components/CreateFab';
import { EmptyState } from '../../src/features/home/components/EmptyState';
import { ErrorState } from '../../src/features/home/components/ErrorState';
import { GameCard } from '../../src/features/home/components/GameCard';
import { GroupCard } from '../../src/features/home/components/GroupCard';
import { HomeHeader } from '../../src/features/home/components/HomeHeader';
import { SectionHeader } from '../../src/features/home/components/SectionHeader';
import { GameCardSkeleton, GroupCardSkeleton } from '../../src/features/home/components/Skeleton';
import { useHomeRefresh, useMyGroups, useUpcomingGames } from '../../src/features/home/hooks';
import { useAuth } from '../../src/providers/AuthProvider';
import { colors } from '../../src/theme/tokens';

export default function HomeScreen() {
  const { profile } = useAuth();
  const groupsQuery = useMyGroups();
  const gamesQuery = useUpcomingGames();
  const { refreshing, refresh } = useHomeRefresh();
  const [lightboxOpen, setLightboxOpen] = useState(false);

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 140 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
      >
        <HomeHeader
          profile={profile}
          onPressNotifications={() => router.push('/notifications')}
          onPressSettings={() => router.push('/profile/settings')}
          onPressSmallAvatar={() => router.push('/profile')}
          onPressLargeAvatar={() => setLightboxOpen(true)}
        />

        <View className="gap-10 px-5 pt-6">
          <View className="w-full gap-4">
            <SectionHeader
              title="Upcoming Games"
              actionLabel="See all"
              actionVariant="pill"
              onPressAction={() => router.push('/games')}
            />

            {gamesQuery.isPending ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 16 }}>
                <GameCardSkeleton />
                <GameCardSkeleton />
              </ScrollView>
            ) : gamesQuery.isError ? (
              <ErrorState message="Couldn't load your upcoming games." onRetry={() => gamesQuery.refetch()} />
            ) : (gamesQuery.data ?? []).length === 0 ? (
              <EmptyState
                icon="calendar-outline"
                title="No upcoming games yet"
                subtitle="Games from your groups will show up here once they're scheduled."
              />
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 16 }}>
                {(gamesQuery.data ?? []).map((game) => (
                  <GameCard
                    key={game.id}
                    game={game}
                    onPress={() => router.push(`/games/${game.id}`)}
                    onPressJoin={() => router.push(`/games/${game.id}`)}
                  />
                ))}
              </ScrollView>
            )}
          </View>

          <View className="w-full gap-4">
            <SectionHeader title="My Groups" />

            {groupsQuery.isPending ? (
              <View className="w-full gap-3">
                <GroupCardSkeleton />
                <GroupCardSkeleton />
              </View>
            ) : groupsQuery.isError ? (
              <ErrorState message="Couldn't load your groups." onRetry={() => groupsQuery.refetch()} />
            ) : (groupsQuery.data ?? []).length === 0 ? (
              <EmptyState
                icon="people-outline"
                title="No groups yet"
                subtitle="Join or create a group to start organising games with your squad."
              />
            ) : (
              <View className="w-full gap-3">
                {(groupsQuery.data ?? []).map((group, index) => (
                  <GroupCard
                    key={group.id}
                    group={group}
                    tintIndex={index}
                    onPress={() => router.push(`/group/${group.id}`)}
                  />
                ))}
              </View>
            )}
          </View>
        </View>
      </ScrollView>

      <CreateFab
        onCreateGame={() => router.push('/games/create')}
        onCreateGroup={() => router.push('/create-group')}
      />

      <BottomNavBar activeKey="home" />

      <AvatarLightbox
        visible={lightboxOpen}
        uri={profile?.avatar_url}
        name={profile?.full_name}
        onClose={() => setLightboxOpen(false)}
      />
    </View>
  );
}
