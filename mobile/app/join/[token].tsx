import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '../../src/features/auth/components/PrimaryButton';
import { claimGroupJoinLink, previewGroupJoinLink } from '../../src/features/group-details/api';
import {
  clearPendingJoinToken,
  isJoinToken,
  stashPendingJoinToken,
} from '../../src/features/group-details/joinLink';
import { acceptGroupInvite } from '../../src/features/notifications/api';
import { useAuth } from '../../src/providers/AuthProvider';
import { colors } from '../../src/theme/tokens';

export default function JoinGroupScreen() {
  const { token: rawToken } = useLocalSearchParams<{ token: string }>();
  const token = typeof rawToken === 'string' ? rawToken : '';
  const { initializing, session, hasMobile, mobileVerified, legalCurrent, passwordRecovery } = useAuth();
  const isFullyAuthed = !!session && hasMobile && mobileVerified && legalCurrent && !passwordRecovery;

  const [groupName, setGroupName] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isJoinToken(token)) {
      setInvalid(true);
      setLoading(false);
      return;
    }
    if (!isFullyAuthed) {
      void stashPendingJoinToken(token);
    } else {
      void clearPendingJoinToken();
    }
  }, [token, isFullyAuthed]);

  useEffect(() => {
    if (!isJoinToken(token)) return;
    let cancelled = false;
    void (async () => {
      try {
        const preview = await previewGroupJoinLink(token);
        if (cancelled) return;
        if (!preview) {
          setInvalid(true);
          setLoading(false);
          return;
        }
        setGroupName(preview.groupName);
        setGroupId(preview.groupId);
        setInvalid(false);
      } catch {
        if (!cancelled) setInvalid(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const goHome = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(isFullyAuthed ? '/' : '/login');
  }, [isFullyAuthed]);

  const onJoin = async () => {
    if (!isFullyAuthed) {
      router.replace('/login');
      return;
    }
    setError(null);
    setJoining(true);
    const claimed = await claimGroupJoinLink(token);
    if (claimed.error || !claimed.claim) {
      setJoining(false);
      setError(claimed.error ?? "Couldn't open this invite.");
      return;
    }
    if (claimed.claim.alreadyMember) {
      setJoining(false);
      router.replace(`/group/${claimed.claim.groupId}`);
      return;
    }
    if (!claimed.claim.inviteId) {
      setJoining(false);
      setError("Couldn't open this invite.");
      return;
    }
    const accepted = await acceptGroupInvite(claimed.claim.inviteId);
    setJoining(false);
    if (accepted.error) {
      setError(accepted.error);
      return;
    }
    router.replace(`/group/${claimed.claim.groupId}`);
  };

  const busy = initializing || loading;

  return (
    <View className="flex-1 bg-background">
      <SafeAreaView edges={['top']} className="bg-white">
        <View className="w-full flex-row items-center justify-between border-b border-border px-4 py-4">
          <Pressable
            onPress={goHome}
            hitSlop={8}
            className="h-10 w-10 items-center justify-center rounded-full bg-background"
          >
            <Ionicons name="chevron-back" size={18} color={colors.ink} />
          </Pressable>
          <Text className="font-sans-bold text-lg text-ink">Join group</Text>
          <View className="h-10 w-10" />
        </View>
      </SafeAreaView>

      <View className="flex-1 px-6 pt-10">
        {busy ? (
          <View className="items-center pt-16">
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : invalid ? (
          <Text className="font-sans text-sm text-muted">This invite link isn&apos;t valid.</Text>
        ) : (
          <View className="gap-6">
            <View className="gap-2">
              <Text className="font-sans-bold text-2xl text-ink">
                You&apos;re invited{groupName ? ` to ${groupName}` : ''}
              </Text>
              <Text className="font-sans text-sm text-muted">
                {isFullyAuthed
                  ? 'Join this group to see games and play with this squad.'
                  : 'Log in or create an account to join. After you sign in, this invite will still be here.'}
              </Text>
            </View>
            {error ? <Text className="font-sans-medium text-sm text-danger">{error}</Text> : null}
            <PrimaryButton
              label={isFullyAuthed ? `Join${groupName ? ` ${groupName}` : ''}` : 'Log in to join'}
              loading={joining}
              onPress={() => void onJoin()}
            />
            {!isFullyAuthed ? (
              <Pressable onPress={() => router.replace('/sign-up')} className="items-center py-2">
                <Text className="font-sans-bold text-sm text-primary">Create an account</Text>
              </Pressable>
            ) : groupId ? (
              <Pressable onPress={goHome} className="items-center py-2">
                <Text className="font-sans-bold text-sm text-muted">Not now</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>
    </View>
  );
}
