import { Pressable, Text, View } from 'react-native';

import { WEEKDAYS } from '../schemas';

type WeekdaySelectorProps = {
  value: number;
  onChange: (value: number) => void;
};

/** Single-select day-of-week chip row for a group's regular meetup day. */
export function WeekdaySelector({ value, onChange }: WeekdaySelectorProps) {
  return (
    <View className="w-full flex-row justify-between gap-1.5">
      {WEEKDAYS.map((day) => {
        const selected = day.value === value;
        return (
          <Pressable
            key={day.value}
            onPress={() => onChange(day.value)}
            className={`flex-1 items-center rounded-xl py-2.5 ${selected ? 'bg-primary' : 'bg-background'}`}
          >
            <Text className={`font-sans-bold text-xs ${selected ? 'text-white' : 'text-muted'}`}>{day.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
