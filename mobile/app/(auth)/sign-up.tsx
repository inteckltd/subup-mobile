import { zodResolver } from '@hookform/resolvers/zod';
import { Link, router } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { Text } from 'react-native';

import { signUpWithPassword } from '../../src/features/auth/api';
import { AuthScreenLayout } from '../../src/features/auth/components/AuthScreenLayout';
import { Checkbox } from '../../src/features/auth/components/Checkbox';
import { PrimaryButton } from '../../src/features/auth/components/PrimaryButton';
import { TextField } from '../../src/features/auth/components/TextField';
import { SignUpFormValues, signUpSchema } from '../../src/features/auth/schemas';
import { normalizeUkMobile } from '../../src/lib/phone';
import { useAuth } from '../../src/providers/AuthProvider';

export default function SignUpScreen() {
  const { refreshProfile, endPasswordRecovery } = useAuth();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const {
    control,
    handleSubmit,
    setValue,
    formState: { errors, isValid },
  } = useForm<SignUpFormValues>({
    resolver: zodResolver(signUpSchema),
    mode: 'onChange',
    defaultValues: { fullName: '', mobile: '', password: '', confirmPassword: '', email: '', acceptTerms: false },
  });

  const acceptTerms = useWatch({ control, name: 'acceptTerms' });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    const mobile = normalizeUkMobile(values.mobile);
    if (!mobile) {
      setSubmitError('Enter a valid UK mobile number.');
      return;
    }

    setSubmitting(true);
    const { error } = await signUpWithPassword({
      mobile,
      password: values.password,
      fullName: values.fullName,
      email: values.email,
    });
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
      title="Join the "
      titleAccent="Squad."
      subtitle="Create your profile to get started"
      showBack
      heroImage={require('../../assets/images/auth-hero-login.jpg')}
    >
      <Controller
        control={control}
        name="fullName"
        render={({ field }) => (
          <TextField
            label="Full name"
            icon="person-outline"
            placeholder="Ben Clarke"
            autoCapitalize="words"
            textContentType="name"
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
            label="Email address (optional)"
            icon="mail-outline"
            placeholder="ben@example.com"
            autoCapitalize="none"
            keyboardType="email-address"
            textContentType="emailAddress"
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
      <Controller
        control={control}
        name="password"
        render={({ field }) => (
          <TextField
            label="Password"
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
            placeholder="Re-enter your password"
            isPassword
            textContentType="newPassword"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.confirmPassword?.message}
          />
        )}
      />

      <Checkbox checked={!!acceptTerms} onToggle={() => setValue('acceptTerms', !acceptTerms, { shouldValidate: true })}>
        <Text className="font-sans text-xs text-muted">
          By creating an account, you agree to our{' '}
          <Link href="/terms">
            <Text className="font-sans-bold text-xs text-ink underline">Terms</Text>
          </Link>{' '}
          and{' '}
          <Link href="/privacy">
            <Text className="font-sans-bold text-xs text-ink underline">Privacy Policy</Text>
          </Link>
          .
        </Text>
      </Checkbox>
      {errors.acceptTerms ? <Text className="font-sans-medium text-xs text-danger">{errors.acceptTerms.message}</Text> : null}

      {submitError ? <Text className="font-sans-medium text-sm text-danger">{submitError}</Text> : null}

      <PrimaryButton label="Join the Squad" icon="person-add-outline" loading={submitting} disabled={!isValid} onPress={onSubmit} />

      <Text className="text-center font-sans text-sm text-muted">
        Already have an account?{' '}
        <Link href="/login">
          <Text className="font-sans-bold text-primary underline">Log in</Text>
        </Link>
      </Text>
    </AuthScreenLayout>
  );
}
