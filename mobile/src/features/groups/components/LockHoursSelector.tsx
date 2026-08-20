import { Pressable, Text, View } from 'react-native';

import type { LockHours } from '../../../types/database';
import { LOCK_HOURS_OPTIONS } from '../schemas';

type LockHoursSelectorProps = {
  value: LockHours;
  onChange: (value: LockHours) => void;
};

/** Segmented 24h / 48h / 72h control for when games lock before kickoff. */
export function LockHoursSelector({ value, onChange }: LockHoursSelectorProps) {
  return (
    <View className="w-full gap-2">
      <Text className="font-sans-bold text-xs uppercase tracking-wider text-muted">Games lock before kickoff</Text>
      <View className="w-full flex-row rounded-2xl bg-white p-1">
        {LOCK_HOURS_OPTIONS.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              onPress={() => onChange(option.value)}
              className={`flex-1 items-center rounded-xl py-3 ${selected ? 'bg-primary' : ''}`}
            >
              <Text className={`font-sans-bold text-sm ${selected ? 'text-white' : 'text-muted'}`}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
