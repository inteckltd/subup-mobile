import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';

import { confirmMyMobile, requestMobileVerifyOtp, verifyResetOtp } from '../../src/features/auth/api';
import { AuthScreenLayout } from '../../src/features/auth/components/AuthScreenLayout';
import { OtpInput } from '../../src/features/auth/components/OtpInput';
import { PrimaryButton } from '../../src/features/auth/components/PrimaryButton';
import { useCountdown } from '../../src/features/auth/hooks/useCountdown';
import { maskMobile } from '../../src/lib/phone';
import { useAuth } from '../../src/providers/AuthProvider';

export default function VerifyMobileScreen() {
  const { profile, refreshProfile, signOut } = useAuth();
  const mobile = profile?.mobile ?? null;
  const [code, setCode] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const { remaining, start, isRunning } = useCountdown(60);

  useEffect(() => {
    if (!mobile) return;
    void requestMobileVerifyOtp(mobile).then(({ error }) => {
      if (error) setSubmitError(error);
      else start();
    });
  }, [mobile, start]);

  async function onSubmit() {
    if (!mobile || code.length !== 6) return;
    setSubmitError(null);
    setSubmitting(true);
    const verified = await verifyResetOtp(mobile, code);
    if (verified.error) {
      setSubmitting(false);
      setSubmitError(verified.error);
      return;
    }
    const confirmed = await confirmMyMobile();
    setSubmitting(false);
    if (confirmed.error) {
      setSubmitError(confirmed.error);
      return;
    }
    await refreshProfile();
  }

  async function onResend() {
    if (!mobile || isRunning) return;
    setSubmitError(null);
    setResending(true);
    const { error } = await requestMobileVerifyOtp(mobile);
    setResending(false);
    if (error) {
      setSubmitError(error);
      return;
    }
    start();
  }

  return (
    <AuthScreenLayout
      title="Confirm "
      titleAccent="your mobile."
      subtitle={mobile ? `We sent a code to ${maskMobile(mobile)} so we know it's yours.` : 'Add a UK mobile number first.'}
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
        label="Confirm"
        icon="arrow-forward"
        loading={submitting}
        disabled={code.length !== 6 || !mobile}
        onPress={() => void onSubmit()}
      />

      <Pressable onPress={() => void onResend()} disabled={isRunning || resending || !mobile} hitSlop={8}>
        <Text className="text-center font-sans text-sm text-muted">
          {isRunning ? `Resend code in ${remaining}s` : resending ? 'Sending…' : 'Resend code'}
        </Text>
      </Pressable>

      <Pressable
        onPress={() => {
          void signOut();
          router.replace('/login');
        }}
        hitSlop={8}
      >
        <Text className="text-center font-sans text-sm text-muted">Use a different account</Text>
      </Pressable>
    </AuthScreenLayout>
  );
}
