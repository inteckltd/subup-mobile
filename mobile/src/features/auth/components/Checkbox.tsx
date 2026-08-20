import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';

type CheckboxProps = {
  checked: boolean;
  onToggle: () => void;
  children: React.ReactNode;
};

export function Checkbox({ checked, onToggle, children }: CheckboxProps) {
  return (
    <Pressable className="w-full flex-row items-center gap-3 py-2" onPress={onToggle} hitSlop={4}>
      <View
        className={`h-5 w-5 items-center justify-center rounded-md border-2 ${
          checked ? 'border-primary bg-primary' : 'border-border bg-white'
        }`}
      >
        {checked ? <Ionicons name="checkmark" size={13} color="#FFFFFF" /> : null}
      </View>
      <View className="flex-1">{children}</View>
    </Pressable>
  );
}
