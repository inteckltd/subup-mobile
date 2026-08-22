import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Pressable, RefreshControl, Text, View } from 'react-native';
import { ScrollView, Swipeable } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '../../src/features/auth/components/PrimaryButton';
import { EmptyState } from '../../src/features/home/components/EmptyState';
import { ErrorState } from '../../src/features/home/components/ErrorState';
import {
  useDeleteNotification,
  useInviteActions,
  useMarkNotificationsRead,
  useMyNotifications,
} from '../../src/features/notifications/hooks';
import type { NotificationModel } from '../../src/features/notifications/types';
import { formatUkDate } from '../../src/lib/format';
import { colors } from '../../src/theme/tokens';

export default function NotificationsScreen() {
  const query = useMyNotifications();
  const markRead = useMarkNotificationsRead();
  const { accept, decline, pending, error: inviteError } = useInviteActions();
  const { remove, error: deleteError } = useDeleteNotification();
  const rows = query.data ?? [];
  const error = inviteError || deleteError;

  useEffect(() => {
    void markRead();
  }, [markRead]);

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
          rows.map((row) => (
            <NotificationRow
              key={row.id}
              row={row}
              pending={pending}
              onAccept={accept}
              onDecline={decline}
              onDelete={remove}
            />
          ))
        )}
        {error ? <Text className="font-sans-medium text-sm text-danger">{error}</Text> : null}
      </ScrollView>
    </View>
  );
}

type NotificationRowProps = {
  row: NotificationModel;
  pending: boolean;
  onAccept: (inviteId: string) => Promise<boolean>;
  onDecline: (inviteId: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
};

function NotificationRow({ row, pending, onAccept, onDecline, onDelete }: NotificationRowProps) {
  const deletingRef = useRef(false);
  const inviteId = typeof row.data.inviteId === 'string' ? row.data.inviteId : null;
  const isInvite = row.type === 'group_invite' && inviteId;

  const handleDelete = () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    void onDelete(row.id);
  };

  return (
    <Swipeable
      overshootRight={false}
      rightThreshold={96}
      onSwipeableOpen={(direction) => {
        if (direction === 'right') handleDelete();
      }}
      renderRightActions={() => (
        <Pressable
          onPress={handleDelete}
          accessibilityLabel="Delete notification"
          className="ml-3 items-center justify-center rounded-2xl bg-danger px-5"
        >
          <Text className="font-sans-bold text-sm text-white">Delete</Text>
        </Pressable>
      )}
    >
      <View className="gap-3 rounded-2xl border border-border bg-white p-4">
        <Text className="font-sans-bold text-sm text-ink">{row.title}</Text>
        {row.body ? <Text className="font-sans text-xs text-muted">{row.body}</Text> : null}
        <Text className="font-sans text-[10px] text-muted">{formatUkDate(row.createdAt)}</Text>
        {isInvite ? (
          <View className="flex-row gap-2 pt-1">
            <View className="flex-1">
              <PrimaryButton label="Accept" loading={pending} onPress={() => void onAccept(inviteId)} />
            </View>
            <Pressable
              disabled={pending}
              onPress={() => void onDecline(inviteId)}
              className="flex-1 items-center justify-center rounded-2xl border border-border py-4"
            >
              <Text className="font-sans-bold text-sm text-ink">Decline</Text>
            </Pressable>
          </View>
        ) : (row.data.type === 'motm_vote' || row.data.type === 'motm_result') && typeof row.data.gameId === 'string' ? (
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
    </Swipeable>
  );
}
