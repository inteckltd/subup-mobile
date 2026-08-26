import { Link, router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { acceptCurrentLegal } from '../src/features/auth/api';
import { Checkbox } from '../src/features/auth/components/Checkbox';
import { PrimaryButton } from '../src/features/auth/components/PrimaryButton';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/features/auth/schemas';
import { useAuth } from '../src/providers/AuthProvider';

export default function AcceptTermsScreen() {
  const { refreshProfile, signOut } = useAuth();
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onAccept() {
    if (!accepted) return;
    setError(null);
    setSubmitting(true);
    const result = await acceptCurrentLegal();
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    await refreshProfile();
    router.replace('/');
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <View className="flex-1 justify-center gap-6 px-6">
        <View className="gap-2">
          <Text className="font-sans-extrabold text-2xl text-ink">Updated terms</Text>
          <Text className="font-sans text-base text-muted">
            We&apos;ve updated our Terms of Service (v{TERMS_VERSION}) and Privacy Policy (v{PRIVACY_VERSION}). Please
            review and accept them to keep using SubUp.
          </Text>
        </View>

        <Checkbox checked={accepted} onToggle={() => setAccepted((value) => !value)}>
          <Text className="font-sans text-sm text-muted">
            I agree to the{' '}
            <Link href="/terms">
              <Text className="font-sans-bold text-sm text-ink underline">Terms of Service</Text>
            </Link>{' '}
            and{' '}
            <Link href="/privacy">
              <Text className="font-sans-bold text-sm text-ink underline">Privacy Policy</Text>
            </Link>
            .
          </Text>
        </Checkbox>

        {error ? <Text className="font-sans-medium text-sm text-danger">{error}</Text> : null}

        <PrimaryButton
          label="Accept and continue"
          loading={submitting}
          disabled={!accepted}
          onPress={() => void onAccept()}
        />
        <PrimaryButton label="Log out" variant="outline" onPress={() => void signOut()} />
      </View>
    </SafeAreaView>
  );
}
