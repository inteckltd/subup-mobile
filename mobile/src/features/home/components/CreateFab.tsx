import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Animated, Easing, Pressable, Text, View } from 'react-native';

import { colors } from '../../../theme/tokens';

type CreateFabProps = {
  onCreateGame: () => void;
  onCreateGroup: () => void;
};

type ActionConfig = {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
};

const OPEN_DURATION = 260;
const CLOSE_DURATION = 200;
/** Fraction of `progress` each subsequent action waits before animating in, for a cascade effect. */
const STAGGER_STEP = 0.16;

/**
 * Speed-dial FAB — tapping "+" fans "Create Group"/"Create Game" out above
 * it with a staggered pop-in and morphs the icon into an "X", backed by a
 * tap-to-dismiss scrim. Uses plain `Animated` (not Reanimated) to match the
 * rest of the codebase's loading-state animations (see Skeleton.tsx).
 */
export function CreateFab({ onCreateGame, onCreateGroup }: CreateFabProps) {
  const [open, setOpen] = useState(false);
  const [progress] = useState(() => new Animated.Value(0));

  const setOpenState = (next: boolean) => {
    setOpen(next);
    Animated.timing(progress, {
      toValue: next ? 1 : 0,
      duration: next ? OPEN_DURATION : CLOSE_DURATION,
      easing: next ? Easing.out(Easing.back(1.4)) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start();
  };

  const runAction = (action: () => void) => {
    setOpenState(false);
    action();
  };

  const rotate = progress.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '45deg'] });
  const backdropOpacity = progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  const actions: ActionConfig[] = [
    { key: 'group', icon: 'people-outline', label: 'Create Group', onPress: onCreateGroup },
    { key: 'game', icon: 'calendar-outline', label: 'Create Game', onPress: onCreateGame },
  ];

  return (
    <>
      <Animated.View
        pointerEvents={open ? 'auto' : 'none'}
        style={{ opacity: backdropOpacity }}
        className="absolute inset-0 z-10"
      >
        <Pressable className="absolute inset-0 bg-ink/40" onPress={() => setOpenState(false)} />
      </Animated.View>

      <View className="absolute bottom-[108px] right-5 z-20 items-end gap-3" pointerEvents="box-none">
        {actions.map((action, index) => {
          const delay = index * STAGGER_STEP;
          const stepProgress = progress.interpolate({
            inputRange: [0, Math.max(delay, 0.001), 1],
            outputRange: [0, 0, 1],
            extrapolate: 'clamp',
          });
          const translateY = stepProgress.interpolate({ inputRange: [0, 1], outputRange: [16, 0] });
          const scale = stepProgress.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] });

          return (
            <Animated.View
              key={action.key}
              pointerEvents={open ? 'auto' : 'none'}
              style={{ opacity: stepProgress, transform: [{ translateY }, { scale }] }}
            >
              <Pressable
                onPress={() => runAction(action.onPress)}
                hitSlop={4}
                accessibilityLabel={action.label}
                className="flex-row items-center gap-3 rounded-full bg-white py-2 pl-2 pr-5"
                style={SOFT_SHADOW}
              >
                <View className="h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                  <Ionicons name={action.icon} size={20} color={colors.primary} />
                </View>
                <Text className="font-sans-bold text-sm text-ink">{action.label}</Text>
              </Pressable>
            </Animated.View>
          );
        })}

        <Pressable
          onPress={() => setOpenState(!open)}
          className="h-14 w-14 items-center justify-center rounded-2xl bg-accent"
          style={{ shadowColor: colors.accent, shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 8 } }}
        >
          <Animated.View style={{ transform: [{ rotate }] }}>
            <Ionicons name="add" size={26} color={colors.ink} />
          </Animated.View>
        </Pressable>
      </View>
    </>
  );
}

const SOFT_SHADOW = {
  shadowColor: colors.ink,
  shadowOpacity: 0.18,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 4 },
  elevation: 4,
};
