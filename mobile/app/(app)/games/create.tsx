import { zodResolver } from '@hookform/resolvers/zod';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Pressable, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '../../../src/features/auth/components/PrimaryButton';
import { TextField } from '../../../src/features/auth/components/TextField';
import { DateTimeField } from '../../../src/features/games/components/DateTimeField';
import { DurationSelector } from '../../../src/features/games/components/DurationSelector';
import { GroupSelect } from '../../../src/features/games/components/GroupSelect';
import { PriceField } from '../../../src/features/games/components/PriceField';
import { TeamColorSelector } from '../../../src/features/games/components/TeamColorSelector';
import { ToggleRow } from '../../../src/features/games/components/ToggleRow';
import { useCreatableGroups, useCreateGame, useGameDetail, useUpdateGame } from '../../../src/features/games/hooks';
import { connectAccountReady, fetchGroupPayouts, invalidatePayoutsQueries, syncConnectStatus } from '../../../src/features/payments/api';
import { pitchinServiceFeeCents, playerTotalCents } from '../../../src/features/payments/fees';
import {
  CreateGameFormValues,
  centsToPounds,
  poundsToCents,
  createGameDefaultValues,
  createGameSchemaForLock,
  nextOccurrenceOfWeekdayTime,
  teamColorById,
} from '../../../src/features/games/schemas';
import { FormFooter } from '../../../src/features/groups/components/FormFooter';
import { FormSection } from '../../../src/features/groups/components/FormSection';
import { Stepper } from '../../../src/features/groups/components/Stepper';
import { formatGbp } from '../../../src/lib/format';
import { useUnsavedChangesGuard } from '../../../src/lib/useUnsavedChangesGuard';
import { useAuth } from '../../../src/providers/AuthProvider';
import { colors } from '../../../src/theme/tokens';

function formatDateInput(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

function formatTimeInput(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).format(date).toUpperCase();
}

