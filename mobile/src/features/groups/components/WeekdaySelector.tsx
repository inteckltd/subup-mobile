import { Pressable, Text, View } from 'react-native';

import { WEEKDAYS } from '../schemas';

type WeekdaySelectorProps = {
  value: number;
  onChange: (value: number) => void;
};

/** Single-select day-of-week chip row for a group's regular meetup day. */
export function WeekdaySelector({ value, onChange }: WeekdaySelectorProps) {
  return (
    <View className="w-full flex-row flex-wrap gap-1.5">
      {WEEKDAYS.map((day) => {
        const selected = day.value === value;
        return (
          <Pressable
            key={day.value}
            onPress={() => onChange(day.value)}
            accessibilityRole="button"
            accessibilityLabel={day.name}
            accessibilityState={{ selected }}
            className={`min-h-11 min-w-[44px] grow basis-[12%] items-center justify-center rounded-xl px-1 py-2.5 ${selected ? 'bg-primary' : 'bg-background'}`}
          >
            <Text className={`font-sans-bold text-xs ${selected ? 'text-white' : 'text-muted'}`}>{day.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
