import { Ionicons } from '@expo/vector-icons';
import { router, useNavigation } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton } from '../../src/features/auth/components/PrimaryButton';
import { markExplainerSeen } from '../../src/features/onboarding/storage';
import { useAuth } from '../../src/providers/AuthProvider';
import { colors } from '../../src/theme/tokens';

const PAGES = [
  {
    icon: 'people-outline' as const,
    title: 'A group is your squad',
    body: "It's the people you play with — a regular venue, a usual night, and who gets invited to games.",
  },
  {
    icon: 'calendar-outline' as const,
    title: 'A game is one match',
    body: 'Schedule a kickoff under your group. Players join, you play, then you log the score.',
  },
  {
    icon: 'person-add-outline' as const,
    title: 'Invite by mobile',
    body: 'Send an invite to a UK mobile number. If they don\'t have PitchIn yet, they get a text with a download link.',
  },
];

export default function OnboardingScreen() {
  const { session } = useAuth();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [page, setPage] = useState(0);
  const last = page === PAGES.length - 1;
  const current = PAGES[page]!;

  useEffect(() => {
    const userId = session?.user.id;
    if (!userId) return;
    const unsubscribe = navigation.addListener('beforeRemove', () => {
      void markExplainerSeen(userId);
    });
    return unsubscribe;
  }, [navigation, session?.user.id]);

  async function finish(openCreateGroup: boolean) {
    if (session?.user.id) await markExplainerSeen(session.user.id);
    if (router.canDismiss()) router.dismiss();
    else router.back();
    if (openCreateGroup) {
      setTimeout(() => router.push('/create-group'), 0);
    }
  }

  return (
    <View className="flex-1 bg-background">
      <SafeAreaView edges={['top']} className="bg-background">
        <View className="w-full flex-row items-center justify-between px-4 py-4">
          <Pressable
            onPress={() => void finish(false)}
            hitSlop={8}
            className="h-10 w-10 items-center justify-center rounded-full bg-white"
          >
            <Ionicons name="close" size={18} color={colors.ink} />
          </Pressable>
          <Pressable onPress={() => void finish(false)} hitSlop={8} className="px-3 py-2">
            <Text className="font-sans-bold text-sm text-muted">Skip</Text>
          </Pressable>
        </View>
      </SafeAreaView>

      <View className="flex-1 items-center justify-center px-8">
        <View className="h-20 w-20 items-center justify-center rounded-3xl bg-accent/30">
          <Ionicons name={current.icon} size={36} color={colors.primary} />
        </View>
        <Text className="mt-8 text-center font-sans-extrabold text-3xl tracking-tight text-ink">{current.title}</Text>
        <Text className="mt-3 text-center font-sans text-base text-muted">{current.body}</Text>
      </View>

      <View className="flex-row items-center justify-center gap-2 pb-6">
        {PAGES.map((item, index) => (
          <View
            key={item.title}
            className={`h-2 rounded-full ${index === page ? 'w-6 bg-primary' : 'w-2 bg-border'}`}
          />
        ))}
      </View>

      <View className="border-t border-border bg-white px-4 pt-4" style={{ paddingBottom: Math.max(insets.bottom, 24) }}>
        <PrimaryButton
          label={last ? 'Get started' : 'Next'}
          onPress={() => {
            if (last) {
              void finish(true);
              return;
            }
            setPage((currentPage) => currentPage + 1);
          }}
        />
      </View>
    </View>
  );
}
