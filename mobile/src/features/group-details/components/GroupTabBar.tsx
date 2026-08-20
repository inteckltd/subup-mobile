import { Pressable, Text, View } from 'react-native';

export type GroupTabKey = 'upcoming' | 'members' | 'history';

const TABS: { key: GroupTabKey; label: string }[] = [
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'members', label: 'Members' },
  { key: 'history', label: 'History' },
];

type GroupTabBarProps = {
  activeTab: GroupTabKey;
  onChangeTab: (tab: GroupTabKey) => void;
};

/** In-screen tab switcher (no routing) — bold primary text + underline for the active tab, muted otherwise. */
export function GroupTabBar({ activeTab, onChangeTab }: GroupTabBarProps) {
  return (
    <View className="w-full flex-row border-b border-border px-5">
      {TABS.map((tab) => {
        const isActive = tab.key === activeTab;
        return (
          <Pressable key={tab.key} onPress={() => onChangeTab(tab.key)} className="mr-6 items-center gap-2 pb-3 pt-1">
            <Text className={`font-sans-bold text-sm ${isActive ? 'text-primary' : 'text-muted'}`}>{tab.label}</Text>
            <View className={`h-[2px] w-full rounded-full ${isActive ? 'bg-primary' : 'bg-transparent'}`} />
          </Pressable>
        );
      })}
    </View>
  );
}