export default function CreateGameScreen() {
  const { groupId: groupIdParam, editId } = useLocalSearchParams<{ groupId?: string; editId?: string }>();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const groupsQuery = useCreatableGroups();
  const { submit, submitting, error: createError } = useCreateGame();
  const { submit: updateSubmit, submitting: updating, error: updateError } = useUpdateGame();
  const editQuery = useGameDetail(editId);
  const isEditing = !!editId;

  const groups = groupsQuery.data ?? [];
  const lockHoursRef = useRef<number | null>(null);
  const didPrefillEdit = useRef(false);

  const {
    control,
    handleSubmit,
    setValue,
    watch,
    trigger,
    formState: { errors, isValid, isDirty },
  } = useForm<CreateGameFormValues>({
    resolver: async (values, context, options) =>
      zodResolver(createGameSchemaForLock(lockHoursRef.current))(values, context, options),
    mode: 'onChange',
    defaultValues: createGameDefaultValues,
  });

  const watchedGroupId = watch('groupId');
  const watchedPrice = watch('pricePounds');
  const selectedGroup = groups.find((group) => group.id === watchedGroupId);
  const payoutsQuery = useQuery({
    queryKey: ['group', watchedGroupId, 'payouts', session?.user.id],
    queryFn: () => fetchGroupPayouts(watchedGroupId),
    enabled: !!session && !!watchedGroupId,
  });
  const payoutsReady = payoutsQuery.data ? connectAccountReady(payoutsQuery.data) : false;
  const priceCents = poundsToCents(watchedPrice ?? 0);
  lockHoursRef.current = selectedGroup?.lockHours ?? editQuery.data?.cancelIfMinNotMetHours ?? null;
  const submitError = createError || updateError;
  const { allowLeave } = useUnsavedChangesGuard(isDirty);

  useFocusEffect(
    useCallback(() => {
      if (!session || !watchedGroupId) return;
      void (async () => {
        await syncConnectStatus();
        await invalidatePayoutsQueries(queryClient);
      })();
    }, [session, watchedGroupId, queryClient]),
  );

  // Preselects the group passed in from Group Details' "Create game" CTA,
  // once the creatable-groups list has loaded and confirms the caller
  // actually admins it (defence in depth — the CTA is admin-only already).
  useEffect(() => {
    if (!groupIdParam || !groupsQuery.data || isEditing) return;
    if (groupsQuery.data.some((group) => group.id === groupIdParam)) {
      setValue('groupId', groupIdParam, { shouldValidate: true });
    }
  }, [groupIdParam, groupsQuery.data, setValue, isEditing]);

  // Prefills venue, date and time from the selected group's defaults
  // whenever the group changes — covers both the groupId-param case above
  // and picking a group directly from the dropdown, per the brief
  // ("Venue... default to group default venue when group is known"; date
  // and time default to the group's own recurring day/kickoff time — e.g.
  // a Friday 7:30pm group prefills the next upcoming Friday at 7:30pm).
  // Groups without a recurring day/time configured (`defaultWeekday`,
  // `defaultHour`/`defaultMinute` all null) leave the form's generic
  // "next 7:30pm" default untouched.
  useEffect(() => {
    if (isEditing) return;
    if (!watchedGroupId || !groupsQuery.data) return;
    const group = groupsQuery.data.find((g) => g.id === watchedGroupId);
    if (!group) return;
    setValue('venueName', group.defaultVenueName ?? '');
    setValue('venueAddress', group.defaultVenueAddress ?? '');
    if (group.defaultWeekday != null && group.defaultHour != null && group.defaultMinute != null) {
      const next = nextOccurrenceOfWeekdayTime(group.defaultWeekday, group.defaultHour, group.defaultMinute);
      setValue('date', next, { shouldValidate: true });
      setValue('time', next, { shouldValidate: true });
    }
  }, [watchedGroupId, groupsQuery.data, setValue, isEditing]);

  useEffect(() => {
    const game = editQuery.data;
    if (!isEditing || !game || didPrefillEdit.current) return;
    didPrefillEdit.current = true;
    const kickoff = new Date(game.startsAt);
    setValue('groupId', game.groupId, { shouldValidate: true });
    setValue('title', game.title ?? '', { shouldValidate: true });
    setValue('date', kickoff, { shouldValidate: true });
    setValue('time', kickoff, { shouldValidate: true });
    setValue('venueName', game.venueName ?? '');
    setValue('venueAddress', game.venueAddress ?? '');
    setValue('minPlayers', game.minPlayers);
    setValue('maxPlayers', game.maxPlayers);
    setValue('pricePounds', centsToPounds(game.priceCents));
    setValue('durationMinutes', game.durationMinutes);
    setValue('homeColor', teamColorById(game.homeColor).id);
    setValue('awayColor', teamColorById(game.awayColor).id);
    setValue('allowWaitlist', game.allowWaitlist);
  }, [isEditing, editQuery.data, setValue]);

  useEffect(() => {
    void trigger(['date', 'time']);
  }, [selectedGroup?.lockHours, trigger]);

  const onSubmit = handleSubmit(async (values) => {
    if (poundsToCents(values.pricePounds) > 0 && !payoutsReady && watchedGroupId) {
      router.push(`/group/payouts?groupId=${watchedGroupId}`);
      return;
    }
    if (isEditing && editId) {
      const ok = await updateSubmit(editId, values);
      if (ok) {
        allowLeave();
        router.replace(`/games/${editId}`);
      }
      return;
    }
    const gameId = await submit(values);
    if (gameId) {
      allowLeave();
      router.replace(`/games/${gameId}`);
    }
  });

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
            {isEditing ? 'Edit Game' : 'Create New Game'}
          </Text>
        </View>
      </SafeAreaView>

      <View className="flex-1">
        <KeyboardAwareScrollView
          style={{ flex: 1 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          bottomOffset={88}
          contentContainerStyle={{ padding: 20, paddingBottom: 24, gap: 24 }}
        >
          <FormSection title="Game details">
            <View className="w-full gap-1.5">
              <Text className="font-sans-bold text-xs text-muted">Group</Text>
              {isEditing ? (
                <Text className="font-sans-bold text-sm text-ink">{editQuery.data?.groupName ?? '—'}</Text>
              ) : (
                <Controller
                  control={control}
                  name="groupId"
                  render={({ field }) => <GroupSelect groups={groups} value={field.value} onChange={field.onChange} />}
                />
              )}
              {errors.groupId ? <Text className="font-sans-medium text-xs text-danger">{errors.groupId.message}</Text> : null}
            </View>

            <Controller
              control={control}
              name="title"
              render={({ field }) => (
                <TextField
                  label="Game name"
                  icon="football-outline"
                  placeholder="Sunday kickabout"
                  autoCapitalize="words"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={errors.title?.message}
                />
              )}
            />

            <View className="w-full gap-1.5">
              <View className="w-full flex-row gap-3">
                <Controller
                  control={control}
                  name="date"
                  render={({ field }) => (
                    <DateTimeField
                      label="Date"
                      mode="date"
                      value={field.value}
                      onChange={field.onChange}
                      minimumDate={
                        selectedGroup?.lockHours
                          ? new Date(Date.now() + selectedGroup.lockHours * 60 * 60 * 1000)
                          : new Date()
                      }
                      formatValue={formatDateInput}
                    />
                  )}
                />
                <Controller
                  control={control}
                  name="time"
                  render={({ field }) => (
                    <DateTimeField label="Time" mode="time" value={field.value} onChange={field.onChange} formatValue={formatTimeInput} />
                  )}
                />
              </View>
              {errors.date ? (
                <Text className="font-sans-medium text-xs text-danger">{errors.date.message}</Text>
              ) : selectedGroup ? (
                <Text className="font-sans text-[10px] text-muted">
                  Kickoff must be at least {selectedGroup.lockHours} hours away so players can join and leave before the lock.
                </Text>
              ) : null}
            </View>

            <View className="w-full gap-1.5">
              <Text className="font-sans-bold text-xs text-muted">Duration</Text>
              <Controller
                control={control}
                name="durationMinutes"
                render={({ field }) => <DurationSelector value={field.value} onChange={field.onChange} />}
              />
              {errors.durationMinutes ? <Text className="font-sans-medium text-xs text-danger">{errors.durationMinutes.message}</Text> : null}
            </View>

            <Controller
              control={control}
              name="venueName"
              render={({ field }) => (
                <TextField
                  label="Venue name"
                  icon="location-outline"
                  placeholder="Search or enter venue name"
                  autoCapitalize="words"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={errors.venueName?.message}
                />
              )}
            />
            <Controller
              control={control}
              name="venueAddress"
              render={({ field }) => (
                <TextField
                  label="Venue address (optional)"
                  icon="map-outline"
                  placeholder="Pitch 2, Powerleague Shoreditch"
                  autoCapitalize="words"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={errors.venueAddress?.message}
                />
              )}
            />
          </FormSection>

          <FormSection title="Player slots & rules">
            <View className="w-full flex-row items-center justify-between">
              <View className="flex-1 pr-3">
                <Text className="font-sans-bold text-sm text-ink">Min Players</Text>
                <Text className="font-sans text-[10px] text-muted">Game cancels if not met</Text>
              </View>
              <Controller
                control={control}
                name="minPlayers"
                render={({ field }) => <Stepper label="" value={field.value} min={1} max={50} onChange={field.onChange} />}
              />
            </View>

            <View className="w-full flex-row items-center justify-between">
              <View className="flex-1 pr-3">
                <Text className="font-sans-bold text-sm text-ink">Max Players</Text>
                <Text className="font-sans text-[10px] text-muted">Game fills up at this limit</Text>
              </View>
              <Controller
                control={control}
                name="maxPlayers"
                render={({ field }) => <Stepper label="" value={field.value} min={1} max={50} onChange={field.onChange} />}
              />
            </View>
            {errors.maxPlayers ? <Text className="font-sans-medium text-xs text-danger">{errors.maxPlayers.message}</Text> : null}

            <View className="w-full gap-1.5 border-t border-[#F9FAFB] pt-3">
              <Text className="font-sans-bold text-xs text-muted">Pitch cost per player</Text>
              <Text className="font-sans text-[10px] text-muted">
                You receive this amount. Players pay this plus a SubUp fee in the app.
              </Text>
              <Controller
                control={control}
                name="pricePounds"
                render={({ field }) => (
                  <PriceField value={field.value} onChange={field.onChange} onBlur={field.onBlur} />
                )}
              />
              {errors.pricePounds ? <Text className="font-sans-medium text-xs text-danger">{errors.pricePounds.message}</Text> : null}
              {priceCents > 0 ? (
                <Text className="font-sans text-[10px] text-muted">
                  Players pay {formatGbp(playerTotalCents(priceCents))} ({formatGbp(priceCents)} +{' '}
                  {formatGbp(pitchinServiceFeeCents(priceCents))} SubUp fee)
                </Text>
              ) : null}
              {priceCents > 0 && !payoutsReady && watchedGroupId ? (
                <View className="mt-1 gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-3">
                  <Text className="font-sans-bold text-sm text-danger">Payouts are not set up</Text>
                  <Text className="font-sans text-xs text-danger">
                    This group needs a Stripe payouts profile before you can create a paid game. Set that up first, then come back.
                  </Text>
                  <Pressable
                    onPress={() => router.push(`/group/payouts?groupId=${watchedGroupId}`)}
                    className="mt-1 items-center rounded-full bg-danger px-4 py-2.5"
                  >
                    <Text className="font-sans-bold text-xs text-white">Set up payouts</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          </FormSection>

          <FormSection title="Team colours">
            <Text className="font-sans text-xs text-muted">
              So players can tell teams apart on the day — used when the score gets entered too.
            </Text>
            <View className="w-full gap-1.5">
              <Text className="font-sans-bold text-xs text-muted">Home</Text>
              <Controller
                control={control}
                name="homeColor"
                render={({ field }) => <TeamColorSelector value={field.value} onChange={field.onChange} />}
              />
            </View>
            <View className="w-full gap-1.5 border-t border-[#F9FAFB] pt-3">
              <Text className="font-sans-bold text-xs text-muted">Away</Text>
              <Controller
                control={control}
                name="awayColor"
                render={({ field }) => <TeamColorSelector value={field.value} onChange={field.onChange} />}
              />
            </View>
            {errors.awayColor ? <Text className="font-sans-medium text-xs text-danger">{errors.awayColor.message}</Text> : null}
          </FormSection>

          <View className="w-full rounded-2xl bg-white px-4 py-1" style={{ shadowColor: '#000000', shadowOpacity: 0.05, shadowRadius: 1, shadowOffset: { width: 0, height: 1 } }}>
            <Controller
              control={control}
              name="allowWaitlist"
              render={({ field }) => (
                <ToggleRow
                  icon="people-outline"
                  iconBg="#EEF2FF"
                  iconColor="#4338CA"
                  label="Allow waitlist"
                  value={field.value}
                  onChange={field.onChange}
                />
              )}
            />
          </View>

          {submitError ? <Text className="font-sans-medium text-sm text-danger">{submitError}</Text> : null}
        </KeyboardAwareScrollView>
        <FormFooter>
          <PrimaryButton
            label={isEditing ? 'Save changes' : 'Create Game'}
            loading={submitting || updating}
            disabled={!isValid || (!isEditing && groups.length === 0)}
            onPress={onSubmit}
          />
        </FormFooter>
      </View>
    </View>
  );
}
