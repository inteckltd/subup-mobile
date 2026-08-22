import { zodResolver } from '@hookform/resolvers/zod';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Text } from 'react-native';

import { updatePasswordAfterReset } from '../../src/features/auth/api';
import { AuthScreenLayout } from '../../src/features/auth/components/AuthScreenLayout';
import { PrimaryButton } from '../../src/features/auth/components/PrimaryButton';
import { TextField } from '../../src/features/auth/components/TextField';
import { ResetPasswordFormValues, resetPasswordSchema } from '../../src/features/auth/schemas';
import { useAuth } from '../../src/providers/AuthProvider';

export default function ResetPasswordScreen() {
  const { passwordRecovery, endPasswordRecovery, refreshProfile } = useAuth();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!passwordRecovery) {
      router.replace('/forgot-password');
    }
  }, [passwordRecovery]);

  const {
    control,
    handleSubmit,
    formState: { errors, isValid },
  } = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(resetPasswordSchema),
    mode: 'onChange',
    defaultValues: { password: '', confirmPassword: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    setSubmitting(true);
    const { error } = await updatePasswordAfterReset(values.password);
    setSubmitting(false);
    if (error) {
      setSubmitError(error);
      return;
    }
    await refreshProfile();
    endPasswordRecovery();
    router.replace('/');
  });

  return (
    <AuthScreenLayout
      showBack
      title="New "
      titleAccent="password."
      subtitle="Choose a password you haven't used before."
      heroImage={require('../../assets/images/auth-hero-login.jpg')}
    >
      <Controller
        control={control}
        name="password"
        render={({ field }) => (
          <TextField
            label="New password"
            icon="lock-closed-outline"
            placeholder="At least 8 characters"
            isPassword
            textContentType="newPassword"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.password?.message}
          />
        )}
      />
      <Controller
        control={control}
        name="confirmPassword"
        render={({ field }) => (
          <TextField
            label="Confirm password"
            icon="lock-closed-outline"
            placeholder="Repeat your password"
            isPassword
            textContentType="newPassword"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.confirmPassword?.message}
          />
        )}
      />

      {submitError ? <Text className="font-sans-medium text-sm text-danger">{submitError}</Text> : null}

      <PrimaryButton
        label="Save password"
        icon="arrow-forward"
        loading={submitting}
        disabled={!isValid}
        onPress={onSubmit}
      />
    </AuthScreenLayout>
  );
}
