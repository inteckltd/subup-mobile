import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { sportIcon } from '../../home/sportIcon';
import { colors } from '../../../theme/tokens';
import type { GroupDetailModel } from '../types';

type GroupCoverHeaderProps = {
  group: GroupDetailModel;
  onPressBack: () => void;
  onPressMenu: () => void;
};

const COVER_HEIGHT = 340;

function sportLabel(sport: string): string {
  return sport.charAt(0).toUpperCase() + sport.slice(1);
}

/**
 * The cover-photo hero — placeholder tinted box + sport glyph when the group
 * has no `cover_image_url`, a bottom scrim so the overlaid text stays
 * legible over any photo, and the back/menu chrome mirrored from
 * `HomeHeader`'s blurred circle buttons.
 */
export function GroupCoverHeader({ group, onPressBack, onPressMenu }: GroupCoverHeaderProps) {
  const insets = useSafeAreaInsets();
  const isAdmin = group.role === 'admin';

  return (
    <View style={{ height: COVER_HEIGHT }} className="w-full overflow-hidden">
      {group.coverImageUrl ? (
        <Image source={{ uri: group.coverImageUrl }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
      ) : (
        <View className="h-full w-full items-center justify-center bg-ink">
          <Ionicons name={sportIcon(group.sport)} size={72} color="rgba(255,255,255,0.25)" />
        </View>
      )}

      <LinearGradient
        colors={['rgba(10,20,16,0)', 'rgba(10,20,16,0.55)', 'rgba(10,20,16,0.9)']}
        locations={[0, 0.55, 1]}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />

      <View
        className="absolute left-5 right-5 flex-row items-center justify-between"
        style={{ top: insets.top + 8 }}
      >
        <Pressable
          onPress={onPressBack}
          hitSlop={8}
          className="h-10 w-10 items-center justify-center overflow-hidden rounded-full"
        >
          <BlurView intensity={30} tint="dark" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
          <Ionicons name="chevron-back" size={20} color={colors.white} />
        </Pressable>

        <Pressable
          onPress={onPressMenu}
          hitSlop={8}
          className="h-10 w-10 items-center justify-center overflow-hidden rounded-full"
        >
          <BlurView intensity={30} tint="dark" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
          <Ionicons name="ellipsis-vertical" size={18} color={colors.white} />
        </Pressable>
      </View>

      <View className="absolute bottom-0 left-0 right-0 gap-2 px-5 pb-10">
        <View className="flex-row items-center gap-2">
          <View className={`rounded-full px-2.5 py-1 ${isAdmin ? 'bg-accent' : 'bg-white/25'}`}>
            <Text className={`font-sans-bold text-[10px] uppercase tracking-wide ${isAdmin ? 'text-ink' : 'text-white'}`}>
              {isAdmin ? 'Admin' : 'Member'}
            </Text>
          </View>
          <Text className="font-sans-medium text-xs text-white/90">
            {sportLabel(group.sport)} · {group.memberCount} {group.memberCount === 1 ? 'Member' : 'Members'}
          </Text>
        </View>
        <Text className="font-sans-extrabold text-3xl text-white" numberOfLines={2}>
          {group.name}
        </Text>
        <Text className="font-sans text-xs text-white/80">Games lock {group.lockHours}h before kickoff</Text>
      </View>
    </View>
  );
}
