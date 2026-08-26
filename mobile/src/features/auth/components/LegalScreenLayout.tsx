import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '../../../theme/tokens';

type LegalScreenLayoutProps = {
  title: string;
  version: string;
  children: React.ReactNode;
};

export function LegalScreenLayout({ title, version, children }: LegalScreenLayoutProps) {
  const showBack = router.canGoBack();

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <View className="flex-row items-center gap-3 px-6 pb-2 pt-4">
        {showBack ? (
          <Pressable
            onPress={() => router.back()}
            className="h-10 w-10 items-center justify-center rounded-xl border border-border bg-white"
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="arrow-back" size={18} color={colors.ink} />
          </Pressable>
        ) : null}
        <Text className="font-sans-extrabold text-xl text-ink">{title}</Text>
      </View>
      <ScrollView className="flex-1 px-6" contentContainerClassName="gap-4 pb-10 pt-4">
        <Text className="font-sans-bold text-xs uppercase tracking-wider text-muted">Version {version}</Text>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}
