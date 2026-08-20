import { Ionicons } from '@expo/vector-icons';
import { forwardRef, useState } from 'react';
import { Pressable, Text, TextInput, TextInputProps, View } from 'react-native';

import { colors } from '../../../theme/tokens';

type TextFieldProps = TextInputProps & {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  error?: string;
  /** Shows a tappable eye icon and toggles secureTextEntry — for password fields. */
  isPassword?: boolean;
};

export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  { label, icon, error, isPassword, secureTextEntry, multiline, ...inputProps },
  ref,
) {
  const [revealed, setRevealed] = useState(false);
  const hidden = isPassword ? !revealed : secureTextEntry;

  return (
    <View className="w-full gap-2">
      <Text className="font-sans-bold text-xs uppercase tracking-wider text-muted">{label}</Text>
      <View
        className={`w-full flex-row gap-3 rounded-control border bg-white px-4 py-4 ${multiline ? 'items-start' : 'items-center'} ${
          error ? 'border-danger' : 'border-border'
        }`}
      >
        <Ionicons name={icon} size={18} color={colors.muted} style={multiline ? { marginTop: 1 } : undefined} />
        <TextInput
          ref={ref}
          className="flex-1 font-sans-bold text-base text-ink"
          placeholderTextColor="#D1D5DB"
          secureTextEntry={hidden}
          multiline={multiline}
          textAlignVertical={multiline ? 'top' : undefined}
          // Android's multiline EditText carries its own built-in padding
          // (separate from font padding) that isn't accounted for by this
          // row's own px-4/py-4 — left unset, it stacks on top and pushes the
          // text/placeholder well below the icon. Zeroing it out here makes
          // the row's padding the only padding in play.
          style={multiline ? { minHeight: 72, includeFontPadding: false, padding: 0 } : { includeFontPadding: false, padding: 0 }}
          {...inputProps}
        />
        {isPassword ? (
          <Pressable onPress={() => setRevealed((prev) => !prev)} hitSlop={8}>
            <Ionicons name={revealed ? 'eye-off-outline' : 'eye-outline'} size={18} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>
      {error ? <Text className="font-sans-medium text-xs text-danger">{error}</Text> : null}
    </View>
  );
});
