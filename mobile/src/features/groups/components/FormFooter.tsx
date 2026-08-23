import { View } from 'react-native';
import { KeyboardStickyView, useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type FormFooterProps = {
  children: React.ReactNode;
};

/**
 * Submit bar that stays at the viewport bottom and rides above the keyboard.
 */
export function FormFooter({ children }: FormFooterProps) {
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  return (
    <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
      <View
        className="border-t border-border bg-white px-4 pt-4"
        style={{ paddingBottom: keyboardVisible ? 12 : Math.max(insets.bottom, 24) }}
      >
        {children}
      </View>
    </KeyboardStickyView>
  );
}
