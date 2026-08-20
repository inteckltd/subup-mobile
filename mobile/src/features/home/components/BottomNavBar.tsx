import { Ionicons } from '@expo/vector-icons';
import { router, usePathname } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '../../../theme/tokens';

type NavItem = {
  key: 'home' | 'games' | 'profile';
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  href: '/' | '/games' | '/profile';
};

const ITEMS: NavItem[] = [
  { key: 'home', label: 'Home', icon: 'home', href: '/' },
  { key: 'games', label: 'Games', icon: 'calendar-outline', href: '/games' },
  { key: 'profile', label: 'Profile', icon: 'person-outline', href: '/profile' },
];

function activeKeyFromPath(pathname: string): NavItem['key'] {
  if (pathname === '/games' || pathname.startsWith('/games/')) return 'games';
  if (pathname === '/profile' || pathname.startsWith('/profile/')) return 'profile';
  return 'home';
}

type BottomNavBarProps = {
  /** Override the route-derived active tab (e.g. group details highlighting Games). */
  activeKey?: NavItem['key'];
};

export function BottomNavBar({ activeKey }: BottomNavBarProps) {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const resolvedKey = activeKey ?? activeKeyFromPath(pathname);

  return (
    <View
      className="absolute bottom-0 left-0 right-0 flex-row justify-between border-t border-border bg-white px-6 pt-3"
      style={{ paddingBottom: Math.max(insets.bottom, 12) }}
    >
      {ITEMS.map((item) => {
        const isActive = item.key === resolvedKey;
        return (
          <Pressable
            key={item.key}
            onPress={() => {
              if (item.href === pathname) return;
              router.replace(item.href);
            }}
            className="items-center gap-1 px-2"
          >
            <Ionicons name={item.icon} size={20} color={isActive ? colors.ink : colors.muted} />
            <Text className={`font-sans${isActive ? '-bold' : ''} text-[11px] ${isActive ? 'text-ink' : 'text-muted'}`}>
              {item.label}
            </Text>
            {isActive ? <View className="h-1 w-1 rounded-full bg-accent" /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}
