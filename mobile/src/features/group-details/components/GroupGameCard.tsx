import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';

import { formatFullDateLabel, formatUkTime } from '../../../lib/format';
import { colors } from '../../../theme/tokens';
import { Avatar } from '../../home/components/Avatar';
import type { GroupGameModel } from '../types';

type GroupGameCardProps = {
  game: GroupGameModel;
  onPress: () => void;
};

/**
 * Full-width game row on a group. The card and the View button both open
 * the game. Joining, paying, and leaving happen on that screen.
 */
export function GroupGameCard({ game, onPress }: GroupGameCardProps) {
  const percentFull = game.maxPlayers > 0 ? Math.min(game.spotsTaken / game.maxPlayers, 1) : 0;
  const venueLabel = [game.venueName, game.venueAddress].filter(Boolean).join(' · ');
  const overflowCount = Math.max(game.spotsTaken - game.previewPlayers.length, 0);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`View ${game.title || 'game'}`}
      className="w-full gap-3 rounded-[20px] bg-white p-4"
      style={{ shadowColor: '#0A1C15', shadowOpacity: 0.06, shadowRadius: 15, shadowOffset: { width: 0, height: 8 } }}
    >
      <View className="flex-row items-center justify-between">
        <Text className="font-sans-bold text-xs text-primary">{formatFullDateLabel(game.startsAt)}</Text>
        <View className="rounded-lg bg-background px-3 py-1.5">
          <Text className="font-sans-bold text-xs text-ink">{formatUkTime(game.startsAt)}</Text>
        </View>
      </View>

      <Text className="font-sans-bold text-lg text-ink" numberOfLines={2}>
        {game.title || 'Group game'}
      </Text>

      {venueLabel ? (
        <View className="flex-row items-center gap-1">
          <Ionicons name="location-outline" size={13} color={colors.muted} />
          <Text className="flex-1 font-sans text-xs text-muted" numberOfLines={1}>
            {venueLabel}
          </Text>
        </View>
      ) : null}

      <View className="flex-row items-center justify-between pt-1">
        <View className="min-w-0 flex-1 flex-row items-center pr-3">
          {game.previewPlayers.map((player, index) => (
            <View key={player.userId} style={{ marginLeft: index === 0 ? 0 : -10 }}>
              <Avatar uri={player.avatarUrl} name={player.name} size={28} ringColor={colors.white} ringWidth={2} />
            </View>
          ))}
          {overflowCount > 0 ? (
            <View
              className="items-center justify-center rounded-full bg-ink/10"
              style={{ width: 28, height: 28, marginLeft: game.previewPlayers.length > 0 ? -10 : 0 }}
            >
              <Text className="font-sans-bold text-[10px] text-ink">+{overflowCount}</Text>
            </View>
          ) : null}
          {game.hasJoined ? <Text className="ml-2 font-sans-bold text-xs text-primary">Joined</Text> : null}
        </View>

        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel="View game"
          className="min-h-11 items-center justify-center rounded-full bg-ink px-5"
        >
          <Text className="font-sans-bold text-sm text-white">View</Text>
        </Pressable>
      </View>

      <View className="gap-1.5">
        <Text className="font-sans text-xs text-ink">
          {game.spotsTaken}/{game.maxPlayers} spots filled
        </Text>
        <View className="h-1.5 w-full overflow-hidden rounded-full bg-ink/10">
          <View className="h-full rounded-full bg-accent" style={{ width: `${percentFull * 100}%` }} />
        </View>
      </View>
    </Pressable>
  );
}
