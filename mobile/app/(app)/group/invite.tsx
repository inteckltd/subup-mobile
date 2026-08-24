import { zodResolver } from '@hookform/resolvers/zod';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { z } from 'zod';

import { PrimaryButton } from '../../../src/features/auth/components/PrimaryButton';
import { TextField } from '../../../src/features/auth/components/TextField';
import { inviteGroupMember } from '../../../src/features/group-details/api';
import { useGroupDetail } from '../../../src/features/group-details/hooks';
import {
  buildInviteShareMessage,
  inviteShareFirstName,
  shareInviteViaSms,
  shareInviteViaWhatsApp,
} from '../../../src/features/group-details/shareInvite';
import { FormFooter } from '../../../src/features/groups/components/FormFooter';
import { env } from '../../../src/lib/env';
import { isValidUkMobile, nationaliseUkMobileInput } from '../../../src/lib/phone';
import { useUnsavedChangesGuard } from '../../../src/lib/useUnsavedChangesGuard';
import { useAuth } from '../../../src/providers/AuthProvider';
import { colors } from '../../../src/theme/tokens';

const inviteSchema = z.object({
  mobile: z.string().min(1, 'Enter a mobile number').refine(isValidUkMobile, 'Enter a valid UK mobile number'),
});

type InviteForm = z.infer<typeof inviteSchema>;

export default function InviteMemberScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { session, profile } = useAuth();
  const queryClient = useQueryClient();
  const groupQuery = useGroupDetail(groupId);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sharingWhatsApp, setSharingWhatsApp] = useState(false);

  const {
    control,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isValid, isDirty },
  } = useForm<InviteForm>({
    resolver: zodResolver(inviteSchema),
    mode: 'onChange',
    defaultValues: { mobile: '' },
  });

  const { allowLeave } = useUnsavedChangesGuard(isDirty);
  const mobileValue = watch('mobile');

  const isAdmin = groupQuery.data?.role === 'admin';
  const shareMessage = buildInviteShareMessage({
    firstName: inviteShareFirstName(profile?.full_name),
    groupName: groupQuery.data?.name ?? 'a group',
    url: env.EXPO_PUBLIC_INVITE_APP_URL,
  });

  const onShareWhatsApp = async () => {
    if (!groupId || !session) return;
    setShareError(null);
    if (!isValidUkMobile(mobileValue)) {
      setShareError('Enter a valid UK mobile number');
      return;
    }
    setSharingWhatsApp(true);
    try {
      const result = await inviteGroupMember(groupId, mobileValue, { skipSms: true });
      if (result.error) {
        setShareError(result.error);
        return;
      }
      const message = buildInviteShareMessage({
        firstName: inviteShareFirstName(profile?.full_name),
        groupName: groupQuery.data?.name ?? 'a group',
        url: env.EXPO_PUBLIC_INVITE_APP_URL,
        existingUser: result.existingUser,
      });
      try {
        await shareInviteViaWhatsApp(message, mobileValue);
      } catch {
        setShareError("Invite sent, but couldn't open WhatsApp.");
      }
      await queryClient.invalidateQueries({ queryKey: ['group', groupId, 'invites', session.user.id] });
      await queryClient.invalidateQueries({ queryKey: ['home', 'pending-invites', session.user.id] });
      reset({ mobile: '' });
      allowLeave();
    } finally {
      setSharingWhatsApp(false);
    }
  };

  const onShareMessages = async () => {
    setShareError(null);
    try {
      await shareInviteViaSms(shareMessage, mobileValue);
    } catch {
      setShareError("Couldn't open Messages.");
    }
  };

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
    await queryClient.invalidateQueries({ queryKey: ['home', 'pending-invites', session.user.id] });
    reset({ mobile: '' });
    allowLeave();
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
        <View className="flex-1">
          <KeyboardAwareScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 20, gap: 16 }}
            keyboardShouldPersistTaps="handled"
            bottomOffset={88}
          >
            <Text className="font-sans text-sm text-muted">
              Invite someone by their UK mobile number. If they don&apos;t have PitchIn yet, we&apos;ll text them a download link.
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
                  textContentType="telephoneNumber"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={() => {
                    field.onChange(nationaliseUkMobileInput(field.value));
                    field.onBlur();
                  }}
                  error={errors.mobile?.message}
                />
              )}
            />
            {submitError ? <Text className="font-sans-medium text-sm text-danger">{submitError}</Text> : null}

            <View className="mt-2 gap-3">
              <View className="flex-row items-center gap-3">
                <View className="h-px flex-1 bg-border" />
                <Text className="font-sans-medium text-xs uppercase tracking-wide text-muted">Or share a message</Text>
                <View className="h-px flex-1 bg-border" />
              </View>
              <Text className="font-sans text-sm text-muted">
                WhatsApp sends a real invite for this number. Existing members get an in-app notification; new
                numbers get a download link. Messages only shares a download link and does not add them to the
                group.
              </Text>
              <View className="flex-row gap-3">
                <Pressable
                  onPress={() => void onShareWhatsApp()}
                  disabled={sharingWhatsApp || submitting || !isValid}
                  className="flex-1 flex-row items-center justify-center gap-2 rounded-2xl border border-border bg-white py-3.5"
                >
                  {sharingWhatsApp ? (
                    <ActivityIndicator color={colors.ink} />
                  ) : (
                    <>
                      <Ionicons name="logo-whatsapp" size={18} color={colors.ink} />
                      <Text className="font-sans-bold text-sm text-ink">WhatsApp</Text>
                    </>
                  )}
                </Pressable>
                <Pressable
                  onPress={onShareMessages}
                  className="flex-1 flex-row items-center justify-center gap-2 rounded-2xl border border-border bg-white py-3.5"
                >
                  <Ionicons name="chatbubble-outline" size={18} color={colors.ink} />
                  <Text className="font-sans-bold text-sm text-ink">Messages</Text>
                </Pressable>
              </View>
              {shareError ? <Text className="font-sans-medium text-sm text-danger">{shareError}</Text> : null}
            </View>
          </KeyboardAwareScrollView>
          <FormFooter>
            <PrimaryButton label="Invite Member" loading={submitting} disabled={!isValid || sharingWhatsApp} onPress={onSubmit} />
          </FormFooter>
        </View>
      )}
    </View>
  );
}
