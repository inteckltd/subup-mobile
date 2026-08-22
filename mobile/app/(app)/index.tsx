import { useQueryClient } from '@tanstack/react-query';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { useHasPendingInvites, useHomeRefresh, useMyGroups, useUpcomingGames } from '../../src/features/home/hooks';
import { SetupChecklist } from '../../src/features/onboarding/components/SetupChecklist';
import { consumeExplainerPresentation, useOnboardingFlags } from '../../src/features/onboarding/hooks';
import { getSetupProgress } from '../../src/features/onboarding/progress';
import { useAuth } from '../../src/providers/AuthProvider';
import { colors } from '../../src/theme/tokens';

const HOME_GROUPS_PREVIEW = 3;

export default function HomeScreen() {
  const { session, profile } = useAuth();
  const queryClient = useQueryClient();
  const groupsQuery = useMyGroups();
  const gamesQuery = useUpcomingGames();
  const { refreshing, refresh } = useHomeRefresh();
  const { ready, explainerSeen, checklistDismissed, dismissChecklist, refetch } = useOnboardingFlags(session?.user.id);
  const adminGroupIds = (groupsQuery.data ?? []).filter((group) => group.role === 'admin').map((group) => group.id);
  const pendingInvitesQuery = useHasPendingInvites(adminGroupIds);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const skipHomeRefetchOnFirstFocus = useRef(true);

  const groups = groupsQuery.data ?? [];
  const games = gamesQuery.data ?? [];
  const hasPendingInvite = pendingInvitesQuery.data === true;
  const progress = getSetupProgress(groups, games.length, hasPendingInvite);
  const pendingInvitesReady = adminGroupIds.length === 0 || pendingInvitesQuery.isSuccess || pendingInvitesQuery.isError;
  const showChecklist =
    ready &&
    !checklistDismissed &&
    groupsQuery.isSuccess &&
    !gamesQuery.isPending &&
    pendingInvitesReady &&
    progress.isOrganiser &&
    !progress.allComplete &&
    (explainerSeen || groups.length > 0);

  useFocusEffect(
    useCallback(() => {
      refetch();
      if (skipHomeRefetchOnFirstFocus.current) {
        skipHomeRefetchOnFirstFocus.current = false;
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ['home'] });
    }, [refetch, queryClient]),
  );

  useEffect(() => {
    const userId = session?.user.id;
    if (!userId || !ready || explainerSeen) return;
    if (!groupsQuery.isSuccess || groups.length > 0) return;
    if (!consumeExplainerPresentation(userId)) return;
    router.push('/onboarding');
  }, [session?.user.id, ready, explainerSeen, groupsQuery.isSuccess, groups.length]);

  const firstAdminGroupId = progress.firstAdminGroupId;

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
          {showChecklist ? (
            <SetupChecklist
              progress={progress}
              onDismiss={() => void dismissChecklist()}
              onCreateGroup={() => router.push('/create-group')}
              onInvite={() => {
                if (firstAdminGroupId) router.push(`/group/invite?groupId=${firstAdminGroupId}`);
                else router.push('/create-group');
              }}
              onScheduleGame={() => {
                if (firstAdminGroupId) {
                  router.push({ pathname: '/games/create', params: { groupId: firstAdminGroupId } });
                } else {
                  router.push('/create-group');
                }
              }}
            />
          ) : null}

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
            ) : games.length === 0 ? (
              <EmptyState
                icon="calendar-outline"
                title="No upcoming games yet"
                subtitle="Games from your groups will show up here once they're scheduled."
                actionLabel={firstAdminGroupId ? 'Schedule a game' : undefined}
                onPressAction={
                  firstAdminGroupId
                    ? () => router.push({ pathname: '/games/create', params: { groupId: firstAdminGroupId } })
                    : undefined
                }
              />
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 16 }}>
                {games.map((game) => (
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
            <SectionHeader
              title="My Groups"
              actionLabel="See all"
              actionVariant="pill"
              onPressAction={() => router.replace('/groups' as Href)}
            />

            {groupsQuery.isPending ? (
              <View className="w-full gap-3">
                <GroupCardSkeleton />
                <GroupCardSkeleton />
              </View>
            ) : groupsQuery.isError ? (
              <ErrorState message="Couldn't load your groups." onRetry={() => groupsQuery.refetch()} />
            ) : groups.length === 0 ? (
              <EmptyState
                icon="people-outline"
                title="No groups yet"
                subtitle="Join or create a group to start organising games with your squad."
                actionLabel="Create a group"
                onPressAction={() => router.push('/create-group')}
              />
            ) : (
              <View className="w-full gap-3">
                {groups.slice(0, HOME_GROUPS_PREVIEW).map((group, index) => (
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
