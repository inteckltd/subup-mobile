import { useEffect, useState } from 'react';
import { Animated, View, ViewStyle } from 'react-native';

type SkeletonProps = {
  width?: number | `${number}%`;
  height: number;
  radius?: number;
  style?: ViewStyle;
};

/** A pulsing placeholder box for loading states — plain Animated (no reanimated needed for a simple opacity loop). */
export function Skeleton({ width = '100%', height, radius = 12, style }: SkeletonProps) {
  // Lazy useState (not useRef) so the mutable Animated.Value is never read
  // via `.current` during render — react-hooks/refs flags that pattern.
  const [opacity] = useState(() => new Animated.Value(0.4));

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[{ width, height, borderRadius: radius, backgroundColor: 'rgba(10,28,21,0.08)', opacity }, style]}
    />
  );
}

export function GroupCardSkeleton() {
  return (
    <View className="w-full flex-row items-center gap-4 rounded-2xl border border-border bg-white p-[17px]">
      <Skeleton width={48} height={48} radius={12} />
      <View className="flex-1 gap-2">
        <Skeleton width="60%" height={14} radius={4} />
        <Skeleton width="40%" height={12} radius={4} />
      </View>
    </View>
  );
}

export function GameCardSkeleton() {
  return (
    <View className="h-[220px] w-[260px] gap-3 rounded-[20px] bg-white p-4">
      <View className="flex-row justify-between">
        <Skeleton width={70} height={22} radius={999} />
        <Skeleton width={50} height={16} radius={4} />
      </View>
      <Skeleton width="80%" height={18} radius={4} />
      <Skeleton width="60%" height={14} radius={4} />
      <Skeleton width="100%" height={6} radius={999} />
      <View className="flex-row justify-between pt-2">
        <Skeleton width={60} height={14} radius={4} />
        <Skeleton width={64} height={32} radius={999} />
      </View>
    </View>
  );
}

/** Full-width variant of `GameCardSkeleton` for the Group Details Upcoming tab. */
export function GroupGameCardSkeleton() {
  return (
    <View className="w-full gap-3 rounded-[20px] bg-white p-4">
      <View className="flex-row justify-between">
        <Skeleton width={110} height={14} radius={4} />
        <Skeleton width={56} height={24} radius={8} />
      </View>
      <Skeleton width="70%" height={20} radius={4} />
      <Skeleton width="50%" height={14} radius={4} />
      <View className="flex-row items-center justify-between pt-1">
        <Skeleton width={70} height={28} radius={999} />
        <Skeleton width={90} height={32} radius={999} />
      </View>
      <Skeleton width="100%" height={6} radius={999} />
    </View>
  );
}

/** Matches `MemberCard`'s dimensions for the Members/Active Members loading state. */
export function MemberCardSkeleton() {
  return (
    <View className="flex-1 flex-row items-center gap-3 rounded-2xl border border-border bg-white p-3">
      <Skeleton width={44} height={44} radius={22} />
      <View className="flex-1 gap-2">
        <Skeleton width="70%" height={13} radius={4} />
        <Skeleton width="40%" height={11} radius={4} />
      </View>
    </View>
  );
}
