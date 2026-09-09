import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { formatPriceField, parsePricePounds, sanitizePriceInput } from '../schemas';

type PriceFieldProps = {
  value: number;
  onChange: (pounds: number) => void;
  onBlur: () => void;
};

export function PriceField({ value, onChange, onBlur }: PriceFieldProps) {
  const [text, setText] = useState(() => formatPriceField(value));

  useEffect(() => {
    if (parsePricePounds(text) !== value) {
      setText(formatPriceField(value));
    }
  }, [value, text]);

  return (
    <View className="w-full flex-row items-center rounded-xl bg-background px-4 py-3">
      <Text className="font-sans-bold text-base text-muted">£</Text>
      <TextInput
        className="ml-2 flex-1 font-sans-bold text-sm text-ink"
        style={{ includeFontPadding: false, padding: 0 }}
        keyboardType="decimal-pad"
        inputMode="decimal"
        autoCorrect={false}
        autoCapitalize="none"
        placeholder="0.00"
        placeholderTextColor="#D1D5DB"
        value={text}
        onChangeText={(next) => {
          const sanitized = sanitizePriceInput(next);
          setText(sanitized);
          onChange(parsePricePounds(sanitized));
        }}
        onBlur={() => {
          const pounds = parsePricePounds(text);
          setText(formatPriceField(pounds));
          onChange(pounds);
          onBlur();
        }}
      />
    </View>
  );
}
