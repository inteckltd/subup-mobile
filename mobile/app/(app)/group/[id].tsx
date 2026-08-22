import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '../../../src/features/auth/components/PrimaryButton';
import {
  cancelGroupInvite,
  kickGroupMember,
  leaveGroup,
  promoteGroupAdmin,
} from '../../../src/features/group-details/api';
import { GroupActionButtons } from '../../../src/features/group-details/components/GroupActionButtons';
import { GroupCoverHeader } from '../../../src/features/group-details/components/GroupCoverHeader';
import { GroupGameCard } from '../../../src/features/group-details/components/GroupGameCard';
import { GroupHistoryCard } from '../../../src/features/group-details/components/GroupHistoryCard';
import { GroupTabBar, type GroupTabKey } from '../../../src/features/group-details/components/GroupTabBar';
import { MemberCard } from '../../../src/features/group-details/components/MemberCard';
import {
  useGroupDetail,
  useGroupDetailRefresh,
  useGroupHistory,
  useGroupMembers,
  useGroupPendingInvites,
  useGroupUpcomingGames,
} from '../../../src/features/group-details/hooks';
import type { GroupMemberModel, GroupPendingInviteModel } from '../../../src/features/group-details/types';
import { Avatar } from '../../../src/features/home/components/Avatar';
import { BottomNavBar } from '../../../src/features/home/components/BottomNavBar';
import { EmptyState } from '../../../src/features/home/components/EmptyState';
import { ErrorState } from '../../../src/features/home/components/ErrorState';
import { SectionHeader } from '../../../src/features/home/components/SectionHeader';
import { GroupGameCardSkeleton, MemberCardSkeleton } from '../../../src/features/home/components/Skeleton';
import { useAuth } from '../../../src/providers/AuthProvider';
import { colors } from '../../../src/theme/tokens';

/** Preview count for the Upcoming tab's "Active Members" section before "View All" switches to the Members tab. */
const ACTIVE_MEMBERS_PREVIEW_COUNT = 4;

/**
 * Splits a list into fixed-size rows for a 2-column grid. `MemberCard` uses
 * `flex-1` to fill its row evenly, which only behaves predictably with a
 * fixed number of items per row (unlike `flex-wrap`, whose interaction with
 * `flex-1`/zero flex-basis is inconsistent across RN's Yoga versions).
 */
function toRows<T>(items: T[], size = 2): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

function showActionError(message: string) {
  Alert.alert("Couldn't do that", message);
}

