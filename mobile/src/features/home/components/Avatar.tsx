import { Image } from 'expo-image';
import { Text, View } from 'react-native';

import { colors } from '../../../theme/tokens';

type AvatarProps = {
  uri?: string | null;
  name?: string | null;
  size: number;
  ringColor?: string;
  ringWidth?: number;
};

function getInitials(name?: string | null): string {
  if (!name) return '?';
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return initials || '?';
}

/**
 * expo-image's `Image` doesn't respond to NativeWind `className` (see
 * PLAN.md "NativeWind gotcha") — sized entirely via inline `style` here,
 * which also lets `size` be a dynamic prop rather than a fixed class.
 */
export function Avatar({ uri, name, size, ringColor, ringWidth = 0 }: AvatarProps) {
  const containerStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    borderWidth: ringWidth,
    borderColor: ringColor,
    overflow: 'hidden' as const,
    backgroundColor: colors.ink,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };

  return (
    <View style={containerStyle}>
      {uri ? (
        <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
      ) : (
        <Text style={{ color: colors.white, fontSize: size * 0.36, fontWeight: '700' }}>{getInitials(name)}</Text>
      )}
    </View>
  );
}
