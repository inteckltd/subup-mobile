import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';

import { TEAM_COLORS, type TeamColorId } from '../schemas';
import { colors } from '../../../theme/tokens';

type TeamColorSelectorProps = {
  value: TeamColorId;
  onChange: (id: TeamColorId) => void;
};

/**
 * Row of colour swatches for picking a team's bib/kit colour on Create
 * Game (used twice — once for Home, once for Away). Selected swatch gets a
 * ring + checkmark; white gets a border since it'd otherwise disappear
 * against the card background.
 */
export function TeamColorSelector({ value, onChange }: TeamColorSelectorProps) {
  return (
    <View className="w-full flex-row flex-wrap gap-3">
      {TEAM_COLORS.map((color) => {
        const selected = color.id === value;
        return (
          <Pressable key={color.id} onPress={() => onChange(color.id)} className="items-center gap-1" hitSlop={4}>
            <View
              className="h-9 w-9 items-center justify-center rounded-full"
              style={{
                backgroundColor: color.hex,
                borderWidth: selected ? 2 : color.id === 'white' ? 1 : 0,
                borderColor: selected ? colors.primary : '#E5E7EB',
              }}
            >
              {selected ? <Ionicons name="checkmark" size={16} color={color.id === 'white' || color.id === 'yellow' ? '#111827' : '#FFFFFF'} /> : null}
            </View>
            <Text className={`font-sans-medium text-[10px] ${selected ? 'text-ink' : 'text-muted'}`}>{color.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
