import { Text, Pressable, View } from 'react-native';

import { Avatar } from '../../home/components/Avatar';
import type { GroupMemberModel } from '../types';

type MemberCardProps = {
  member: GroupMemberModel;
  /** Shows a small "Admin" tag next to the name — used on the full Members tab, not the Upcoming preview. */
  showRoleBadge?: boolean;
  /**
   * Grow to fill a 2-column row (Upcoming "Active Members" preview).
   * Leave off on the Members tab — `flex-1` in a column shrinks the cards
   * when the Invited section below remounts (e.g. after cancelling an SMS invite).
   */
  fillRow?: boolean;
  onPress?: () => void;
};

/**
 * Shared card design for both the Upcoming tab's "Active Members" preview
 * grid and the full Members tab list — avatar + name + MMR.
 */
export function MemberCard({ member, showRoleBadge = false, fillRow = false, onPress }: MemberCardProps) {
  const content = (
    <>
      <Avatar uri={member.avatarUrl} name={member.name} size={44} />
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-1.5">
          <Text className="min-w-0 flex-1 font-sans-bold text-sm text-ink" numberOfLines={1}>
            {member.name}
          </Text>
          {showRoleBadge && member.role === 'admin' ? (
            <View className="shrink-0 rounded-full bg-accent/20 px-1.5 py-0.5">
              <Text className="font-sans-bold text-[9px] uppercase text-primary">Admin</Text>
            </View>
          ) : null}
        </View>
        <Text className="font-sans text-xs text-muted">{member.mmr} MMR</Text>
      </View>
    </>
  );

  const layoutClass = fillRow
    ? 'flex-1 flex-row items-center gap-3 rounded-2xl border border-border bg-white p-3'
    : 'w-full flex-row items-center gap-3 rounded-2xl border border-border bg-white p-3';

  if (onPress) {
    return (
      <Pressable onPress={onPress} className={layoutClass}>
        {content}
      </Pressable>
    );
  }

  return <View className={layoutClass}>{content}</View>;
}
