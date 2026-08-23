import { zodResolver } from '@hookform/resolvers/zod';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Pressable, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '../../src/features/auth/components/PrimaryButton';
import { TextField } from '../../src/features/auth/components/TextField';
import { createGroup } from '../../src/features/groups/api';
import { CoverImagePicker } from '../../src/features/groups/components/CoverImagePicker';
import { FormFooter } from '../../src/features/groups/components/FormFooter';
import { FormSection } from '../../src/features/groups/components/FormSection';
import { LockHoursSelector } from '../../src/features/groups/components/LockHoursSelector';
import { Stepper } from '../../src/features/groups/components/Stepper';
import { WeekdaySelector } from '../../src/features/groups/components/WeekdaySelector';
import { CreateGroupFormValues, createGroupDefaultValues, createGroupSchema } from '../../src/features/groups/schemas';
import {
  type ConnectStatus,
  connectAccountReady,
  connectSetupButtonLabel,
  connectStatusMessage,
  invalidatePayoutsQueries,
  startConnectOnboarding,
  syncConnectStatus,
  syncConnectStatusUntilReady,
} from '../../src/features/payments/api';
import { useUnsavedChangesGuard } from '../../src/lib/useUnsavedChangesGuard';
import { useAuth } from '../../src/providers/AuthProvider';
import { colors } from '../../src/theme/tokens';

const pad2 = (value: number) => String(value).padStart(2, '0');

export default function CreateGroupScreen() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [payoutsReady, setPayoutsReady] = useState(false);
  const [payoutsWorking, setPayoutsWorking] = useState(false);
  const [payoutsError, setPayoutsError] = useState<string | null>(null);
  const [payoutsStatus, setPayoutsStatus] = useState<ConnectStatus>({});

  const {
    control,
    handleSubmit,
    formState: { errors, isValid, isDirty },
  } = useForm<CreateGroupFormValues>({
    resolver: zodResolver(createGroupSchema),
    mode: 'onChange',
    defaultValues: createGroupDefaultValues,
  });

  const { allowLeave } = useUnsavedChangesGuard(isDirty);

  useEffect(() => {
    void syncConnectStatus().then((result) => {
      setPayoutsStatus(result);
      if (connectAccountReady(result)) setPayoutsReady(true);
    });
  }, []);

  async function onSetupPayouts() {
    setPayoutsError(null);
    setPayoutsWorking(true);
    const result = await startConnectOnboarding();
    if (result.error || !result.url) {
      setPayoutsWorking(false);
      setPayoutsError(result.error ?? "Couldn't start payouts setup.");
      return;
    }
    await WebBrowser.openAuthSessionAsync(result.url, 'pitchin://stripe-connect/return');
    const status = await syncConnectStatusUntilReady();
    setPayoutsStatus(status);
    setPayoutsReady(connectAccountReady(status));
    if (status.error) {
      setPayoutsError(status.error);
    } else if (!connectAccountReady(status)) {
      setPayoutsError(connectStatusMessage(status));
    }
    await invalidatePayoutsQueries(queryClient);
    setPayoutsWorking(false);
  }

  const onSubmit = handleSubmit(async (values) => {
    if (!session) return;
    setSubmitError(null);
    setSubmitting(true);
    const { id, error } = await createGroup(values, session.user.id);
    setSubmitting(false);

    if (error || !id) {
      setSubmitError(error ?? 'Something went wrong. Please try again.');
      return;
    }

    // Keeps Home's group list (and any other cached my-groups reads) in sync
    // with the row this screen just inserted — same query key useMyGroups uses.
    await queryClient.invalidateQueries({ queryKey: ['home', 'my-groups', session.user.id] });
    allowLeave();
    if (router.canDismiss()) router.dismiss();
    else router.back();
    setTimeout(() => router.push(`/group/${id}`), 0);
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
            Create New Group
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
          <FormSection title="Group details">
            <Controller
              control={control}
              name="coverImageUri"
              render={({ field }) => <CoverImagePicker uri={field.value} onChange={field.onChange} />}
            />
            <Controller
              control={control}
              name="name"
              render={({ field }) => (
                <TextField
                  label="Group name"
                  icon="people-outline"
                  placeholder="Friday Night Ballers"
                  autoCapitalize="words"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={errors.name?.message}
                />
              )}
            />
            <Controller
              control={control}
              name="description"
              render={({ field }) => (
                <TextField
                  label="Description (optional)"
                  icon="document-text-outline"
                  placeholder="What's this group about?"
                  multiline
                  numberOfLines={3}
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={errors.description?.message}
                />
              )}
            />
          </FormSection>

          <FormSection title="Venue">
            <Controller
              control={control}
              name="venueName"
              render={({ field }) => (
                <TextField
                  label="Venue name"
                  icon="location-outline"
                  placeholder="Powerleague Shoreditch"
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
                  label="Venue address"
                  icon="map-outline"
                  placeholder="Pitch 2, London"
                  autoCapitalize="words"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={errors.venueAddress?.message}
                />
              )}
            />
          </FormSection>

          <FormSection title="Lock window">
            <Controller
              control={control}
              name="lockHours"
              render={({ field }) => <LockHoursSelector value={field.value} onChange={field.onChange} />}
            />
          </FormSection>

          <FormSection title="Regular schedule">
            <View className="w-full gap-2">
              <Text className="font-sans-bold text-xs uppercase tracking-wider text-muted">Day</Text>
              <Controller
                control={control}
                name="weekday"
                render={({ field }) => <WeekdaySelector value={field.value} onChange={field.onChange} />}
              />
            </View>

            <View className="w-full flex-row items-center justify-center gap-8 border-t border-[#F9FAFB] pt-4">
              <Controller
                control={control}
                name="hour"
                render={({ field }) => (
                  <Stepper label="Hour" value={field.value} min={0} max={23} formatValue={pad2} onChange={field.onChange} />
                )}
              />
              <Controller
                control={control}
                name="minute"
                render={({ field }) => (
                  <Stepper label="Minute" value={field.value} min={0} max={59} step={5} formatValue={pad2} onChange={field.onChange} />
                )}
              />
            </View>
          </FormSection>

          <FormSection title="Payouts (optional)">
            <View className="flex-row items-start gap-3">
              <Ionicons
                name={payoutsReady ? 'checkmark-circle' : 'card-outline'}
                size={20}
                color={payoutsReady ? colors.primary : colors.muted}
              />
              <View className="flex-1">
                <Text className="font-sans-bold text-sm text-ink">Pitch money</Text>
                <Text className="mt-1 font-sans text-xs text-muted">
                  {payoutsReady
                    ? 'Payouts are set up. This group can charge to join as soon as you create it.'
                    : 'Set up Stripe payouts now if you will charge players to join. You can also do this later.'}
                </Text>
              </View>
            </View>
            {payoutsError ? <Text className="font-sans-medium text-xs text-danger">{payoutsError}</Text> : null}
            {!payoutsReady ? (
              <PrimaryButton
                label={connectSetupButtonLabel(payoutsStatus)}
                variant="outline"
                loading={payoutsWorking}
                onPress={() => void onSetupPayouts()}
              />
            ) : null}
          </FormSection>

          {submitError ? <Text className="font-sans-medium text-sm text-danger">{submitError}</Text> : null}
        </KeyboardAwareScrollView>
        <FormFooter>
          <PrimaryButton label="Create Group" loading={submitting} disabled={!isValid} onPress={onSubmit} />
        </FormFooter>
      </View>
    </View>
  );
}
