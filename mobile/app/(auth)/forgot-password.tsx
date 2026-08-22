import { zodResolver } from '@hookform/resolvers/zod';
import { router } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Text } from 'react-native';

import { requestPasswordReset } from '../../src/features/auth/api';
import { AuthScreenLayout } from '../../src/features/auth/components/AuthScreenLayout';
import { PrimaryButton } from '../../src/features/auth/components/PrimaryButton';
import { TextField } from '../../src/features/auth/components/TextField';
import { ForgotPasswordFormValues, forgotPasswordSchema } from '../../src/features/auth/schemas';
import { normalizeUkMobile } from '../../src/lib/phone';
import { useAuth } from '../../src/providers/AuthProvider';

export default function ForgotPasswordScreen() {
  const { beginPasswordRecovery } = useAuth();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const {
    control,
    handleSubmit,
    formState: { errors, isValid },
  } = useForm<ForgotPasswordFormValues>({
    resolver: zodResolver(forgotPasswordSchema),
    mode: 'onChange',
    defaultValues: { mobile: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    const mobile = normalizeUkMobile(values.mobile);
    if (!mobile) {
      setSubmitError('Enter a valid UK mobile number.');
      return;
    }

    setSubmitting(true);
    const { error } = await requestPasswordReset(mobile);
    setSubmitting(false);

    if (error) {
      setSubmitError(error);
      return;
    }

    beginPasswordRecovery(mobile);
    router.push('/reset-verify');
  });

  return (
    <AuthScreenLayout
      showBack
      title="Forgot "
      titleAccent="password."
      subtitle="If that number has an account, we'll send a code."
      heroImage={require('../../assets/images/auth-hero-login.jpg')}
    >
      <Controller
        control={control}
        name="mobile"
        render={({ field }) => (
          <TextField
            label="Phone number"
            icon="call-outline"
            placeholder="07912 345678"
            keyboardType="phone-pad"
            textContentType="telephoneNumber"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.mobile?.message}
          />
        )}
      />

      {submitError ? <Text className="font-sans-medium text-sm text-danger">{submitError}</Text> : null}

      <PrimaryButton label="Send code" icon="arrow-forward" loading={submitting} disabled={!isValid} onPress={onSubmit} />
    </AuthScreenLayout>
  );
}
