import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';

import { colors } from '../../../theme/tokens';
import type { SetupProgress } from '../progress';

type SetupChecklistProps = {
  progress: SetupProgress;
  onDismiss: () => void;
  onCreateGroup: () => void;
  onInvite: () => void;
  onScheduleGame: () => void;
};

type Step = {
  key: 'group' | 'invite' | 'game';
  title: string;
  subtitle: string;
  done: boolean;
  onPress: () => void;
};

export function SetupChecklist({ progress, onDismiss, onCreateGroup, onInvite, onScheduleGame }: SetupChecklistProps) {
  const steps: Step[] = [
    {
      key: 'group',
      title: 'Create a group',
      subtitle: 'Your squad, venue, and regular night',
      done: progress.createdGroup,
      onPress: onCreateGroup,
    },
    {
      key: 'invite',
      title: 'Invite your squad',
      subtitle: 'Send an invite — we text them a download link if they are new',
      done: progress.invitedSquad,
      onPress: onInvite,
    },
    {
      key: 'game',
      title: 'Schedule a game',
      subtitle: 'One match under your group',
      done: progress.scheduledGame,
      onPress: onScheduleGame,
    },
  ];

  return (
    <View className="w-full gap-4 rounded-2xl border border-border bg-white p-4">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-1">
          <Text className="font-sans-bold text-sm text-ink">Get your squad going</Text>
          <Text className="font-sans text-xs text-muted">Three steps to organise your first game. You can skip this anytime.</Text>
        </View>
        <Pressable onPress={onDismiss} hitSlop={8} className="h-8 w-8 items-center justify-center rounded-full bg-background">
          <Ionicons name="close" size={16} color={colors.muted} />
        </Pressable>
      </View>

      <View className="gap-1">
        {steps.map((step) => (
          <Pressable
            key={step.key}
            onPress={step.done ? undefined : step.onPress}
            disabled={step.done}
            className="flex-row items-center gap-3 rounded-xl px-1 py-2.5"
          >
            <View
              className={`h-8 w-8 items-center justify-center rounded-full ${
                step.done ? 'bg-primary' : 'border border-border bg-background'
              }`}
            >
              <Ionicons
                name={step.done ? 'checkmark' : 'ellipse-outline'}
                size={14}
                color={step.done ? colors.white : colors.muted}
              />
            </View>
            <View className="flex-1">
              <Text className={`font-sans-bold text-sm ${step.done ? 'text-muted' : 'text-ink'}`}>{step.title}</Text>
              <Text className="font-sans text-xs text-muted">{step.subtitle}</Text>
            </View>
            {step.done ? null : <Ionicons name="chevron-forward" size={14} color={colors.muted} />}
          </Pressable>
        ))}
      </View>
    </View>
  );
}
