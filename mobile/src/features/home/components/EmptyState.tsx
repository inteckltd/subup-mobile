import { Ionicons } from '@expo/vector-icons';
import { Text, View } from 'react-native';

import { colors } from '../../../theme/tokens';

type EmptyStateProps = {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
};

export function EmptyState({ icon, title, subtitle }: EmptyStateProps) {
  return (
    <View className="w-full items-center gap-2 rounded-2xl border border-border bg-white px-6 py-8">
      <View className="h-12 w-12 items-center justify-center rounded-full bg-background">
        <Ionicons name={icon} size={22} color={colors.muted} />
      </View>
      <Text className="text-center font-sans-bold text-sm text-ink">{title}</Text>
      <Text className="text-center font-sans text-xs text-muted">{subtitle}</Text>
    </View>
  );
}
