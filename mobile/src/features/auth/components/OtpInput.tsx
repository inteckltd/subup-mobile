import { useRef } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

const LENGTH = 6;

type OtpInputProps = {
  value: string;
  onChange: (value: string) => void;
  error?: string;
};

export function OtpInput({ value, onChange, error }: OtpInputProps) {
  const inputRef = useRef<TextInput>(null);
  const digits = value.replace(/\D/g, '').slice(0, LENGTH);

  return (
    <View className="w-full gap-2">
      <Text className="font-sans-bold text-xs uppercase tracking-wider text-muted">Code</Text>
      <Pressable onPress={() => inputRef.current?.focus()} className="flex-row justify-between">
        {Array.from({ length: LENGTH }, (_, index) => (
          <View
            key={index}
            className={`h-14 w-12 items-center justify-center rounded-control border bg-white ${
              error ? 'border-danger' : 'border-border'
            }`}
          >
            <Text className="font-sans-bold text-xl text-ink">{digits[index] ?? ''}</Text>
          </View>
        ))}
      </Pressable>
      <TextInput
        ref={inputRef}
        value={digits}
        onChangeText={(next) => onChange(next.replace(/\D/g, '').slice(0, LENGTH))}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        maxLength={LENGTH}
        autoFocus
        caretHidden
        className="absolute h-px w-px opacity-0"
      />
      {error ? <Text className="font-sans-medium text-sm text-danger">{error}</Text> : null}
    </View>
  );
}
