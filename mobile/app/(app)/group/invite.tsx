import { zodResolver } from '@hookform/resolvers/zod';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { z } from 'zod';

import { PrimaryButton } from '../../../src/features/auth/components/PrimaryButton';
import { TextField } from '../../../src/features/auth/components/TextField';
import { inviteGroupMember } from '../../../src/features/group-details/api';
import { useGroupDetail } from '../../../src/features/group-details/hooks';
import { isValidUkMobile } from '../../../src/lib/phone';
import { useAuth } from '../../../src/providers/AuthProvider';
import { colors } from '../../../src/theme/tokens';

const inviteSchema = z.object({
  mobile: z.string().min(1, 'Enter a mobile number').refine(isValidUkMobile, 'Enter a valid UK mobile number'),
});

type InviteForm = z.infer<typeof inviteSchema>;

export default function InviteMemberScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const groupQuery = useGroupDetail(groupId);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, isValid },
  } = useForm<InviteForm>({
    resolver: zodResolver(inviteSchema),
    mode: 'onChange',
    defaultValues: { mobile: '' },
  });

  const isAdmin = groupQuery.data?.role === 'admin';

  const onSubmit = handleSubmit(async (values) => {
    if (!groupId || !session) return;
    setSubmitError(null);
    setSubmitting(true);
    const result = await inviteGroupMember(groupId, values.mobile);
    setSubmitting(false);
    if (result.error) {
      setSubmitError(result.error);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ['group', groupId, 'invites', session.user.id] });
    reset({ mobile: '' });
    router.back();
  });

  return (
    <View className="flex-1 bg-background">
      <SafeAreaView edges={['top']} className="bg-white">
        <View className="w-full flex-row items-center justify-between border-b border-border px-4 py-4">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            className="h-10 w-10 items-center justify-center rounded-full bg-background"
          >
            <Ionicons name="chevron-back" size={18} color={colors.ink} />
          </Pressable>
          <Text className="font-sans-bold text-lg text-ink">Invite members</Text>
          <View className="h-10 w-10" />
        </View>
      </SafeAreaView>

      {groupQuery.isPending ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : !isAdmin ? (
        <View className="px-6 pt-10">
          <Text className="font-sans text-sm text-muted">Only admins can invite members.</Text>
        </View>
      ) : (
        <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }} keyboardShouldPersistTaps="handled">
            <Text className="font-sans text-sm text-muted">
              Invite someone who already has a PitchIn account by their UK mobile number.
            </Text>
            <Controller
              control={control}
              name="mobile"
              render={({ field }) => (
                <TextField
                  label="UK mobile"
                  icon="call-outline"
                  keyboardType="phone-pad"
                  placeholder="07912 345678"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={errors.mobile?.message}
                />
              )}
            />
            {submitError ? <Text className="font-sans-medium text-sm text-danger">{submitError}</Text> : null}
          </ScrollView>
          <View className="border-t border-border bg-white px-4 pt-4" style={{ paddingBottom: Math.max(insets.bottom, 24) }}>
            <PrimaryButton label="Invite" loading={submitting} disabled={!isValid} onPress={onSubmit} />
          </View>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}
