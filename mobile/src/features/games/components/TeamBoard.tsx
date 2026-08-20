import { Ionicons } from '@expo/vector-icons';
import { useCallback, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

import { colors } from '../../../theme/tokens';
import type { GamePlayerModel } from '../types';
import { PlayerLobbyRow, type PlayerLayout } from './PlayerLobbyRow';

export type TeamColor = { id: string; label: string; hex: string };
type TeamId = 'home' | 'away';
type ZoneRect = { x: number; y: number; width: number; height: number };

function averageMmr(list: GamePlayerModel[]): number {
  if (list.length === 0) return 0;
  return Math.round(list.reduce((sum, player) => sum + player.mmr, 0) / list.length);
}

function pointInRect(x: number, y: number, rect: ZoneRect | null): boolean {
  if (!rect) return false;
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function highlightBorder(color: TeamColor, highlight: boolean): string {
  if (!highlight) return '#F3F4F6';
  return color.id === 'white' ? colors.ink : color.hex;
}

function highlightFill(color: TeamColor, highlight: boolean): string {
  if (!highlight) return colors.white;
  return color.id === 'white' ? '#F4F6F5' : `${color.hex}14`;
}

type DragActive = {
  player: GamePlayerModel;
  from: TeamId;
  width: number;
};

export function useTeamDrag(canDrag: boolean, onMove: (userId: string, team: TeamId) => void) {
  const homeZoneRef = useRef<View>(null);
  const awayZoneRef = useRef<View>(null);
  const zonesRef = useRef<{ home: ZoneRect | null; away: ZoneRect | null }>({ home: null, away: null });
  const touchOffsetRef = useRef({ x: 0, y: 0 });
  const originRef = useRef({ x: 0, y: 0 });
  const activeRef = useRef<DragActive | null>(null);
  const hoverRef = useRef<TeamId | null>(null);

  const [active, setActive] = useState<DragActive | null>(null);
  const [hover, setHover] = useState<TeamId | null>(null);

  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);
  const ghostOpacity = useSharedValue(0);

  const ghostStyle = useAnimatedStyle(() => ({
    opacity: ghostOpacity.value,
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
      { rotate: '1.2deg' },
    ],
  }));

  const measureZones = useCallback(() => {
    homeZoneRef.current?.measureInWindow((x, y, width, height) => {
      zonesRef.current.home = { x, y, width, height };
    });
    awayZoneRef.current?.measureInWindow((x, y, width, height) => {
      zonesRef.current.away = { x, y, width, height };
    });
  }, []);

  const hoverFromPoint = useCallback((pageX: number, pageY: number): TeamId | null => {
    if (pointInRect(pageX, pageY, zonesRef.current.away)) return 'away';
    if (pointInRect(pageX, pageY, zonesRef.current.home)) return 'home';
    return null;
  }, []);

  const begin = useCallback(
    (player: GamePlayerModel, from: TeamId, layout: PlayerLayout, pageX: number, pageY: number) => {
      if (!canDrag) return;
      touchOffsetRef.current = { x: pageX - layout.x, y: pageY - layout.y };
      originRef.current = { x: layout.x, y: layout.y };
      translateX.value = layout.x;
      translateY.value = layout.y;
      ghostOpacity.value = 1;
      scale.value = withSpring(1.05, { damping: 16, stiffness: 240 });
      const next = { player, from, width: layout.width };
      activeRef.current = next;
      hoverRef.current = from;
      setActive(next);
      setHover(from);
      measureZones();
    },
    [canDrag, ghostOpacity, measureZones, scale, translateX, translateY],
  );

  const move = useCallback(
    (pageX: number, pageY: number) => {
      if (!activeRef.current) return;
      if (!zonesRef.current.home || !zonesRef.current.away) measureZones();
      translateX.value = pageX - touchOffsetRef.current.x;
      translateY.value = pageY - touchOffsetRef.current.y;
      const nextHover = hoverFromPoint(pageX, pageY);
      if (nextHover !== hoverRef.current) {
        hoverRef.current = nextHover;
        setHover(nextHover);
      }
    },
    [hoverFromPoint, measureZones, translateX, translateY],
  );

  const end = useCallback(() => {
    const current = activeRef.current;
    if (!current) return;
    activeRef.current = null;
    const nextTeam = hoverRef.current;
    const moved = !!nextTeam && nextTeam !== current.from;
    if (moved && nextTeam && current.player.userId) {
      onMove(current.player.userId, nextTeam);
      scale.value = withTiming(0.97, { duration: 90 });
      ghostOpacity.value = withTiming(0, { duration: 90 });
      hoverRef.current = null;
      setActive(null);
      setHover(null);
      return;
    }
    translateX.value = withSpring(originRef.current.x, { damping: 18, stiffness: 260 });
    translateY.value = withSpring(originRef.current.y, { damping: 18, stiffness: 260 });
    scale.value = withSpring(1, { damping: 18, stiffness: 260 });
    ghostOpacity.value = withTiming(0, { duration: 180 });
    hoverRef.current = null;
    setHover(null);
    setTimeout(() => setActive(null), 200);
  }, [ghostOpacity, onMove, scale, translateX, translateY]);

  const onZoneLayout = useCallback((team: TeamId) => {
    const ref = team === 'home' ? homeZoneRef : awayZoneRef;
    ref.current?.measureInWindow((x, y, width, height) => {
      zonesRef.current[team] = { x, y, width, height };
    });
  }, []);

  return {
    canDrag,
    active,
    hover,
    homeZoneRef,
    awayZoneRef,
    scrollEnabled: !active,
    begin,
    move,
    end,
    onZoneLayout,
    ghostStyle,
  };
}

