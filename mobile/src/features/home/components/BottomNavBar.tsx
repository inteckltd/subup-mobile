import { Ionicons } from '@expo/vector-icons';
import { router, usePathname, type Href } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '../../../theme/tokens';

type NavItem = {
  key: 'home' | 'groups' | 'games' | 'profile';
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  href: Href;
};

const ITEMS: NavItem[] = [
  { key: 'home', label: 'Home', icon: 'home', href: '/' },
  { key: 'groups', label: 'My Groups', icon: 'people-outline', href: '/groups' as Href },
  { key: 'games', label: 'My Games', icon: 'calendar-outline', href: '/games' },
  { key: 'profile', label: 'Profile', icon: 'person-outline', href: '/profile' },
];

function activeKeyFromPath(pathname: string): NavItem['key'] {
  if (pathname === '/groups' || pathname.startsWith('/groups/') || pathname.startsWith('/group/')) return 'groups';
  if (pathname === '/games' || pathname.startsWith('/games/')) return 'games';
  if (pathname === '/profile' || pathname.startsWith('/profile/')) return 'profile';
  return 'home';
}

type BottomNavBarProps = {
  /** Override the route-derived active tab (e.g. group details highlighting My Groups). */
  activeKey?: NavItem['key'];
};

export function BottomNavBar({ activeKey }: BottomNavBarProps) {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const resolvedKey = activeKey ?? activeKeyFromPath(pathname);

  return (
    <View
      className="absolute bottom-0 left-0 right-0 flex-row border-t border-border bg-white px-2 pt-3"
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
            className="flex-1 items-center gap-1 px-1"
          >
            <Ionicons name={item.icon} size={20} color={isActive ? colors.ink : colors.muted} />
            <Text
              numberOfLines={1}
              className={`font-sans${isActive ? '-bold' : ''} text-[10px] ${isActive ? 'text-ink' : 'text-muted'}`}
            >
              {item.label}
            </Text>
            {isActive ? <View className="h-1 w-1 rounded-full bg-accent" /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}
