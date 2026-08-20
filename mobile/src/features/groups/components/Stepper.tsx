import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';

import { colors } from '../../../theme/tokens';

type StepperProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** e.g. pad to "07" — defaults to plain String(value). */
  formatValue?: (value: number) => string;
};

/**
 * Reusable `-`/`+` counter: gray pill container, two white rounded buttons
 * flanking a bold value — mirrors the Figma reference's Min/Max Players
 * counter (see get_design_context on the shared node). Wraps around
 * min/max rather than clamping, since it's used for hour (0-23) and minute
 * (0-55) values where wrapping feels natural.
 */
export function Stepper({ label, value, min, max, step = 1, formatValue, onChange }: StepperProps & { onChange: (next: number) => void }) {
  const range = max - min + 1;

  const decrement = () => {
    const next = ((value - min - step) % range + range) % range + min;
    onChange(next);
  };

  const increment = () => {
    const next = ((value - min + step) % range + range) % range + min;
    onChange(next);
  };

  return (
    <View className="items-center gap-2">
      <Text className="font-sans-bold text-xs text-muted">{label}</Text>
      <View className="flex-row items-center gap-3 rounded-xl bg-background p-1">
        <Pressable
          onPress={decrement}
          hitSlop={4}
          className="h-8 w-8 items-center justify-center rounded-lg bg-white"
          style={{ shadowColor: '#000000', shadowOpacity: 0.05, shadowRadius: 1, shadowOffset: { width: 0, height: 1 } }}
        >
          <Ionicons name="remove" size={16} color={colors.ink} />
        </Pressable>
        <Text className="w-10 text-center font-sans-bold text-base text-ink">{formatValue ? formatValue(value) : String(value)}</Text>
        <Pressable
          onPress={increment}
          hitSlop={4}
          className="h-8 w-8 items-center justify-center rounded-lg bg-white"
          style={{ shadowColor: '#000000', shadowOpacity: 0.05, shadowRadius: 1, shadowOffset: { width: 0, height: 1 } }}
        >
          <Ionicons name="add" size={16} color={colors.ink} />
        </Pressable>
      </View>
    </View>
  );
}
