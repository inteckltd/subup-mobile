import { zodResolver } from '@hookform/resolvers/zod';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Alert, Pressable, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '../../../src/features/auth/components/PrimaryButton';
import { TextField } from '../../../src/features/auth/components/TextField';
import { OtpInput } from '../../../src/features/auth/components/OtpInput';
import { FormFooter } from '../../../src/features/groups/components/FormFooter';
import { Avatar } from '../../../src/features/home/components/Avatar';
import { changePassword, confirmMobileChange, requestMobileChangeOtp, updateProfileFields, uploadAvatar } from '../../../src/features/profile/api';
import { editProfileSchema, type EditProfileFormValues } from '../../../src/features/profile/schemas';
import { nationaliseUkMobileInput, normalizeUkMobile, ukMobileNationalDigits } from '../../../src/lib/phone';
import { useUnsavedChangesGuard } from '../../../src/lib/useUnsavedChangesGuard';
import { useAuth } from '../../../src/providers/AuthProvider';
import { colors } from '../../../src/theme/tokens';

export default function EditProfileScreen() {
  const { profile, session, refreshProfile } = useAuth();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingMobile, setPendingMobile] = useState<string | null>(null);
  const [mobileCode, setMobileCode] = useState('');

  const hasPassword = session?.user.identities?.some((identity) => identity.provider === 'phone' || identity.provider === 'email') ?? false;

  const defaultValues = useMemo<EditProfileFormValues>(
    () => ({
      fullName: profile?.full_name ?? '',
      email: profile?.email ?? '',
      mobile: profile?.mobile ? ukMobileNationalDigits(profile.mobile) : '',
      currentPassword: '',
      newPassword: '',
      avatarUri: profile?.avatar_url ?? undefined,
    }),
    [profile],
  );

  const {
    control,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<EditProfileFormValues>({
    resolver: zodResolver(editProfileSchema),
    defaultValues,
  });

  const { allowLeave } = useUnsavedChangesGuard(isDirty);

  const avatarUri = watch('avatarUri');

  async function pickPhoto() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Photo access needed', 'Allow SubUp to access your photos to change your profile photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (!result.canceled && result.assets[0]) {
      setValue('avatarUri', result.assets[0].uri, { shouldDirty: true });
    }
  }

  const onSubmit = handleSubmit(async (values) => {
    if (!session || !profile) return;
    setSubmitError(null);
    setSubmitting(true);

    try {
      let avatarUrl: string | undefined;
      if (values.avatarUri && values.avatarUri !== profile.avatar_url && !values.avatarUri.startsWith('http')) {
        const uploaded = await uploadAvatar(session.user.id, values.avatarUri);
        if (uploaded.error) {
          setSubmitError(uploaded.error);
          return;
        }
        avatarUrl = uploaded.url;
      }

      const fields = await updateProfileFields({
        fullName: values.fullName.trim(),
        email: values.email.trim() || null,
        avatarUrl,
      });
      if (fields.error) {
        setSubmitError(fields.error);
        return;
      }

      const nextMobile = normalizeUkMobile(values.mobile);
      const currentMobile = normalizeUkMobile(profile.mobile ?? '');
      if (nextMobile && nextMobile !== currentMobile) {
        if (pendingMobile === nextMobile && mobileCode.length === 6) {
          const confirmed = await confirmMobileChange(nextMobile, mobileCode);
          if (confirmed.error) {
            setSubmitError(confirmed.error);
            return;
          }
        } else {
          const requested = await requestMobileChangeOtp(nextMobile);
          if (requested.error) {
            setSubmitError(requested.error);
            return;
          }
          setPendingMobile(nextMobile);
          setMobileCode('');
          setSubmitError('We sent a code to the new number. Enter it and tap Save again.');
          return;
        }
      }

      if (hasPassword && values.newPassword) {
        if (!profile.mobile) {
          setSubmitError('Add a mobile number before changing your password.');
          return;
        }
        const passwordResult = await changePassword(values.currentPassword, values.newPassword, profile.mobile);
        if (passwordResult.error) {
          setSubmitError(passwordResult.error);
          return;
        }
      }

      await refreshProfile();
      allowLeave();
      router.back();
    } finally {
      setSubmitting(false);
    }
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
          <Text className="font-sans-bold text-lg text-ink">Edit Profile</Text>
          <View className="h-10 w-10" />
        </View>
      </SafeAreaView>

      <View className="flex-1">
        <KeyboardAwareScrollView
          style={{ flex: 1 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          bottomOffset={88}
          contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 32 }}
        >
          <View className="items-center">
            <Pressable onPress={pickPhoto}>
              <Avatar uri={avatarUri} name={watch('fullName')} size={112} ringColor={colors.white} ringWidth={4} />
              <View className="absolute bottom-0 right-0 h-9 w-9 items-center justify-center rounded-full border-4 border-white bg-primary">
                <Ionicons name="camera" size={14} color={colors.white} />
              </View>
            </Pressable>
            <Text className="pt-3 font-sans-bold text-xs uppercase tracking-widest text-primary">Change photo</Text>
          </View>

          <View className="gap-4">
            <Text className="font-sans-bold text-xs uppercase tracking-widest text-muted">Personal details</Text>
            <Controller
              control={control}
              name="fullName"
              render={({ field }) => (
                <TextField
                  label="Full name"
                  icon="person-outline"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={errors.fullName?.message}
                />
              )}
            />
            <Controller
              control={control}
              name="email"
              render={({ field }) => (
                <TextField
                  label="Email address"
                  icon="mail-outline"
                  autoCapitalize="none"
                  keyboardType="email-address"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={errors.email?.message}
                />
              )}
            />
            <Controller
              control={control}
              name="mobile"
              render={({ field }) => (
                <TextField
                  label="Phone number"
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
            {pendingMobile ? (
              <OtpInput
                value={mobileCode}
                onChange={(next) => {
                  setMobileCode(next);
                  setSubmitError(null);
                }}
                error={undefined}
              />
            ) : null}
          </View>

          {hasPassword ? (
            <View className="gap-4 border-t border-border pt-4">
              <Text className="font-sans-bold text-xs uppercase tracking-widest text-muted">Security</Text>
              <Controller
                control={control}
                name="currentPassword"
                render={({ field }) => (
                  <TextField
                    label="Current password"
                    icon="lock-closed-outline"
                    isPassword
                    value={field.value}
                    onChangeText={field.onChange}
                    onBlur={field.onBlur}
                    error={errors.currentPassword?.message}
                  />
                )}
              />
              <Controller
                control={control}
                name="newPassword"
                render={({ field }) => (
                  <TextField
                    label="New password"
                    icon="lock-closed-outline"
                    isPassword
                    placeholder="Min. 8 characters"
                    value={field.value}
                    onChangeText={field.onChange}
                    onBlur={field.onBlur}
                    error={errors.newPassword?.message}
                  />
                )}
              />
            </View>
          ) : null}

          {submitError ? <Text className="font-sans-medium text-sm text-danger">{submitError}</Text> : null}
        </KeyboardAwareScrollView>
        <FormFooter>
          <PrimaryButton label="Save Changes" loading={submitting} onPress={onSubmit} />
        </FormFooter>
      </View>
    </View>
  );
}
