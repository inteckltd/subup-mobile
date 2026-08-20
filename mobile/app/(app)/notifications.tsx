import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '../../src/features/auth/components/PrimaryButton';
import { EmptyState } from '../../src/features/home/components/EmptyState';
import { ErrorState } from '../../src/features/home/components/ErrorState';
import { useInviteActions, useMyNotifications } from '../../src/features/notifications/hooks';
import { formatUkDate } from '../../src/lib/format';
import { colors } from '../../src/theme/tokens';

export default function NotificationsScreen() {
  const query = useMyNotifications();
  const { accept, decline, pending, error } = useInviteActions();
  const rows = query.data ?? [];

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
          <Text className="font-sans-bold text-lg text-ink">Notifications</Text>
          <View className="h-10 w-10" />
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 48, gap: 12 }}
        refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => query.refetch()} tintColor={colors.primary} />}
      >
        {query.isError ? (
          <ErrorState message="Couldn't load notifications." onRetry={() => query.refetch()} />
        ) : rows.length === 0 && !query.isPending ? (
          <EmptyState icon="notifications-outline" title="No notifications" subtitle="Invites and game updates will show up here." />
        ) : (
          rows.map((row) => {
            const inviteId = typeof row.data.inviteId === 'string' ? row.data.inviteId : null;
            const isInvite = row.type === 'group_invite' && inviteId;
            return (
              <View key={row.id} className="gap-3 rounded-2xl border border-border bg-white p-4">
                <Text className="font-sans-bold text-sm text-ink">{row.title}</Text>
                {row.body ? <Text className="font-sans text-xs text-muted">{row.body}</Text> : null}
                <Text className="font-sans text-[10px] text-muted">{formatUkDate(row.createdAt)}</Text>
                {isInvite ? (
                  <View className="flex-row gap-2 pt-1">
                    <View className="flex-1">
                      <PrimaryButton label="Accept" loading={pending} onPress={() => void accept(inviteId)} />
                    </View>
                    <Pressable
                      disabled={pending}
                      onPress={() => void decline(inviteId)}
                      className="flex-1 items-center justify-center rounded-2xl border border-border py-4"
                    >
                      <Text className="font-sans-bold text-sm text-ink">Decline</Text>
                    </Pressable>
                  </View>
                ) : (row.data.type === 'motm_vote' || row.data.type === 'motm_result') &&
                  typeof row.data.gameId === 'string' ? (
                  <Pressable onPress={() => router.push(`/games/motm?gameId=${row.data.gameId as string}`)}>
                    <Text className="font-sans-bold text-xs text-primary">
                      {row.data.type === 'motm_vote' ? 'Vote for MOTM' : 'See MOTM'}
                    </Text>
                  </Pressable>
                ) : typeof row.data.gameId === 'string' ? (
                  <Pressable onPress={() => router.push(`/games/${row.data.gameId as string}`)}>
                    <Text className="font-sans-bold text-xs text-primary">View game</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })
        )}
        {error ? <Text className="font-sans-medium text-sm text-danger">{error}</Text> : null}
      </ScrollView>
    </View>
  );
}
