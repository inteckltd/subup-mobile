import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '../../../theme/tokens';
import type { Profile } from '../../../types';
import { useUnreadNotificationCount } from '../../notifications/hooks';
import { Avatar } from './Avatar';

type HomeHeaderProps = {
  profile: Profile | null;
  onPressNotifications: () => void;
  /** When omitted, the small avatar is not tappable (Profile). Home/Games pass navigate-to-Profile. */
  onPressSmallAvatar?: () => void;
  onPressLargeAvatar: () => void;
  onPressEdit?: () => void;
  onPressSettings?: () => void;
};

/**
 * The green hero header — wordmark, notifications/profile chrome, greeting,
 * and MMR chip. The PitchIn mark is not tappable. Small avatar goes to
 * Profile when `onPressSmallAvatar` is passed. Large avatar opens a photo
 * lightbox. Pass `onPressEdit` on Profile to show the pencil overlay.
 * Pass `onPressSettings` on Home, Games, and Profile for the gear.
 */
export function HomeHeader({
  profile,
  onPressNotifications,
  onPressSmallAvatar,
  onPressLargeAvatar,
  onPressEdit,
  onPressSettings,
}: HomeHeaderProps) {
  const insets = useSafeAreaInsets();
  const unreadCount = useUnreadNotificationCount();
  const firstName = profile?.full_name?.trim().split(' ')[0] || 'there';
  const unreadLabel = unreadCount > 9 ? '9+' : String(unreadCount);

  const smallAvatar = (
    <Avatar uri={profile?.avatar_url} name={profile?.full_name} size={40} ringColor={colors.accent} ringWidth={2} />
  );

  return (
    <View className="w-full gap-6 rounded-b-[40px] bg-primary px-6 pb-20" style={{ paddingTop: insets.top + 16 }}>
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <View className="h-8 w-8 -rotate-3 items-center justify-center rounded-lg bg-accent">
            <Ionicons name="people" size={18} color={colors.primary} />
          </View>
          <Text className="font-sans-extrabold text-xl uppercase tracking-tight text-white">PitchIn</Text>
        </View>

        <View className="flex-row items-center gap-3">
          <View>
            <Pressable
              onPress={onPressNotifications}
              hitSlop={8}
              accessibilityLabel={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
              className="h-10 w-10 items-center justify-center overflow-hidden rounded-full"
            >
              <BlurView intensity={30} tint="light" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
              <Ionicons name="notifications-outline" size={18} color={colors.white} />
            </Pressable>
            {unreadCount > 0 ? (
              <View
                pointerEvents="none"
                className="absolute -right-0.5 -top-0.5 min-h-[16px] min-w-[16px] items-center justify-center rounded-full bg-danger px-1"
              >
                <Text className="font-sans-extrabold text-[9px] text-white">{unreadLabel}</Text>
              </View>
            ) : null}
          </View>
          {onPressSettings ? (
            <Pressable
              onPress={onPressSettings}
              hitSlop={8}
              accessibilityLabel="Settings"
              className="h-10 w-10 items-center justify-center overflow-hidden rounded-full"
            >
              <BlurView intensity={30} tint="light" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
              <Ionicons name="settings-outline" size={18} color={colors.white} />
            </Pressable>
          ) : null}
          {onPressSmallAvatar ? (
            <Pressable onPress={onPressSmallAvatar} hitSlop={4} accessibilityLabel="Open profile">
              {smallAvatar}
            </Pressable>
          ) : (
            smallAvatar
          )}
        </View>
      </View>

      <View className="items-center gap-3">
        <View>
          <Pressable onPress={onPressLargeAvatar}>
            <Avatar uri={profile?.avatar_url} name={profile?.full_name} size={80} ringColor={colors.white} ringWidth={4} />
          </Pressable>
          {onPressEdit ? (
            <Pressable
              onPress={onPressEdit}
              hitSlop={8}
              accessibilityLabel="Edit profile"
              className="absolute -bottom-0.5 -right-0.5 h-7 w-7 items-center justify-center rounded-full border-2 border-primary bg-accent"
            >
              <Ionicons name="pencil" size={12} color={colors.primary} />
            </Pressable>
          ) : null}
        </View>
        <Text className="font-sans-bold text-xl text-white">Hey, {firstName}!</Text>
        <View className="overflow-hidden rounded-full border border-gold/30">
          <BlurView intensity={20} tint="light" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
          <View className="flex-row items-center gap-2 px-4 py-1.5">
            <Ionicons name="shield-checkmark-outline" size={13} color={colors.gold} />
            <Text className="font-sans-bold text-xs tracking-wide text-gold">MMR: {profile?.global_mmr ?? 1000}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}
