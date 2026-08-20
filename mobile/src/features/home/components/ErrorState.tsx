import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';

import { colors } from '../../../theme/tokens';

type ErrorStateProps = {
  message: string;
  onRetry: () => void;
};

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <View className="w-full items-center gap-3 rounded-2xl border border-border bg-white px-6 py-8">
      <Ionicons name="alert-circle-outline" size={22} color={colors.danger} />
      <Text className="text-center font-sans text-xs text-muted">{message}</Text>
      <Pressable onPress={onRetry} className="rounded-full bg-ink px-4 py-2">
        <Text className="font-sans-bold text-xs text-white">Try again</Text>
      </Pressable>
    </View>
  );
}
