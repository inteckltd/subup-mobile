import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '../../../src/features/auth/components/PrimaryButton';
import { useGroupDetail } from '../../../src/features/group-details/hooks';
import {
  fetchGroupInvitePreview,
  joinQuestionsError,
  saveMembershipAnswers,
  type GroupInvitePreview,
} from '../../../src/features/join-questions/api';
import { StepSlider } from '../../../src/features/join-questions/components/StepSlider';
import { useMembershipAnswers } from '../../../src/features/join-questions/hooks';
import {
  DEFAULT_JOIN_ANSWERS,
  joinQuestionsFor,
  type JoinAnswers,
  type JoinQuestionId,
} from '../../../src/features/join-questions/questions';
import { acceptGroupInvite } from '../../../src/features/notifications/api';
import { useAuth } from '../../../src/providers/AuthProvider';
import { colors } from '../../../src/theme/tokens';

/**
 * Join questions. Two entry points:
 *   ?inviteId=…  Accept on an invite. Join creates the membership and stores the locked answers together.
 *   ?groupId=…   Save for a membership that still needs answers (e.g. a group the caller just created).
 * Nothing is saved until the button succeeds. Leaving the screen any other way keeps the invite pending.
 */
export default function JoinQuestionsScreen() {
  const { inviteId, groupId: groupIdParam } = useLocalSearchParams<{ inviteId?: string; groupId?: string }>();
  const mode: 'join' | 'save' = inviteId ? 'join' : 'save';
  const { session } = useAuth();
  const queryClient = useQueryClient();

  const [preview, setPreview] = useState<GroupInvitePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(mode === 'join');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<JoinAnswers>(DEFAULT_JOIN_ANSWERS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveGroupId = mode === 'save' ? groupIdParam : undefined;
  const answersQuery = useMembershipAnswers(saveGroupId);
  const groupQuery = useGroupDetail(saveGroupId);

  useEffect(() => {
    if (mode !== 'join' || !inviteId) return;
    let cancelled = false;
    void (async () => {
      const result = await fetchGroupInvitePreview(inviteId);
      if (cancelled) return;
      if (result.error) setPreviewError(result.error);
      else if (!result.preview) setPreviewError('This invite is no longer pending');
      else setPreview(result.preview);
      setPreviewLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, inviteId]);

  // Save mode with nothing left to answer (already locked, or not a member): go to the group.
  useEffect(() => {
    if (mode !== 'save' || !saveGroupId || !answersQuery.isSuccess) return;
    if (!answersQuery.data?.needsAnswers) router.replace(`/group/${saveGroupId}`);
  }, [mode, saveGroupId, answersQuery.isSuccess, answersQuery.data]);

  const sport = mode === 'join' ? preview?.sport : answersQuery.data?.sport;
  const questions = sport ? joinQuestionsFor(sport) : null;
  const groupId = mode === 'join' ? preview?.groupId : saveGroupId;
  const groupName = mode === 'join' ? preview?.groupName : groupQuery.data?.name;

  const loading = mode === 'join' ? previewLoading : answersQuery.isPending;
  const loadError = mode === 'join' ? previewError : answersQuery.isError ? "Couldn't load this group." : null;

  function setAnswer(id: JoinQuestionId, value: number) {
    setAnswers((current) => ({ ...current, [id]: value }));
  }

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  async function onSubmit() {
    if (submitting || !groupId) return;
    setError(null);
    setSubmitting(true);
    try {
      const result =
        mode === 'join' && inviteId
          ? await acceptGroupInvite(inviteId, questions ? answers : undefined)
          : await saveMembershipAnswers(groupId, answers);
      if (result.error) {
        setError(result.error);
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['notifications'] }),
        queryClient.invalidateQueries({ queryKey: ['home'] }),
        queryClient.invalidateQueries({ queryKey: ['group', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['profile'] }),
      ]);
      router.replace(`/group/${groupId}`);
    } catch (submitError) {
      setError(joinQuestionsError(submitError, "Couldn't save your answers."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View className="flex-1 bg-background">
      <SafeAreaView edges={['top']} className="bg-white">
        <View className="w-full flex-row items-center justify-between border-b border-border px-4 py-4">
          <Pressable
            onPress={goBack}
            hitSlop={8}
            accessibilityLabel="Back"
            className="h-10 w-10 items-center justify-center rounded-full bg-background"
          >
            <Ionicons name="chevron-back" size={18} color={colors.ink} />
          </Pressable>
          <Text className="font-sans-bold text-lg text-ink">{mode === 'join' ? 'Join group' : 'Your player profile'}</Text>
          <View className="h-10 w-10" />
        </View>
      </SafeAreaView>

      {loading || !session ? (
        <View className="items-center pt-16">
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : loadError ? (
        <View className="gap-6 px-6 pt-10">
          <Text className="font-sans-medium text-sm text-danger">{loadError}</Text>
          <PrimaryButton label="Back" variant="outline" onPress={goBack} />
        </View>
      ) : (
        <SafeAreaView edges={['bottom']} className="flex-1">
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ padding: 20, paddingBottom: 24, gap: 16 }}
            keyboardShouldPersistTaps="handled"
          >
            <View className="gap-2 px-1">
              <Text className="font-sans-bold text-2xl text-ink">
                {mode === 'join' ? `Join${groupName ? ` ${groupName}` : ''}` : 'Tell us how you play'}
              </Text>
              <Text className="font-sans text-sm text-muted">
                {questions
                  ? 'Three quick questions help us build balanced teams. Answers are locked once you submit, so answer honestly. Your results take over your rating from there.'
                  : 'Join this group to see games and play with this squad.'}
              </Text>
            </View>

            {questions
              ? questions.map((question) => (
                  <StepSlider
                    key={question.id}
                    label={question.label}
                    prompt={question.prompt}
                    lowLabel={question.lowLabel}
                    highLabel={question.highLabel}
                    value={answers[question.id]}
                    onChange={(value) => setAnswer(question.id, value)}
                    disabled={submitting}
                  />
                ))
              : null}

            {error ? <Text className="px-1 font-sans-medium text-sm text-danger">{error}</Text> : null}
          </ScrollView>

          <View className="gap-1 border-t border-border bg-white px-5 pb-2 pt-4">
            <PrimaryButton
              label={mode === 'join' ? `Join${groupName ? ` ${groupName}` : ''}` : 'Save my answers'}
              loading={submitting}
              onPress={() => void onSubmit()}
            />
            <Pressable onPress={goBack} disabled={submitting} className="items-center py-3">
              <Text className="font-sans-bold text-sm text-muted">Not now</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      )}
    </View>
  );
}
