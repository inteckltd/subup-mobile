import { useEffect, useRef, useState } from 'react';
import { type AccessibilityActionEvent, PanResponder, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { colors } from '../../../theme/tokens';

const THUMB = 30;
const TRACK_HEIGHT = 10;
const HIT_HEIGHT = 48;
const MIN = 0;
const MAX = 10;
const TRACK_TINT = 'rgba(3,36,136,0.10)';

type StepSliderProps = {
  label: string;
  prompt: string;
  lowLabel: string;
  highLabel: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
};

function clampStep(raw: number): number {
  return Math.min(MAX, Math.max(MIN, Math.round(raw)));
}

/**
 * 0–10 whole-step slider in the SubUp palette: navy fill, cyan thumb, ink
 * labels. The fill and thumb spring to each step and the big number pops when
 * it changes. Plain PanResponder + Reanimated, no slider dependency.
 */
export function StepSlider({ label, prompt, lowLabel, highLabel, value, onChange, disabled = false }: StepSliderProps) {
  const [trackWidth, setTrackWidth] = useState(0);
  const containerRef = useRef<View>(null);
  const leftRef = useRef(0);
  const widthRef = useRef(0);
  const propsRef = useRef({ onChange, disabled, value });
  propsRef.current = { onChange, disabled, value };

  const progress = useSharedValue(value / MAX);
  const pop = useSharedValue(1);
  const thumbScale = useSharedValue(1);
  const width = useSharedValue(0);

  useEffect(() => {
    progress.value = withSpring(value / MAX, { damping: 16, stiffness: 220, mass: 0.7 });
    pop.value = withSequence(withTiming(1.22, { duration: 90 }), withSpring(1, { damping: 10, stiffness: 260 }));
  }, [value, progress, pop]);

  useEffect(() => {
    width.value = trackWidth;
    widthRef.current = trackWidth;
  }, [trackWidth, width]);

  function setFromPageX(pageX: number) {
    const usable = widthRef.current - THUMB;
    if (usable <= 0 || propsRef.current.disabled) return;
    const step = clampStep(((pageX - leftRef.current - THUMB / 2) / usable) * MAX);
    if (step !== propsRef.current.value) propsRef.current.onChange(step);
  }

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !propsRef.current.disabled,
      onMoveShouldSetPanResponder: () => !propsRef.current.disabled,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        const { pageX } = event.nativeEvent;
        thumbScale.value = withSpring(1.15, { damping: 14, stiffness: 260 });
        containerRef.current?.measureInWindow((x) => {
          leftRef.current = x;
          setFromPageX(pageX);
        });
      },
      onPanResponderMove: (event) => setFromPageX(event.nativeEvent.pageX),
      onPanResponderRelease: () => {
        thumbScale.value = withSpring(1, { damping: 14, stiffness: 260 });
      },
      onPanResponderTerminate: () => {
        thumbScale.value = withSpring(1, { damping: 14, stiffness: 260 });
      },
    }),
  ).current;

  const fillStyle = useAnimatedStyle(() => ({
    width: THUMB / 2 + progress.value * Math.max(width.value - THUMB, 0),
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: progress.value * Math.max(width.value - THUMB, 0) },
      { scale: thumbScale.value },
    ],
  }));
  const numberStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));

  function onAccessibilityAction(event: AccessibilityActionEvent) {
    if (disabled) return;
    if (event.nativeEvent.actionName === 'increment') onChange(clampStep(value + 1));
    if (event.nativeEvent.actionName === 'decrement') onChange(clampStep(value - 1));
  }

  return (
    <View className="gap-4 rounded-3xl border border-border bg-white p-5">
      <View className="flex-row items-start justify-between gap-4">
        <View className="min-w-0 flex-1 gap-1">
          <Text className="font-sans-bold text-[10px] uppercase tracking-wide text-muted">{label}</Text>
          <Text className="font-sans-bold text-base text-ink">{prompt}</Text>
        </View>
        <Animated.View style={numberStyle}>
          <Text className="font-sans-extrabold text-4xl text-primary">{value}</Text>
        </Animated.View>
      </View>

      <View
        ref={containerRef}
        onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
        {...panResponder.panHandlers}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={prompt}
        accessibilityValue={{ min: MIN, max: MAX, now: value, text: `${value} out of ${MAX}` }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={onAccessibilityAction}
        style={{ height: HIT_HEIGHT, justifyContent: 'center', opacity: disabled ? 0.5 : 1 }}
      >
        <View style={{ height: TRACK_HEIGHT, borderRadius: TRACK_HEIGHT / 2, backgroundColor: TRACK_TINT, overflow: 'hidden' }}>
          <Animated.View style={[{ height: TRACK_HEIGHT, borderRadius: TRACK_HEIGHT / 2, backgroundColor: colors.primary }, fillStyle]} />
        </View>
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              left: 0,
              top: (HIT_HEIGHT - THUMB) / 2,
              width: THUMB,
              height: THUMB,
              borderRadius: THUMB / 2,
              backgroundColor: colors.accent,
              borderWidth: 3,
              borderColor: colors.primary,
            },
            thumbStyle,
          ]}
        />
      </View>

      <View className="flex-row justify-between gap-4">
        <Text className="min-w-0 flex-1 font-sans text-[11px] text-muted">0 · {lowLabel}</Text>
        <Text className="min-w-0 flex-1 text-right font-sans text-[11px] text-muted">10 · {highLabel}</Text>
      </View>
    </View>
  );
}
