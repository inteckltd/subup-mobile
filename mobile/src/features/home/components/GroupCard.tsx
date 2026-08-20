import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';

import { colors } from '../../../theme/tokens';
import { sportIcon } from '../sportIcon';
import type { GroupCardModel } from '../types';

type GroupCardProps = {
  group: GroupCardModel;
  /** Alternates the icon tint like the Figma reference (accent / neutral / accent...). Purely decorative. */
  tintIndex: number;
  onPress: () => void;
};

export function GroupCard({ group, tintIndex, onPress }: GroupCardProps) {
  const isAccentTint = tintIndex % 2 === 0;

  return (
    <Pressable
      onPress={onPress}
      className="w-full flex-row items-center gap-4 rounded-2xl border border-border bg-white p-[17px]"
      style={{ shadowColor: '#0A1C15', shadowOpacity: 0.04, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } }}
    >
      <View
        className={`h-12 w-12 items-center justify-center rounded-xl ${isAccentTint ? 'bg-accent/20' : 'bg-ink/5'}`}
      >
        <Ionicons name={sportIcon(group.sport)} size={22} color={isAccentTint ? colors.primary : colors.ink} />
      </View>
      <View className="flex-1">
        <Text className="font-sans-bold text-sm text-ink" numberOfLines={1}>
          {group.name}
        </Text>
        <Text className="font-sans text-xs text-muted">
          {group.memberCount} {group.memberCount === 1 ? 'member' : 'members'}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={14} color={colors.muted} />
    </Pressable>
  );
}
