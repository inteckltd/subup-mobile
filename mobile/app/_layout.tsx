import 'react-native-gesture-handler';
import '../global.css';

import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_700Bold,
  Manrope_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/manrope';
import { StripeProvider } from '@stripe/stripe-react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { env } from '../src/lib/env';
import { queryClient } from '../src/lib/queryClient';
import { initSentry, Sentry } from '../src/lib/sentry';
import { AuthProvider, useAuth } from '../src/providers/AuthProvider';
import { ConnectivityProvider } from '../src/providers/ConnectivityProvider';
import { colors } from '../src/theme/tokens';

SplashScreen.preventAutoHideAsync().catch(() => {});
initSentry();

function RootLayout() {
  const [fontsLoaded] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_700Bold,
    Manrope_800ExtraBold,
  });

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <QueryClientProvider client={queryClient}>
            <ConnectivityProvider>
              <AuthProvider>
                <StripeProvider
                  publishableKey={env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? ''}
                  merchantIdentifier="merchant.com.inteck.pitchin"
                  urlScheme="subup"
                >
                  <RootNavigator fontsLoaded={fontsLoaded} />
                </StripeProvider>
              </AuthProvider>
            </ConnectivityProvider>
          </QueryClientProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function RootNavigator({ fontsLoaded }: { fontsLoaded: boolean }) {
  const { initializing, session, hasMobile, mobileVerified, legalCurrent, passwordRecovery } = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const ready = fontsLoaded && !initializing;

  const isFullyAuthed = !!session && hasMobile && mobileVerified && legalCurrent && !passwordRecovery;
  const needsMobileVerify = !!session && hasMobile && !mobileVerified && !passwordRecovery;
  const needsLegal = !!session && hasMobile && mobileVerified && !legalCurrent && !passwordRecovery;

  useEffect(() => {
    if (ready) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [ready]);

  useEffect(() => {
    if (!ready || !needsMobileVerify) return;
    const leaf = segments[segments.length - 1];
    if (leaf === 'verify-mobile') return;
    router.replace('/verify-mobile');
  }, [needsMobileVerify, ready, router, segments]);

  useEffect(() => {
    if (!ready || !needsLegal) return;
    const root = segments[0];
    if (root === 'accept-terms') return;
    // Reading the docs from the accept screen — keep them there if they pushed.
    if ((root === 'terms' || root === 'privacy') && router.canGoBack()) return;
    router.replace('/accept-terms');
  }, [needsLegal, ready, router, segments]);

  useEffect(() => {
    if (!ready || !passwordRecovery || !session) return;
    const leaf = segments[segments.length - 1];
    if (leaf === 'reset-password') return;
    router.replace('/reset-password');
  }, [passwordRecovery, ready, router, segments, session]);

  if (!ready) {
    return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={isFullyAuthed}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={needsLegal}>
        <Stack.Screen name="accept-terms" />
      </Stack.Protected>
      <Stack.Protected guard={!isFullyAuthed && !needsLegal}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      <Stack.Screen name="terms" />
      <Stack.Screen name="privacy" />
    </Stack>
  );
}

export default Sentry.wrap(RootLayout);
