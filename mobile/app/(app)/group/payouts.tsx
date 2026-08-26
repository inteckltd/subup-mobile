import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '../../../src/features/auth/components/PrimaryButton';
import { useGroupMembers } from '../../../src/features/group-details/hooks';
import {
  type ConnectStatus,
  classifyConnectStatus,
  connectAccountReady,
  connectSetupButtonLabel,
  connectStatusMessage,
  fetchGroupPayouts,
  invalidatePayoutsQueries,
  setGroupPayoutUser,
  startConnectOnboarding,
  syncConnectStatus,
  syncConnectStatusUntilReady,
} from '../../../src/features/payments/api';
import { useAuth } from '../../../src/providers/AuthProvider';
import { colors } from '../../../src/theme/tokens';

export default function GroupPayoutsScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const membersQuery = useGroupMembers(groupId);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payoutsQuery = useQuery({
    queryKey: ['group', groupId, 'payouts', session?.user.id],
    queryFn: () => fetchGroupPayouts(groupId as string),
    enabled: !!session && !!groupId,
  });

  const payouts = payoutsQuery.data;
  const admins = (membersQuery.data ?? []).filter((member) => member.role === 'admin');
  const [connectStatus, setConnectStatus] = useState<ConnectStatus>({});

  const refreshFromStripe = useCallback(
    async (opts?: { poll?: boolean }) => {
      const status = opts?.poll ? await syncConnectStatusUntilReady() : await syncConnectStatus();
      setConnectStatus(status);
      if (status.error) {
        setError(status.error);
      } else if (connectAccountReady(status)) {
        setError(null);
      } else {
        setError(connectStatusMessage(status));
      }
      await invalidatePayoutsQueries(queryClient);
      await queryClient.refetchQueries({ queryKey: ['group', groupId, 'payouts'] });
      return status;
    },
    [groupId, queryClient],
  );

  useFocusEffect(
    useCallback(() => {
      void refreshFromStripe();
    }, [refreshFromStripe]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refreshFromStripe();
    });
    return () => sub.remove();
  }, [refreshFromStripe]);

  const connectNeed = classifyConnectStatus(connectStatus);

  useEffect(() => {
    if (connectNeed !== 'in_review') return;
    const id = setInterval(() => {
      void refreshFromStripe();
    }, 10_000);
    return () => clearInterval(id);
  }, [connectNeed, refreshFromStripe]);

  async function onSetup() {
    setError(null);
    setWorking(true);
    const result = await startConnectOnboarding();
    if (result.error || !result.url) {
      setWorking(false);
      setError(result.error ?? "Couldn't start payouts setup.");
      return;
    }
    await WebBrowser.openAuthSessionAsync(result.url, 'subup://stripe-connect/return');
    const status = await refreshFromStripe({ poll: true });
    if (!status.error && !connectAccountReady(status)) {
      setError(connectStatusMessage(status));
    }
    setWorking(false);
  }

  function onChangeTreasurer() {
    if (!groupId || admins.length < 2) return;
    Alert.alert(
      'Who receives pitch money?',
      'Only a group admin can be the treasurer. They must finish Stripe payouts setup before paid games can be created.',
      [
        ...admins.map((admin) => ({
          text: admin.userId === payouts?.payoutUserId ? `${admin.name} (current)` : admin.name,
          onPress: async () => {
            setWorking(true);
            const result = await setGroupPayoutUser(groupId, admin.userId);
            setWorking(false);
            if (result.error) {
              setError(result.error);
              return;
            }
            await refreshFromStripe();
          },
        })),
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }

  if (payoutsQuery.isPending) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!payouts || !payouts.isAdmin) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background px-8">
        <Text className="text-center font-sans text-sm text-muted">Only admins can manage payouts.</Text>
        <PrimaryButton label="Back" className="mt-6 w-auto px-8" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  const ready = payouts.chargesEnabled && payouts.transfersEnabled;

  return (
    <View className="flex-1 bg-background">
      <SafeAreaView edges={['top']} className="bg-white">
        <View className="flex-row items-center gap-4 border-b border-border px-4 py-4">
          <Pressable onPress={() => router.back()} className="h-10 w-10 items-center justify-center rounded-full bg-background">
            <Ionicons name="chevron-back" size={18} color={colors.ink} />
          </Pressable>
          <Text className="font-sans-bold text-lg text-ink">Payouts</Text>
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
        <View className="rounded-2xl bg-white p-4">
          <Text className="font-sans-bold text-xs uppercase tracking-wider text-muted">Treasurer</Text>
          <Text className="mt-2 font-sans-bold text-base text-ink">{payouts.treasurerName}</Text>
          <Text className="mt-1 font-sans text-sm text-muted">
            Pitch money stays in Stripe until a game locks and players can no longer leave. After that, this admin’s
            pitch total is paid to their UK bank — usually around 2 business days. SubUp’s fee is collected when a
            player pays.
          </Text>
          {admins.length > 1 ? (
            <Pressable onPress={onChangeTreasurer} className="mt-3">
              <Text className="font-sans-bold text-sm text-primary">Change treasurer</Text>
            </Pressable>
          ) : null}
        </View>

        <View className="rounded-2xl bg-white p-4">
          <View className="flex-row items-center gap-2">
            <Ionicons name={ready ? 'checkmark-circle' : 'alert-circle-outline'} size={20} color={ready ? colors.primary : colors.muted} />
            <Text className="font-sans-bold text-base text-ink">{ready ? 'Payouts are ready' : 'Payouts not set up yet'}</Text>
          </View>
          <Text className="mt-2 font-sans text-sm text-muted">
            {ready
              ? payouts.payoutsEnabled
                ? 'This group can create paid games. Players pay in the app with Apple Pay, Google Pay, or card.'
                : 'Payments can be taken. Stripe is still verifying the bank account for payouts.'
              : 'The treasurer completes a short Stripe form (name, address, photo ID, sort code and account number). Stripe hosts this — SubUp never sees those details.'}
          </Text>
        </View>

        {error ? <Text className="font-sans-medium text-sm text-danger">{error}</Text> : null}

        {payouts.isSelf ? (
          <PrimaryButton
            label={ready ? 'Update payout details' : connectSetupButtonLabel(connectStatus)}
            loading={working}
            onPress={onSetup}
          />
        ) : (
          <Text className="font-sans text-sm text-muted">
            Ask {payouts.treasurerName} to open this screen and tap Set up payouts.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
