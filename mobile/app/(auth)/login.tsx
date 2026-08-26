import { zodResolver } from '@hookform/resolvers/zod';
import { Link, router } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Text } from 'react-native';

import { loginWithPassword } from '../../src/features/auth/api';
import { AuthScreenLayout } from '../../src/features/auth/components/AuthScreenLayout';
import { PrimaryButton } from '../../src/features/auth/components/PrimaryButton';
import { TextField } from '../../src/features/auth/components/TextField';
import { LoginFormValues, loginSchema } from '../../src/features/auth/schemas';
import { nationaliseUkMobileInput, normalizeUkMobile } from '../../src/lib/phone';
import { useAuth } from '../../src/providers/AuthProvider';

export default function LoginScreen() {
  const { refreshProfile, endPasswordRecovery } = useAuth();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const {
    control,
    handleSubmit,
    formState: { errors, isValid },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    mode: 'onChange',
    defaultValues: { mobile: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    const mobile = normalizeUkMobile(values.mobile);
    if (!mobile) {
      setSubmitError('Enter a valid UK mobile number.');
      return;
    }

    setSubmitting(true);
    const { error } = await loginWithPassword(mobile, values.password);
    setSubmitting(false);

    if (error) {
      setSubmitError(error);
      return;
    }

    endPasswordRecovery();
    await refreshProfile();
    router.replace('/');
  });

  return (
    <AuthScreenLayout
      title="Welcome "
      titleAccent="back."
      subtitle="Log in to your SubUp account"
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
            onBlur={() => {
              field.onChange(nationaliseUkMobileInput(field.value));
              field.onBlur();
            }}
            error={errors.mobile?.message}
          />
        )}
      />
      <Controller
        control={control}
        name="password"
        render={({ field }) => (
          <TextField
            label="Password"
            icon="lock-closed-outline"
            placeholder="Your password"
            isPassword
            textContentType="password"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.password?.message}
          />
        )}
      />

      <Link href="/forgot-password" className="self-end">
        <Text className="font-sans-bold text-sm text-primary">Forgot password?</Text>
      </Link>

      {submitError ? <Text className="font-sans-medium text-sm text-danger">{submitError}</Text> : null}

      <PrimaryButton label="Continue" icon="arrow-forward" loading={submitting} disabled={!isValid} onPress={onSubmit} />

      <Text className="text-center font-sans text-sm text-muted">
        {"Don't have an account? "}
        <Link href="/sign-up">
          <Text className="font-sans-bold text-primary underline">Sign up now</Text>
        </Link>
      </Text>
    </AuthScreenLayout>
  );
}
