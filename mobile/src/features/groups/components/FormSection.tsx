import { Text, View } from 'react-native';

type FormSectionProps = {
  title: string;
  children: React.ReactNode;
};

/**
 * Uppercase muted section label + white rounded card wrapper — mirrors the
 * Figma reference's "GAME DETAILS" / "PLAYER SLOTS & RULES" card pattern
 * (see get_design_context on the shared node, "Create New Game" frame).
 */
export function FormSection({ title, children }: FormSectionProps) {
  return (
    <View className="w-full gap-4">
      <Text className="px-1 font-sans-bold text-[10px] uppercase tracking-wider text-muted">{title}</Text>
      <View
        className="w-full gap-4 rounded-2xl bg-white p-4"
        style={{ shadowColor: '#000000', shadowOpacity: 0.05, shadowRadius: 1, shadowOffset: { width: 0, height: 1 } }}
      >
        {children}
      </View>
    </View>
  );
}
