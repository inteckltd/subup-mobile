import { router } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { AvatarLightbox } from '../../../src/features/home/components/AvatarLightbox';
import { BottomNavBar } from '../../../src/features/home/components/BottomNavBar';
import { CreateFab } from '../../../src/features/home/components/CreateFab';
import { EmptyState } from '../../../src/features/home/components/EmptyState';
import { ErrorState } from '../../../src/features/home/components/ErrorState';
import { GroupCard } from '../../../src/features/home/components/GroupCard';
import { HomeHeader } from '../../../src/features/home/components/HomeHeader';
import { GroupCardSkeleton } from '../../../src/features/home/components/Skeleton';
import { useMyGroups } from '../../../src/features/home/hooks';
import { useAuth } from '../../../src/providers/AuthProvider';
import { colors } from '../../../src/theme/tokens';

export default function GroupsScreen() {
  const { profile } = useAuth();
  const groupsQuery = useMyGroups();
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const groups = groupsQuery.data ?? [];

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 140 }}
        refreshControl={
          <RefreshControl refreshing={groupsQuery.isRefetching} onRefresh={() => groupsQuery.refetch()} tintColor={colors.primary} />
        }
      >
        <HomeHeader
          profile={profile}
          onPressNotifications={() => router.push('/notifications')}
          onPressSettings={() => router.push('/profile/settings')}
          onPressSmallAvatar={() => router.push('/profile')}
          onPressLargeAvatar={() => setLightboxOpen(true)}
        />

        <View className="gap-3 px-5 pt-6">
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
            groups.map((group, index) => (
              <GroupCard
                key={group.id}
                group={group}
                tintIndex={index}
                onPress={() => router.push(`/group/${group.id}`)}
              />
            ))
          )}
        </View>
      </ScrollView>

      <CreateFab
        onCreateGame={() => router.push('/games/create')}
        onCreateGroup={() => router.push('/create-group')}
      />

      <BottomNavBar activeKey="groups" />

      <AvatarLightbox
        visible={lightboxOpen}
        uri={profile?.avatar_url}
        name={profile?.full_name}
        onClose={() => setLightboxOpen(false)}
      />
    </View>
  );
}
