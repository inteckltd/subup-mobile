import { Ionicons } from '@expo/vector-icons';
import { useRef } from 'react';
import { PanResponder, Pressable, Text, View } from 'react-native';

import { Avatar } from '../../home/components/Avatar';
import { colors } from '../../../theme/tokens';
import type { GamePlayerModel } from '../types';

function MmrDeltaBadge({ delta }: { delta: number }) {
  if (delta > 0) {
    return (
      <View className="flex-row items-center gap-0.5">
        <Ionicons name="arrow-up" size={14} color={colors.primary} />
        <Text className="font-sans-bold text-xs text-primary">+{delta}</Text>
      </View>
    );
  }
  if (delta < 0) {
    return (
      <View className="flex-row items-center gap-0.5">
        <Ionicons name="arrow-down" size={14} color={colors.danger} />
        <Text className="font-sans-bold text-xs text-danger">{Math.abs(delta)}</Text>
      </View>
    );
  }
  return <View className="h-[2px] w-6 rounded-full bg-[#D1D5DB]" />;
}

function paymentBadge(status: GamePlayerModel['paymentStatus']): { label: string; bg: string; color: string } {
  switch (status) {
    case 'paid':
      return { label: 'PAID', bg: 'rgba(11,110,79,0.1)', color: '#0B6E4F' };
    case 'pending':
      return { label: 'PAYING', bg: '#FEF3C7', color: '#B45309' };
    case 'refunded':
      return { label: 'REFUNDED', bg: '#F3F4F6', color: '#6B7280' };
    default:
      return { label: 'UNPAID', bg: '#FEF2F2', color: '#EF4444' };
  }
}

export type PlayerLayout = { x: number; y: number; width: number; height: number };

type PlayerLobbyRowProps = {
  player: GamePlayerModel;
  showDivider?: boolean;
  onPress?: () => void;
  /** Standalone lifted card used while dragging. */
  elevated?: boolean;
  /** When set, shows a grab handle next to the avatar and starts a drag from it. */
  dragTeam?: 'home' | 'away';
  onDragBegin?: (
    player: GamePlayerModel,
    team: 'home' | 'away',
    layout: PlayerLayout,
    pageX: number,
    pageY: number,
  ) => void;
  onDragMove?: (pageX: number, pageY: number) => void;
  onDragEnd?: () => void;
};

/** One row in the lobby player list: avatar, name, MMR subtitle, payment chip or post-MOTM delta. */
export function PlayerLobbyRow({
  player,
  showDivider = false,
  onPress,
  elevated = false,
  dragTeam,
  onDragBegin,
  onDragMove,
  onDragEnd,
}: PlayerLobbyRowProps) {
  const payment = paymentBadge(player.paymentStatus);
  const rowRef = useRef<View>(null);
  const dragRef = useRef({ player, dragTeam, onDragBegin, onDragMove, onDragEnd });
  dragRef.current = { player, dragTeam, onDragBegin, onDragMove, onDragEnd };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !!dragRef.current.onDragBegin,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        const { pageX, pageY } = event.nativeEvent;
        rowRef.current?.measureInWindow((x, y, width, height) => {
          const current = dragRef.current;
          if (!current.dragTeam || !current.onDragBegin) return;
          current.onDragBegin(current.player, current.dragTeam, { x, y, width, height }, pageX, pageY);
        });
      },
      onPanResponderMove: (event) => {
        dragRef.current.onDragMove?.(event.nativeEvent.pageX, event.nativeEvent.pageY);
      },
      onPanResponderRelease: () => dragRef.current.onDragEnd?.(),
      onPanResponderTerminate: () => dragRef.current.onDragEnd?.(),
    }),
  ).current;

  const showHandle = !!onDragBegin || elevated;

  const content = (
    <>
      <View className="min-w-0 flex-1 flex-row items-center gap-3 pr-3">
        {showHandle ? (
          <View
            {...(onDragBegin ? panResponder.panHandlers : {})}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            className="h-10 w-7 items-center justify-center"
            accessibilityRole="adjustable"
            accessibilityLabel={`Move ${player.name} to the other team`}
            pointerEvents={elevated ? 'none' : 'auto'}
          >
            <Ionicons name="reorder-three" size={22} color={colors.muted} />
          </View>
        ) : null}
        <Avatar uri={player.avatarUrl} name={player.name} size={40} />
        <View className="min-w-0 flex-1">
          <Text className="font-sans-bold text-sm text-ink" numberOfLines={1}>
            {player.name}
          </Text>
          <Text className="font-sans text-[10px] text-muted">MMR {player.mmr}</Text>
        </View>
      </View>
      <View className="flex-row items-center gap-1.5">
        {player.isWaitlisted ? (
          <View className="rounded px-2 py-1 bg-[#FEF3C7]">
            <Text className="font-sans-bold text-[10px] uppercase tracking-wide text-[#B45309]">Waitlist</Text>
          </View>
        ) : player.mmrDelta !== null ? (
          <MmrDeltaBadge delta={player.mmrDelta} />
        ) : player.paymentStatus === 'paid' || player.paymentStatus === 'pending' ? (
          <View className="rounded px-2 py-1" style={{ backgroundColor: payment.bg }}>
            <Text className="font-sans-bold text-[10px] uppercase tracking-wide" style={{ color: payment.color }}>
              {payment.label}
            </Text>
          </View>
        ) : null}
      </View>
    </>
  );

  const rowClass = elevated
    ? 'w-full flex-row items-center justify-between rounded-2xl bg-white px-3 py-3.5'
    : `w-full flex-row items-center justify-between px-4 py-4 ${showDivider ? 'border-t border-[#F9FAFB]' : ''}`;

  if (onPress && !onDragBegin) {
    return (
      <Pressable onPress={onPress} className={rowClass}>
        {content}
      </Pressable>
    );
  }

  return (
    <View
      ref={rowRef}
      collapsable={false}
      className={rowClass}
      style={
        elevated
          ? {
              shadowColor: '#000000',
              shadowOpacity: 0.18,
              shadowRadius: 18,
              shadowOffset: { width: 0, height: 10 },
              elevation: 12,
            }
          : undefined
      }
    >
      {content}
    </View>
  );
}
