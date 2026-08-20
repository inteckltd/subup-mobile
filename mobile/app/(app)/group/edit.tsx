import { zodResolver } from '@hookform/resolvers/zod';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton } from '../../../src/features/auth/components/PrimaryButton';
import { TextField } from '../../../src/features/auth/components/TextField';
import { useGroupDetail } from '../../../src/features/group-details/hooks';
import { updateGroup, uploadGroupCoverImage } from '../../../src/features/groups/api';
import { CoverImagePicker } from '../../../src/features/groups/components/CoverImagePicker';
import { FormSection } from '../../../src/features/groups/components/FormSection';
import { LockHoursSelector } from '../../../src/features/groups/components/LockHoursSelector';
import { SportSelector } from '../../../src/features/groups/components/SportSelector';
import { Stepper } from '../../../src/features/groups/components/Stepper';
import { WeekdaySelector } from '../../../src/features/groups/components/WeekdaySelector';
import { createGroupSchema, type CreateGroupFormValues } from '../../../src/features/groups/schemas';
import { useAuth } from '../../../src/providers/AuthProvider';
import { colors } from '../../../src/theme/tokens';

const pad2 = (value: number) => String(value).padStart(2, '0');

export default function EditGroupScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const groupQuery = useGroupDetail(groupId);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const group = groupQuery.data;
  const timeParts = group?.defaultTime?.split(':') ?? [];
  const defaultHour = Number(timeParts[0] ?? 19);
  const defaultMinute = Number(timeParts[1] ?? 30);

  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, isValid },
  } = useForm<CreateGroupFormValues>({
    resolver: zodResolver(createGroupSchema),
    mode: 'onChange',
    defaultValues: {
      name: '',
      description: '',
      sport: 'football',
      lockHours: 24,
      venueName: '',
      venueAddress: '',
      weekday: 5,
      hour: 19,
      minute: 30,
    },
  });

  useEffect(() => {
    if (!group) return;
    reset({
      name: group.name,
      description: group.description ?? '',
      coverImageUri: group.coverImageUrl ?? undefined,
      sport: group.sport,
      lockHours: group.lockHours ?? 24,
      venueName: group.venueName ?? '',
      venueAddress: group.venueAddress ?? '',
      weekday: group.defaultWeekday ?? 5,
      hour: Number.isFinite(defaultHour) ? defaultHour : 19,
      minute: Number.isFinite(defaultMinute) ? defaultMinute : 30,
    });
  }, [group, reset, defaultHour, defaultMinute]);

  const onSubmit = handleSubmit(async (values) => {
    if (!session || !groupId || !group) return;
    setSubmitError(null);
    setSubmitting(true);

    let coverImageUrl = group.coverImageUrl;
    if (values.coverImageUri && values.coverImageUri !== group.coverImageUrl && !values.coverImageUri.startsWith('http')) {
      const uploaded = await uploadGroupCoverImage(session.user.id, values.coverImageUri);
      if (uploaded.error) {
        setSubmitting(false);
        setSubmitError(uploaded.error);
        return;
      }
      coverImageUrl = uploaded.url ?? null;
    }

    const result = await updateGroup(groupId, values, coverImageUrl);
    setSubmitting(false);
    if (result.error) {
      setSubmitError(result.error);
      return;
    }

    await queryClient.invalidateQueries({ queryKey: ['group', groupId] });
    await queryClient.invalidateQueries({ queryKey: ['home', 'my-groups', session.user.id] });
    router.back();
  });

  if (groupQuery.isPending) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!group || group.role !== 'admin') {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background px-8">
        <Text className="text-center font-sans text-sm text-muted">Only admins can edit this group.</Text>
        <PrimaryButton label="Back" className="mt-6 w-auto px-8" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <SafeAreaView edges={['top']} className="bg-white">
        <View className="flex-row items-center gap-4 border-b border-border px-4 py-4">
          <Pressable onPress={() => router.back()} className="h-10 w-10 items-center justify-center rounded-full bg-background">
            <Ionicons name="chevron-back" size={18} color={colors.ink} />
          </Pressable>
          <Text className="font-sans-bold text-lg text-ink">Edit group</Text>
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 20, paddingBottom: 140, gap: 24 }}
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
                  multiline
                  numberOfLines={3}
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={errors.description?.message}
                />
              )}
            />
            <Controller
              control={control}
              name="lockHours"
              render={({ field }) => <LockHoursSelector value={field.value} onChange={field.onChange} />}
            />
            <Controller
              control={control}
              name="sport"
              render={({ field }) => <SportSelector value={field.value} onChange={field.onChange} />}
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
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={errors.venueAddress?.message}
                />
              )}
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

          {submitError ? <Text className="font-sans-medium text-sm text-danger">{submitError}</Text> : null}
        </ScrollView>
      </KeyboardAvoidingView>

      <View className="absolute bottom-0 left-0 right-0 border-t border-border bg-white px-4 pt-4" style={{ paddingBottom: Math.max(insets.bottom, 24) }}>
        <PrimaryButton label="Save changes" loading={submitting} disabled={!isValid} onPress={onSubmit} />
      </View>
    </View>
  );
}
