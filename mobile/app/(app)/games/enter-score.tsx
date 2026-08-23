import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '../../../src/features/auth/components/PrimaryButton';
import { TextField } from '../../../src/features/auth/components/TextField';
import { useGameDetail, useSubmitGameScore } from '../../../src/features/games/hooks';
import { teamColorById } from '../../../src/features/games/schemas';
import { FormFooter } from '../../../src/features/groups/components/FormFooter';
import { Stepper } from '../../../src/features/groups/components/Stepper';
import { ErrorState } from '../../../src/features/home/components/ErrorState';
import { formatDurationLabel, formatFullDateLabel, hasGameEnded } from '../../../src/lib/format';
import { useUnsavedChangesGuard } from '../../../src/lib/useUnsavedChangesGuard';
import { colors } from '../../../src/theme/tokens';

/**
 * Score entry screen — any group admin (not just the game's creator) can
 * reach this once a game has finished, either via the Game Details "Enter
 * Score" CTA or by tapping a `score_reminder` push notification (which
 * deep-links to Game Details itself, see notificationResponse.ts; the CTA
 * there is what actually routes here). Guards mirror `submit_game_score`'s
 * own server-side checks (admin, game ended, not already scored) — this is
 * defence in depth only, the RPC is the real enforcement.
 */
export default function EnterScoreScreen() {
  const { gameId } = useLocalSearchParams<{ gameId: string }>();
  const gameQuery = useGameDetail(gameId);
  const { submit, submitting, error: submitError } = useSubmitGameScore(gameId);

  const [scoreHome, setScoreHome] = useState(0);
  const [scoreAway, setScoreAway] = useState(0);
  const [notes, setNotes] = useState('');
  const isDirty = scoreHome !== 0 || scoreAway !== 0 || notes.trim().length > 0;
  const { allowLeave } = useUnsavedChangesGuard(isDirty);

  if (gameQuery.isPending) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (gameQuery.isError || !gameQuery.data) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background px-8" edges={['top', 'bottom']}>
        <ErrorState message="Couldn't load this game. Pull to refresh or try again." onRetry={() => gameQuery.refetch()} />
        <PrimaryButton label="Back" className="mt-6 w-auto px-8" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  const game = gameQuery.data;
  const homeColor = teamColorById(game.homeColor);
  const awayColor = teamColorById(game.awayColor);
  const canScore = game.isAdmin && game.status !== 'completed' && game.status !== 'cancelled' && hasGameEnded(game.startsAt, game.durationMinutes);

  const onSubmit = async () => {
    const ok = await submit(scoreHome, scoreAway, notes);
    if (ok) {
      allowLeave();
      router.replace(`/games/${game.id}`);
    }
  };

  return (
    <View className="flex-1 bg-background">
      <SafeAreaView edges={['top']} className="bg-white">
        <View className="w-full flex-row items-center gap-4 border-b border-border px-4 py-4">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            className="h-10 w-10 items-center justify-center rounded-full bg-background"
          >
            <Ionicons name="close" size={18} color={colors.ink} />
          </Pressable>
          <Text className="font-sans-bold text-lg text-ink" style={{ includeFontPadding: false }}>
            Enter Score
          </Text>
        </View>
      </SafeAreaView>

      {!canScore ? (
        <View className="flex-1 items-center justify-center gap-4 px-8">
          <Ionicons name="lock-closed-outline" size={28} color={colors.muted} />
          <Text className="text-center font-sans-bold text-sm text-muted">
            {game.status === 'completed'
              ? 'A score has already been entered for this game.'
              : "You can enter the score once the game has finished — and only group admins can."}
          </Text>
          <PrimaryButton label="Back" className="w-auto px-8" onPress={() => router.back()} />
        </View>
      ) : (
        <View className="flex-1">
          <KeyboardAwareScrollView
            style={{ flex: 1 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            bottomOffset={88}
            contentContainerStyle={{ padding: 20, paddingBottom: 24, gap: 20 }}
          >
            <View className="w-full gap-1 rounded-2xl bg-white p-4" style={{ shadowColor: '#000000', shadowOpacity: 0.05, shadowRadius: 1, shadowOffset: { width: 0, height: 1 } }}>
              <Text className="font-sans-bold text-xs uppercase tracking-wider text-muted">{game.groupName}</Text>
              <Text className="font-sans-bold text-base text-ink">{formatFullDateLabel(game.startsAt)}</Text>
              <Text className="font-sans text-xs text-muted">
                {formatDurationLabel(game.durationMinutes)} game{game.venueName ? ` at ${game.venueName}` : ''}
              </Text>
            </View>

            <View className="w-full flex-row items-center justify-center gap-6 rounded-2xl bg-white p-4" style={{ shadowColor: '#000000', shadowOpacity: 0.05, shadowRadius: 1, shadowOffset: { width: 0, height: 1 } }}>
              <View className="flex-1 items-center gap-2">
                <View className="h-4 w-4 rounded-full" style={{ backgroundColor: homeColor.hex, borderWidth: homeColor.id === 'white' ? 1 : 0, borderColor: '#E5E7EB' }} />
                <Text className="font-sans-bold text-xs text-muted">{homeColor.label}</Text>
                <Stepper label="" value={scoreHome} min={0} max={50} onChange={setScoreHome} />
              </View>
              <Text className="font-sans-bold text-lg text-muted">–</Text>
              <View className="flex-1 items-center gap-2">
                <View className="h-4 w-4 rounded-full" style={{ backgroundColor: awayColor.hex, borderWidth: awayColor.id === 'white' ? 1 : 0, borderColor: '#E5E7EB' }} />
                <Text className="font-sans-bold text-xs text-muted">{awayColor.label}</Text>
                <Stepper label="" value={scoreAway} min={0} max={50} onChange={setScoreAway} />
              </View>
            </View>

            <TextField
              label="Notes (optional)"
              icon="document-text-outline"
              placeholder="e.g. Man of the match, notable moments"
              multiline
              numberOfLines={3}
              value={notes}
              onChangeText={setNotes}
            />

            {submitError ? <Text className="font-sans-medium text-sm text-danger">{submitError}</Text> : null}
          </KeyboardAwareScrollView>
          <FormFooter>
            <PrimaryButton label="Save Score" loading={submitting} onPress={onSubmit} />
          </FormFooter>
        </View>
      )}
    </View>
  );
}
