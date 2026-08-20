import { Text } from 'react-native';

export function TermsCopy() {
  return (
    <>
      <Text className="font-sans text-base text-ink">
        Welcome to PitchIn. These are placeholder Terms of Service for development. By using the app you agree to play
        fair, treat your mates with respect, and use PitchIn only to organise recreational sport.
      </Text>
      <Text className="font-sans text-base text-ink">
        PitchIn is provided as-is during early development. Features, availability, and these terms may change as the
        product evolves. We&apos;ll let you know before anything important changes.
      </Text>
      <Text className="font-sans text-base text-ink">
        You&apos;re responsible for keeping your login details secure and for the accuracy of the information you
        provide, including your mobile number.
      </Text>
      <Text className="font-sans text-base text-muted">
        This placeholder will be replaced with PitchIn&apos;s full Terms of Service before public launch.
      </Text>
    </>
  );
}

export function PrivacyCopy() {
  return (
    <>
      <Text className="font-sans text-base text-ink">
        This is placeholder Privacy Policy copy for PitchIn&apos;s development build.
      </Text>
      <Text className="font-sans text-base text-ink">
        We store your name, UK mobile number, and optional email to create your account and let your mates find and
        invite you to games. Your mobile number is your login.
      </Text>
      <Text className="font-sans text-base text-ink">
        We don&apos;t sell your data. Data is stored securely with our backend provider, Supabase, in the UK/EU region.
      </Text>
      <Text className="font-sans text-base text-muted">
        This placeholder will be replaced with PitchIn&apos;s full Privacy Policy before public launch.
      </Text>
    </>
  );
}
