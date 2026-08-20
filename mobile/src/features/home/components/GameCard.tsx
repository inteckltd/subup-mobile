import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';

import { formatGameDayLabel, formatGbp, formatUkTime } from '../../../lib/format';
import { colors } from '../../../theme/tokens';
import type { GameCardModel } from '../types';

type GameCardProps = {
  game: GameCardModel;
  onPress: () => void;
  onPressJoin: () => void;
};

export function GameCard({ game, onPress, onPressJoin }: GameCardProps) {
  const percentFull = game.maxPlayers > 0 ? Math.min(game.spotsTaken / game.maxPlayers, 1) : 0;
  const venueLabel = [game.venueName, game.venueAddress].filter(Boolean).join(' · ');

  return (
    <Pressable
      onPress={onPress}
      className="w-[260px] gap-1 rounded-[20px] bg-white p-4"
      style={{ shadowColor: '#0A1C15', shadowOpacity: 0.06, shadowRadius: 15, shadowOffset: { width: 0, height: 8 } }}
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-1.5 rounded-full bg-accent/20 px-2.5 py-1">
          <View className="h-1.5 w-1.5 rounded-full bg-primary" />
          <Text className="font-sans-bold text-[11px] text-primary">{formatGameDayLabel(game.startsAt)}</Text>
        </View>
        <Text className="font-sans text-xs text-muted">
          {formatUkTime(game.startsAt)} · {formatGbp(game.priceCents)}
        </Text>
      </View>

      <Text className="pt-2 font-sans-bold text-base text-ink" numberOfLines={1}>
        {game.title || game.groupName}
      </Text>

      {venueLabel ? (
        <View className="flex-row items-center gap-1">
          <Ionicons name="location-outline" size={12} color={colors.muted} />
          <Text className="flex-1 font-sans text-xs text-muted" numberOfLines={1}>
            {venueLabel}
          </Text>
        </View>
      ) : null}

      <View className="gap-1.5 pt-3">
        <View className="flex-row items-center justify-between">
          <Text className="font-sans text-xs text-ink">
            {game.spotsTaken}/{game.maxPlayers} spots
          </Text>
          <Text className="font-sans text-xs text-muted">
            {game.spotsLeft} left
          </Text>
        </View>
        <View className="h-1.5 w-full overflow-hidden rounded-full bg-ink/10">
          <View className="h-full rounded-full bg-accent" style={{ width: `${percentFull * 100}%` }} />
        </View>
      </View>

      <View className="flex-row items-center justify-between pt-3">
        <View className="flex-row items-center gap-1">
          <Ionicons name="people-outline" size={14} color={colors.muted} />
          <Text className="font-sans text-xs text-muted">{game.spotsTaken} joined</Text>
        </View>
        {game.hasJoined ? (
          <Pressable onPress={onPressJoin} className="flex-row items-center gap-1.5 rounded-full bg-accent/20 px-4 py-2">
            <Ionicons name="checkmark" size={14} color={colors.primary} />
            <Text className="font-sans-bold text-xs text-primary">Joined</Text>
          </Pressable>
        ) : (
          <Pressable onPress={onPressJoin} className="flex-row items-center gap-1.5 rounded-full bg-ink px-4 py-2">
            <Text className="font-sans-bold text-xs text-white">Join</Text>
            <Ionicons name="arrow-forward" size={12} color={colors.white} />
          </Pressable>
        )}
      </View>
    </Pressable>
  );
}
