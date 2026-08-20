import { useState } from 'react';
import { LayoutChangeEvent, Pressable, Text, View } from 'react-native';

import { DURATION_OPTIONS } from '../schemas';

type DurationSelectorProps = {
  value: number;
  onChange: (minutes: number) => void;
};

const COLUMNS = 4;
const GAP = 8;

/**
 * Equal-width chip grid (4 per row) of preset game durations — same
 * selected/unselected visual language as WeekdaySelector. Pill width is
 * measured off the container's own layout rather than a percentage
 * className, so every pill — including the shorter final row (7 options ->
 * 4 + 3) — is exactly the same width regardless of label length ("30 min"
 * vs "1 hr").
 */
export function DurationSelector({ value, onChange }: DurationSelectorProps) {
  const [containerWidth, setContainerWidth] = useState(0);
  const pillWidth = containerWidth > 0 ? (containerWidth - GAP * (COLUMNS - 1)) / COLUMNS : undefined;

  const onLayout = (event: LayoutChangeEvent) => {
    setContainerWidth(event.nativeEvent.layout.width);
  };

  return (
    <View className="w-full flex-row flex-wrap" style={{ gap: GAP }} onLayout={onLayout}>
      {DURATION_OPTIONS.map((option) => {
        const selected = option.minutes === value;
        return (
          <Pressable
            key={option.minutes}
            onPress={() => onChange(option.minutes)}
            className={`items-center justify-center rounded-xl py-2.5 ${selected ? 'bg-primary' : 'bg-background'}`}
            style={pillWidth ? { width: pillWidth } : undefined}
          >
            <Text className={`font-sans-bold text-xs ${selected ? 'text-white' : 'text-muted'}`}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
