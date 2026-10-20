import { Ionicons } from '@expo/vector-icons';
import { Text, View } from 'react-native';

const GOLD_TINT = 'rgba(242,193,78,0.18)';
const GOLD_TEXT = '#B45309';

/** Gold MMR pill for a group rating (group cards, Profile). */
export function RatingPill({ mmr }: { mmr: number }) {
  return (
    <View
      className="flex-row items-center gap-1.5 rounded-full px-3 py-1"
      style={{ backgroundColor: GOLD_TINT }}
      accessibilityLabel={`Group rating ${mmr}`}
    >
      <Ionicons name="shield-checkmark-outline" size={12} color={GOLD_TEXT} />
      <Text className="font-sans-bold text-xs" style={{ color: GOLD_TEXT }}>
        {mmr.toLocaleString('en-GB')}
      </Text>
    </View>
  );
}
