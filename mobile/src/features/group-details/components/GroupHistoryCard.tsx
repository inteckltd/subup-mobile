import { Pressable, Text, View } from 'react-native';

import { formatUkDate } from '../../../lib/format';
import { teamColorById } from '../../games/schemas';
import type { GroupHistoryModel } from '../types';

type GroupHistoryCardProps = {
  game: GroupHistoryModel;
  onPress: () => void;
};

/** Completed-game row for the History tab: two colour dots, score, date. */
export function GroupHistoryCard({ game, onPress }: GroupHistoryCardProps) {
  const home = teamColorById(game.homeColor);
  const away = teamColorById(game.awayColor);

  return (
    <Pressable
      onPress={onPress}
      className="w-full flex-row items-center justify-between rounded-[20px] bg-white p-4"
      style={{ shadowColor: '#0A1C15', shadowOpacity: 0.06, shadowRadius: 15, shadowOffset: { width: 0, height: 8 } }}
    >
      <View className="flex-1 gap-1 pr-3">
        <Text className="font-sans-bold text-sm text-ink" numberOfLines={1}>
          {game.title || 'Group game'}
        </Text>
        <Text className="font-sans text-xs text-muted">{formatUkDate(game.startsAt)}</Text>
      </View>
      <View className="flex-row items-center gap-2">
        <View
          className="h-3 w-3 rounded-full"
          style={{ backgroundColor: home.hex, borderWidth: home.id === 'white' ? 1 : 0, borderColor: '#E5E7EB' }}
        />
        <Text className="font-sans-bold text-base text-ink">
          {game.scoreHome ?? '—'}–{game.scoreAway ?? '—'}
        </Text>
        <View
          className="h-3 w-3 rounded-full"
          style={{ backgroundColor: away.hex, borderWidth: away.id === 'white' ? 1 : 0, borderColor: '#E5E7EB' }}
        />
      </View>
    </Pressable>
  );
}