export type TeamDragController = ReturnType<typeof useTeamDrag>;

function PlayerList({
  players,
  dragTeam,
  draggingId,
  canDrag,
  onDragBegin,
  onDragMove,
  onDragEnd,
}: {
  players: GamePlayerModel[];
  dragTeam?: TeamId;
  draggingId?: string | null;
  canDrag: boolean;
  onDragBegin?: TeamDragController['begin'];
  onDragMove?: TeamDragController['move'];
  onDragEnd?: TeamDragController['end'];
}) {
  if (players.length === 0) return null;

  return (
    <View className="w-full overflow-hidden rounded-2xl bg-white/80">
      {players.map((player, index) => (
        <View key={player.id} style={{ opacity: player.id === draggingId ? 0 : 1 }}>
          <PlayerLobbyRow
            player={player}
            showDivider={index > 0}
            dragTeam={canDrag ? dragTeam : undefined}
            onDragBegin={canDrag ? onDragBegin : undefined}
            onDragMove={canDrag ? onDragMove : undefined}
            onDragEnd={canDrag ? onDragEnd : undefined}
          />
        </View>
      ))}
    </View>
  );
}

function TeamDropZone({
  color,
  players,
  team,
  highlighted,
  drag,
}: {
  color: TeamColor;
  players: GamePlayerModel[];
  team: TeamId;
  highlighted: boolean;
  drag: TeamDragController;
}) {
  const empty = players.length === 0;

  return (
    <View
      ref={team === 'home' ? drag.homeZoneRef : drag.awayZoneRef}
      collapsable={false}
      onLayout={() => drag.onZoneLayout(team)}
      className="w-full gap-3 rounded-[28px] p-4"
      style={{
        backgroundColor: highlightFill(color, highlighted),
        borderWidth: 1.5,
        borderColor: highlightBorder(color, highlighted),
      }}
    >
      <View className="flex-row items-center justify-between px-0.5">
        <View className="flex-row items-center gap-2">
          <View
            className="h-3 w-3 rounded-full"
            style={{ backgroundColor: color.hex, borderWidth: color.id === 'white' ? 1 : 0, borderColor: '#E5E7EB' }}
          />
          <Text className="font-sans-bold text-lg text-ink">{color.label}</Text>
          <View className="rounded-full bg-black/5 px-2 py-0.5">
            <Text className="font-sans-bold text-[10px] text-muted">{players.length}</Text>
          </View>
        </View>
        <View className="rounded-full bg-black/5 px-2.5 py-1">
          <Text className="font-sans-bold text-[10px] text-muted">Overall MMR {averageMmr(players)}</Text>
        </View>
      </View>

      {empty ? (
        <View
          className="min-h-[88px] items-center justify-center rounded-2xl border border-dashed px-4 py-6"
          style={{ borderColor: highlighted ? highlightBorder(color, true) : '#E5E7EB' }}
        >
          <Ionicons name={drag.canDrag ? 'add' : 'people-outline'} size={18} color={highlighted ? colors.ink : colors.muted} />
          <Text className="mt-1.5 font-sans-medium text-xs text-muted">
            {drag.canDrag ? `Drop on ${color.label}` : 'No players on this side yet.'}
          </Text>
        </View>
      ) : (
        <PlayerList
          players={players}
          dragTeam={team}
          draggingId={drag.active?.player.id}
          canDrag={drag.canDrag}
          onDragBegin={drag.begin}
          onDragMove={drag.move}
          onDragEnd={drag.end}
        />
      )}
    </View>
  );
}

export function TeamBoard({
  homeColor,
  awayColor,
  homePlayers,
  awayPlayers,
  drag,
}: {
  homeColor: TeamColor;
  awayColor: TeamColor;
  homePlayers: GamePlayerModel[];
  awayPlayers: GamePlayerModel[];
  drag: TeamDragController;
}) {
  return (
    <View className="w-full gap-4">
      {drag.canDrag ? (
        <View className="flex-row items-center gap-2 px-1">
          <Ionicons name="reorder-three" size={18} color={colors.muted} />
          <Text className="flex-1 font-sans text-xs text-muted">
            Drag the handle next to a player to move them to the other team.
          </Text>
        </View>
      ) : null}
      <TeamDropZone
        color={homeColor}
        players={homePlayers}
        team="home"
        highlighted={drag.hover === 'home'}
        drag={drag}
      />
      <TeamDropZone
        color={awayColor}
        players={awayPlayers}
        team="away"
        highlighted={drag.hover === 'away'}
        drag={drag}
      />
    </View>
  );
}

export function TeamDragOverlay({ drag }: { drag: TeamDragController }) {
  if (!drag.active) return null;

  return (
    <View pointerEvents="none" className="absolute inset-0 z-50">
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: 0,
            top: 0,
            width: drag.active.width,
          },
          drag.ghostStyle,
        ]}
      >
        <PlayerLobbyRow player={drag.active.player} elevated />
      </Animated.View>
    </View>
  );
}
