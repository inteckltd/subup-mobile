import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '../../../src/features/auth/components/PrimaryButton';
import { deleteMyAccount } from '../../../src/features/profile/api';
import { clearDiagnosticErrors, getDiagnosticErrors } from '../../../src/lib/diagnostics';
import { useAuth } from '../../../src/providers/AuthProvider';
import { useConnectivity } from '../../../src/providers/ConnectivityProvider';
import { colors } from '../../../src/theme/tokens';

const VERSION_TAP_WINDOW_MS = 2000;
const VERSION_TAP_COUNT = 7;

function appVersion(): string {
  return Constants.expoConfig?.version ?? Constants.nativeAppVersion ?? '1.0.0';
}

function appBuild(): string {
  return Constants.nativeBuildVersion ?? '—';
}

function Row({
  label,
  subtitle,
  onPress,
  danger,
}: {
  label: string;
  subtitle?: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center justify-between rounded-2xl border border-border bg-white px-4 py-4"
    >
      <View className="flex-1 pr-3">
        <Text className={`font-sans-bold text-sm ${danger ? 'text-danger' : 'text-ink'}`}>{label}</Text>
        {subtitle ? <Text className="pt-0.5 font-sans text-xs text-muted">{subtitle}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={danger ? colors.danger : colors.muted} />
    </Pressable>
  );
}

export default function SettingsScreen() {
  const { session, signOut } = useAuth();
  const { isOnline } = useConnectivity();
  const [debugOpen, setDebugOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [errors, setErrors] = useState(getDiagnosticErrors);
  const taps = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const version = appVersion();
  const build = appBuild();

  function onTapVersion() {
    taps.current += 1;
    if (tapTimer.current) clearTimeout(tapTimer.current);
    tapTimer.current = setTimeout(() => {
      taps.current = 0;
    }, VERSION_TAP_WINDOW_MS);
    if (taps.current >= VERSION_TAP_COUNT) {
      taps.current = 0;
      setErrors(getDiagnosticErrors());
      setDebugOpen(true);
    }
  }

  async function copyDiagnostics() {
    const blob = [
      'SubUp diagnostics',
      `version: ${version}`,
      `build: ${build}`,
      `platform: ${Platform.OS}`,
      `userId: ${session?.user.id ?? '—'}`,
      `online: ${isOnline ? 'yes' : 'no'}`,
    ].join('\n');
    await Clipboard.setStringAsync(blob);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function confirmLogout() {
    Alert.alert('Log out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => void signOut() },
    ]);
  }

  function confirmDeleteAccount() {
    Alert.alert(
      'Delete account?',
      'This permanently deletes your account and removes you from every group. Past games will show you as Deleted user. You can’t undo this.',
      [
        { text: 'Keep account', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Are you sure?',
              'If you are the last admin of a group that still has members, promote someone else first. Groups where you are the only member will be deleted.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete my account',
                  style: 'destructive',
                  onPress: () => {
                    void (async () => {
                      const result = await deleteMyAccount();
                      if (result.error) {
                        Alert.alert("Couldn't delete account", result.error);
                        return;
                      }
                      await signOut();
                    })();
                  },
                },
              ],
            );
          },
        },
      ],
    );
  }

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
          <Text className="font-sans-bold text-lg text-ink">Settings</Text>
          <View className="h-10 w-10" />
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 48, gap: 12 }}>
        <Pressable onPress={onTapVersion} className="rounded-2xl border border-border bg-white px-4 py-4">
          <Text className="font-sans-bold text-[10px] uppercase tracking-wide text-muted">App version</Text>
          <Text className="pt-1 font-sans-bold text-base text-ink">
            {version} ({build})
          </Text>
        </Pressable>

        <Row label="Terms of Service" onPress={() => router.push('/terms')} />
        <Row label="Privacy Policy" onPress={() => router.push('/privacy')} />
        <Row
          label={copied ? 'Copied' : 'Copy diagnostics'}
          subtitle="Version, user id, and connection status for support"
          onPress={() => void copyDiagnostics()}
        />

        {debugOpen ? (
          <View className="gap-3 rounded-2xl border border-border bg-white p-4">
            <Text className="font-sans-bold text-sm text-ink">Developer tools</Text>
            {errors.length === 0 ? (
              <Text className="font-sans text-xs text-muted">No client errors recorded this session.</Text>
            ) : (
              errors.map((entry, index) => (
                <View key={`${entry.at}-${index}`} className="gap-0.5 border-t border-border pt-2">
                  <Text className="font-sans-bold text-[10px] uppercase tracking-wide text-muted">
                    {entry.source} · {entry.at}
                  </Text>
                  <Text className="font-sans text-xs text-ink">{entry.message}</Text>
                </View>
              ))
            )}
            <View className="flex-row gap-2 pt-1">
              <View className="flex-1">
                <PrimaryButton
                  label="Copy errors"
                  variant="outline"
                  onPress={() => {
                    const blob = errors.map((entry) => `[${entry.at}] ${entry.source}: ${entry.message}`).join('\n');
                    void Clipboard.setStringAsync(blob || 'No client errors recorded this session.');
                  }}
                />
              </View>
              <View className="flex-1">
                <PrimaryButton
                  label="Clear"
                  variant="outline"
                  onPress={() => {
                    clearDiagnosticErrors();
                    setErrors([]);
                  }}
                />
              </View>
            </View>
          </View>
        ) : null}

        <View className="pt-4 gap-3">
          <PrimaryButton label="Log out" variant="outline" onPress={confirmLogout} />
          <Row
            label="Delete account"
            subtitle="Permanently wipe your account and data"
            danger
            onPress={confirmDeleteAccount}
          />
        </View>
      </ScrollView>
    </View>
  );
}
