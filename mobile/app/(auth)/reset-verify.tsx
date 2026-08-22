import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';

import { requestPasswordReset, verifyResetOtp } from '../../src/features/auth/api';
import { AuthScreenLayout } from '../../src/features/auth/components/AuthScreenLayout';
import { OtpInput } from '../../src/features/auth/components/OtpInput';
import { PrimaryButton } from '../../src/features/auth/components/PrimaryButton';
import { useCountdown } from '../../src/features/auth/hooks/useCountdown';
import { maskMobile } from '../../src/lib/phone';
import { useAuth } from '../../src/providers/AuthProvider';

export default function ResetVerifyScreen() {
  const { recoveryMobile } = useAuth();
  const [code, setCode] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const { remaining, start, isRunning } = useCountdown(60);

  useEffect(() => {
    if (!recoveryMobile) {
      router.replace('/forgot-password');
      return;
    }
    start();
  }, [recoveryMobile, start]);

  async function onSubmit() {
    if (!recoveryMobile || code.length !== 6) return;
    setSubmitError(null);
    setSubmitting(true);
    const { error } = await verifyResetOtp(recoveryMobile, code);
    setSubmitting(false);
    if (error) {
      setSubmitError(error);
      return;
    }
    router.replace('/reset-password');
  }

  async function onResend() {
    if (!recoveryMobile || isRunning) return;
    setSubmitError(null);
    setResending(true);
    const { error } = await requestPasswordReset(recoveryMobile);
    setResending(false);
    if (error) {
      setSubmitError(error);
      return;
    }
    start();
  }

  return (
    <AuthScreenLayout
      showBack
      title="Enter "
      titleAccent="the code."
      subtitle={recoveryMobile ? `Sent to ${maskMobile(recoveryMobile)}` : 'Check your texts for a 6-digit code.'}
      heroImage={require('../../assets/images/auth-hero-login.jpg')}
    >
      <OtpInput
        value={code}
        onChange={(next) => {
          setCode(next);
          setSubmitError(null);
        }}
        error={submitError ?? undefined}
      />

      <PrimaryButton
        label="Verify"
        icon="arrow-forward"
        loading={submitting}
        disabled={code.length !== 6}
        onPress={() => void onSubmit()}
      />

      <Pressable onPress={() => void onResend()} disabled={isRunning || resending} hitSlop={8}>
        <Text className="text-center font-sans text-sm text-muted">
          {isRunning ? `Resend code in ${remaining}s` : resending ? 'Sending…' : 'Resend code'}
        </Text>
      </Pressable>
    </AuthScreenLayout>
  );
}
