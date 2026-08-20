import { Pressable, Text, View } from 'react-native';

import type { SportType } from '../../../types/database';
import { SPORT_OPTIONS } from '../schemas';

type SportSelectorProps = {
  value: SportType;
  onChange: (value: SportType) => void;
};

export function SportSelector({ value, onChange }: SportSelectorProps) {
  return (
    <View className="w-full gap-2">
      <Text className="font-sans-bold text-xs uppercase tracking-wider text-muted">Sport</Text>
      <View className="w-full flex-row flex-wrap gap-2">
        {SPORT_OPTIONS.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              onPress={() => onChange(option.value)}
              className={`rounded-full px-3 py-2 ${selected ? 'bg-primary' : 'bg-white'}`}
            >
              <Text className={`font-sans-bold text-xs ${selected ? 'text-white' : 'text-muted'}`}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