export default function GroupDetailsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<GroupTabKey>('upcoming');
  const [actionPending, setActionPending] = useState(false);

  const groupQuery = useGroupDetail(id);
  const membersQuery = useGroupMembers(id);
  const gamesQuery = useGroupUpcomingGames(id);
  const invitesQuery = useGroupPendingInvites(id);
  const historyQuery = useGroupHistory(id);
  const { refreshing, refresh } = useGroupDetailRefresh(id);

  if (groupQuery.isPending) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (groupQuery.isError || !groupQuery.data) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background px-8" edges={['top', 'bottom']}>
        <ErrorState message="Couldn't load this group. Pull to refresh or try again." onRetry={() => groupQuery.refetch()} />
        <PrimaryButton label="Back to Home" className="mt-6 w-auto px-8" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  const group = groupQuery.data;
  const isAdmin = group.role === 'admin';
  const games = gamesQuery.data ?? [];
  const members = membersQuery.data ?? [];
  const invites = invitesQuery.data ?? [];
  const history = historyQuery.data ?? [];
  const playedCount = history[0]?.playedCount ?? 0;
  const myUserId = session?.user.id;

  async function invalidateGroup() {
    if (!session || !id) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['group', id] }),
      queryClient.invalidateQueries({ queryKey: ['home', 'my-groups', session.user.id] }),
    ]);
  }

  function confirmLeaveGroup() {
    Alert.alert('Leave group', `Leave ${group.name}? You will lose access until invited again.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setActionPending(true);
            const result = await leaveGroup(group.id);
            setActionPending(false);
            if (result.error) {
              showActionError(result.error);
              return;
            }
            await invalidateGroup();
            router.replace('/');
          })();
        },
      },
    ]);
  }

  function openGroupMenu() {
    const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [];
    if (isAdmin) {
      buttons.push({
        text: 'Edit group',
        onPress: () => router.push(`/group/edit?groupId=${group.id}`),
      });
    }
    buttons.push({ text: 'Leave group', style: 'destructive', onPress: confirmLeaveGroup });
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(group.name, undefined, buttons);
  }

  function openMemberActions(member: GroupMemberModel) {
    if (!isAdmin || member.userId === myUserId) return;
    const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [];
    if (member.role !== 'admin') {
      buttons.push({
        text: 'Promote to admin',
        onPress: () => {
          Alert.alert('Promote to admin', `Make ${member.name} a group admin?`, [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Promote',
              onPress: () => {
                void (async () => {
                  setActionPending(true);
                  const result = await promoteGroupAdmin(group.id, member.userId);
                  setActionPending(false);
                  if (result.error) showActionError(result.error);
                  else await invalidateGroup();
                })();
              },
            },
          ]);
        },
      });
    }
    buttons.push({
      text: 'Remove from group',
      style: 'destructive',
      onPress: () => {
        Alert.alert('Remove member', `Remove ${member.name} from ${group.name}?`, [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                setActionPending(true);
                const result = await kickGroupMember(group.id, member.userId);
                setActionPending(false);
                if (result.error) showActionError(result.error);
                else await invalidateGroup();
              })();
            },
          },
        ]);
      },
    });
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(member.name, undefined, buttons);
  }

  function confirmCancelInvite(invite: GroupPendingInviteModel) {
    Alert.alert('Cancel invite', `Cancel the invite for ${invite.name}?`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Cancel invite',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setActionPending(true);
            const result = await cancelGroupInvite(invite.id);
            setActionPending(false);
            if (result.error) showActionError(result.error);
            else await invalidateGroup();
          })();
        },
      },
    ]);
  }

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 140 }}
        refreshControl={<RefreshControl refreshing={refreshing || actionPending} onRefresh={refresh} tintColor={colors.primary} />}
      >
        <GroupCoverHeader
          group={group}
          onPressBack={() => router.back()}
          onPressMenu={openGroupMenu}
        />

        {isAdmin ? (
          <View className="-mt-6">
            <GroupActionButtons
              onPressCreateGame={() => router.push({ pathname: '/games/create', params: { groupId: group.id } })}
              onPressInvite={() => router.push(`/group/invite?groupId=${group.id}`)}
            />
          </View>
        ) : null}

        {isAdmin && group.memberCount === 1 && !gamesQuery.isPending && !gamesQuery.isError && games.length === 0 ? (
          <View className="mx-5 mt-4 rounded-2xl border border-border bg-white px-4 py-3">
            <Text className="font-sans-bold text-sm text-ink">Get your squad in</Text>
            <Text className="mt-1 font-sans text-xs text-muted">
              Invite players, then schedule your first game with the buttons above.
            </Text>
          </View>
        ) : null}

        <View className={isAdmin ? 'pt-5' : 'pt-2'}>
          <GroupTabBar activeTab={activeTab} onChangeTab={setActiveTab} />
        </View>

        <View className="gap-6 px-5 pt-5">
          {activeTab === 'upcoming' ? (
            <>
              <View className="gap-4">
                {gamesQuery.isPending ? (
                  <GroupGameCardSkeleton />
                ) : gamesQuery.isError ? (
                  <ErrorState message="Couldn't load this group's games." onRetry={() => gamesQuery.refetch()} />
                ) : games.length === 0 ? (
                  <EmptyState
                    icon="calendar-outline"
                    title="No games scheduled"
                    subtitle="Games from this group will show up here once they're scheduled."
                  />
                ) : (
                  <>
                    {games.map((game) => (
                      <GroupGameCard
                        key={game.id}
                        game={game}
                        lockHours={group.lockHours}
                        onPress={() => router.push(`/games/${game.id}`)}
                        onPressJoin={() => router.push(`/games/${game.id}`)}
                        onPressLeave={() => router.push(`/games/${game.id}`)}
                      />
                    ))}
                    <View className="items-center gap-2 rounded-2xl border border-dashed border-border bg-white/60 px-6 py-8">
                      <Ionicons name="calendar-outline" size={20} color={colors.muted} />
                      <Text className="font-sans text-xs text-muted">No other games scheduled</Text>
                    </View>
                  </>
                )}
              </View>

              <View className="gap-4">
                <SectionHeader title="Active Members" actionLabel="View All" onPressAction={() => setActiveTab('members')} />
                {membersQuery.isPending ? (
                  <View className="flex-row gap-3">
                    <MemberCardSkeleton fillRow />
                    <MemberCardSkeleton fillRow />
                  </View>
                ) : membersQuery.isError ? (
                  <ErrorState message="Couldn't load members." onRetry={() => membersQuery.refetch()} />
                ) : members.length === 0 ? (
                  <EmptyState icon="people-outline" title="No members yet" subtitle="Members will show up here once they join." />
                ) : (
                  <View className="gap-3">
                    {toRows(members.slice(0, ACTIVE_MEMBERS_PREVIEW_COUNT)).map((row) => (
                      <View key={row[0]!.id} className="flex-row gap-3">
                        {row.map((member) => (
                          <MemberCard key={member.id} member={member} fillRow />
                        ))}
                        {row.length === 1 ? <View className="flex-1" /> : null}
                      </View>
                    ))}
                  </View>
                )}
              </View>
            </>
          ) : activeTab === 'members' ? (
            <>
              <View className="gap-3">
                <SectionHeader title="Active" />
                {membersQuery.isPending ? (
                  <View className="gap-3">
                    <MemberCardSkeleton />
                    <MemberCardSkeleton />
                  </View>
                ) : membersQuery.isError ? (
                  <ErrorState message="Couldn't load members." onRetry={() => membersQuery.refetch()} />
                ) : members.length === 0 ? (
                  <EmptyState icon="people-outline" title="No members yet" subtitle="Members will show up here once they join." />
                ) : (
                  <View className="gap-3">
                    {members.map((member) => (
                      <MemberCard
                        key={member.id}
                        member={member}
                        showRoleBadge
                        onPress={isAdmin && member.userId !== myUserId ? () => openMemberActions(member) : undefined}
                      />
                    ))}
                  </View>
                )}
              </View>

              <View className="gap-3">
                <SectionHeader title="Invited" />
                {invitesQuery.isPending ? (
                  <View className="gap-3">
                    <MemberCardSkeleton />
                    <MemberCardSkeleton />
                  </View>
                ) : invitesQuery.isError ? (
                  <ErrorState message="Couldn't load invites." onRetry={() => invitesQuery.refetch()} />
                ) : invites.length === 0 ? (
                  <EmptyState
                    icon="mail-outline"
                    title="No pending invites"
                    subtitle={isAdmin ? 'Invite someone by their UK mobile number.' : 'Pending invites will show up here.'}
                  />
                ) : (
                  <View className="gap-3">
                    {invites.map((invite) => (
                      <View key={invite.id} className="flex-row items-center gap-3 rounded-2xl border border-border bg-white p-3">
                        <Avatar uri={invite.avatarUrl} name={invite.name} size={44} />
                        <View className="flex-1">
                          <Text className="font-sans-bold text-sm text-ink" numberOfLines={1}>
                            {invite.name}
                          </Text>
                          <Text className="font-sans text-xs text-muted">
                            {invite.awaitingSignup ? 'SMS invite sent' : 'Pending invite'}
                          </Text>
                        </View>
                        {isAdmin ? (
                          <Pressable onPress={() => confirmCancelInvite(invite)} hitSlop={8} className="rounded-full border border-border px-3 py-1.5">
                            <Text className="font-sans-bold text-xs text-danger">Cancel</Text>
                          </Pressable>
                        ) : null}
                      </View>
                    ))}
                  </View>
                )}
              </View>
            </>
          ) : (
            <View className="gap-4">
              {history.length > 0 ? (
                <Text className="font-sans text-sm text-muted">
                  Played {playedCount} {playedCount === 1 ? 'game' : 'games'}
                </Text>
              ) : null}
              {historyQuery.isPending ? (
                <GroupGameCardSkeleton />
              ) : historyQuery.isError ? (
                <ErrorState message="Couldn't load this group's history." onRetry={() => historyQuery.refetch()} />
              ) : history.length === 0 ? (
                <EmptyState
                  icon="trophy-outline"
                  title="No games played yet"
                  subtitle="Completed games will show colours, scores, and dates here."
                />
              ) : (
                history.map((game) => (
                  <GroupHistoryCard key={game.id} game={game} onPress={() => router.push(`/games/${game.id}`)} />
                ))
              )}
            </View>
          )}
        </View>
      </ScrollView>

      <BottomNavBar activeKey="groups" />
    </View>
  );
}
