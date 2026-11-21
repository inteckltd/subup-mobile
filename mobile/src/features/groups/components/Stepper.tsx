import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';

import { colors } from '../../../theme/tokens';

type StepperProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /**
   * Clock fields wrap (23 → 00). Scores and player counts stop at the ends
   * so one extra tap cannot jump from 0 to 50.
   */
  wrap?: boolean;
  /** e.g. pad to "07" — defaults to plain String(value). */
  formatValue?: (value: number) => string;
  onChange: (next: number) => void;
};

function wrapped(value: number, min: number, max: number, delta: number): number {
  const range = max - min + 1;
  return ((value - min + delta) % range + range) % range + min;
}

/** Minus / plus counter. Buttons are 44 points so they are easy to tap. */
export function Stepper({ label, value, min, max, step = 1, wrap = false, formatValue, onChange }: StepperProps) {
  const atMin = value <= min;
  const atMax = value >= max;
  const decreaseLabel = label ? `Decrease ${label}` : 'Decrease';
  const increaseLabel = label ? `Increase ${label}` : 'Increase';

  const decrement = () => {
    if (!wrap && atMin) return;
    onChange(wrap ? wrapped(value, min, max, -step) : Math.max(min, value - step));
  };

  const increment = () => {
    if (!wrap && atMax) return;
    onChange(wrap ? wrapped(value, min, max, step) : Math.min(max, value + step));
  };

  return (
    <View className="items-center gap-2">
      {label ? <Text className="font-sans-bold text-xs text-muted">{label}</Text> : null}
      <View className="flex-row items-center gap-3 rounded-xl bg-background p-1">
        <Pressable
          onPress={decrement}
          disabled={!wrap && atMin}
          accessibilityRole="button"
          accessibilityLabel={decreaseLabel}
          accessibilityState={{ disabled: !wrap && atMin }}
          className={`h-11 w-11 items-center justify-center rounded-lg bg-white ${!wrap && atMin ? 'opacity-40' : ''}`}
          style={{ shadowColor: '#000000', shadowOpacity: 0.05, shadowRadius: 1, shadowOffset: { width: 0, height: 1 } }}
        >
          <Ionicons name="remove" size={18} color={colors.ink} />
        </Pressable>
        <Text className="w-10 text-center font-sans-bold text-base text-ink">{formatValue ? formatValue(value) : String(value)}</Text>
        <Pressable
          onPress={increment}
          disabled={!wrap && atMax}
          accessibilityRole="button"
          accessibilityLabel={increaseLabel}
          accessibilityState={{ disabled: !wrap && atMax }}
          className={`h-11 w-11 items-center justify-center rounded-lg bg-white ${!wrap && atMax ? 'opacity-40' : ''}`}
          style={{ shadowColor: '#000000', shadowOpacity: 0.05, shadowRadius: 1, shadowOffset: { width: 0, height: 1 } }}
        >
          <Ionicons name="add" size={18} color={colors.ink} />
        </Pressable>
      </View>
    </View>
  );
}
