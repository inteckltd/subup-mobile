import { Pressable, Text, View } from 'react-native';

type SectionHeaderProps = {
  title: string;
  actionLabel?: string;
  onPressAction?: () => void;
  /** "pill" matches the Figma "Upcoming Games" header; "text" matches a plain text link. */
  actionVariant?: 'pill' | 'text';
};

export function SectionHeader({ title, actionLabel, onPressAction, actionVariant = 'text' }: SectionHeaderProps) {
  return (
    <View className="w-full flex-row items-center justify-between">
      <Text className="font-sans-bold text-lg text-ink">{title}</Text>
      {actionLabel && onPressAction ? (
        <Pressable
          onPress={onPressAction}
          hitSlop={8}
          className={actionVariant === 'pill' ? 'rounded-full bg-accent/20 px-3 py-1.5' : ''}
        >
          <Text className="font-sans-bold text-xs text-primary">{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
