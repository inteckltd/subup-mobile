import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';

import { colors } from '../../../theme/tokens';

type GroupActionButtonsProps = {
  onPressCreateGame: () => void;
  onPressInvite: () => void;
};

/**
 * Admin-only "Create Game" / "Invite" pair — rendered with a negative
 * top margin by the caller so it visually straddles the cover photo's
 * bottom edge, matching the Figma reference.
 */
export function GroupActionButtons({ onPressCreateGame, onPressInvite }: GroupActionButtonsProps) {
  return (
    <View
      className="flex-row gap-3 px-5"
      style={{ shadowColor: '#0A1C15', shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } }}
    >
      <Pressable
        onPress={onPressCreateGame}
        className="flex-1 flex-row items-center justify-center gap-2 rounded-2xl bg-primary py-3.5"
      >
        <Ionicons name="add-circle-outline" size={18} color={colors.white} />
        <Text className="font-sans-bold text-sm text-white">Create Game</Text>
      </Pressable>

      <Pressable
        onPress={onPressInvite}
        className="flex-1 flex-row items-center justify-center gap-2 rounded-2xl border border-border bg-white py-3.5"
      >
        <Ionicons name="person-add-outline" size={18} color={colors.ink} />
        <Text className="font-sans-bold text-sm text-ink">Invite</Text>
      </Pressable>
    </View>
  );
}
