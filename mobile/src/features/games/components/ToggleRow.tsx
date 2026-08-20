import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';

import { colors } from '../../../theme/tokens';

type ToggleRowProps = {
  icon: keyof typeof Ionicons.glyphMap;
  iconBg: string;
  iconColor: string;
  label: string;
  description?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  bordered?: boolean;
};

/**
 * Icon + label/description + pill switch row — mirrors the Figma
 * reference's "Allow waitlist" / "Allow cash payments" / "Auto-cancel"
 * rows exactly (icon tint per row, `bg-accent` pill when on, gray when
 * off, see get_design_context on node 39:170). No `Switch` component
 * exists in this codebase yet, so this is a plain `Pressable` styled to
 * match the reference precisely rather than RN's default `Switch` look.
 */
export function ToggleRow({ icon, iconBg, iconColor, label, description, value, onChange, bordered }: ToggleRowProps) {
  return (
    <View className={`w-full flex-row items-center justify-between py-3 ${bordered ? 'border-t border-[#F9FAFB]' : ''}`}>
      <View className="flex-1 flex-row items-center gap-3 pr-3">
        <View className="h-8 w-8 items-center justify-center rounded-lg" style={{ backgroundColor: iconBg }}>
          <Ionicons name={icon} size={15} color={iconColor} />
        </View>
        <View className="flex-1">
          <Text className="font-sans-bold text-sm text-ink">{label}</Text>
          {description ? <Text className="font-sans text-[10px] text-muted">{description}</Text> : null}
        </View>
      </View>
      <Pressable
        onPress={() => onChange(!value)}
        hitSlop={8}
        className="h-6 w-11 justify-center rounded-full p-1"
        style={{ backgroundColor: value ? colors.accent : '#E5E7EB', alignItems: value ? 'flex-end' : 'flex-start' }}
      >
        <View className="h-4 w-4 rounded-full bg-white" style={{ shadowColor: '#000000', shadowOpacity: 0.1, shadowRadius: 1 }} />
      </Pressable>
    </View>
  );
}
