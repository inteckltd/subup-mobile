import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, PressableProps, Text } from 'react-native';

import { colors } from '../../../theme/tokens';

type PrimaryButtonProps = PressableProps & {
  label: string;
  loading?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  variant?: 'primary' | 'outline';
};

export function PrimaryButton({
  label,
  loading,
  icon,
  variant = 'primary',
  disabled,
  className,
  ...pressableProps
}: PrimaryButtonProps) {
  const isDisabled = disabled || loading;
  const isPrimary = variant === 'primary';

  return (
    <Pressable
      disabled={isDisabled}
      className={`w-full flex-row items-center justify-center gap-2 rounded-control py-4 ${
        isPrimary ? 'bg-primary' : 'border border-border bg-white'
      } ${isDisabled ? 'opacity-50' : ''} ${className ?? ''}`}
      {...pressableProps}
    >
      {loading ? (
        <ActivityIndicator color={isPrimary ? colors.white : colors.primary} />
      ) : (
        <>
          <Text className={`font-sans-bold text-base ${isPrimary ? 'text-white' : 'text-ink'}`}>{label}</Text>
          {icon ? <Ionicons name={icon} size={16} color={isPrimary ? colors.white : colors.ink} /> : null}
        </>
      )}
    </Pressable>
  );
}
