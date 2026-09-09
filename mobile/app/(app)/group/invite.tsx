import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getGroupJoinToken } from '../../../src/features/group-details/api';
import { useGroupDetail } from '../../../src/features/group-details/hooks';
import { groupJoinUrl } from '../../../src/features/group-details/joinLink';
import {
  buildInviteShareMessage,
  inviteShareFirstName,
  shareInviteViaSms,
  shareInviteViaWhatsApp,
} from '../../../src/features/group-details/shareInvite';
import { useAuth } from '../../../src/providers/AuthProvider';
import { colors } from '../../../src/theme/tokens';

export default function InviteMemberScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { profile } = useAuth();
  const groupQuery = useGroupDetail(groupId);
  const [token, setToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sharingWhatsApp, setSharingWhatsApp] = useState(false);
  const [sharingSms, setSharingSms] = useState(false);

  const isAdmin = groupQuery.data?.role === 'admin';
  const joinUrl = token ? groupJoinUrl(token) : null;
  const shareMessage =
    joinUrl && groupQuery.data
      ? buildInviteShareMessage({
          firstName: inviteShareFirstName(profile?.full_name),
          groupName: groupQuery.data.name,
          joinUrl,
        })
      : null;

  useEffect(() => {
    if (!groupId || groupQuery.data?.role !== 'admin') return;
    let cancelled = false;
    void (async () => {
      const result = await getGroupJoinToken(groupId);
      if (cancelled) return;
      if (result.error || !result.token) {
        setLoadError(result.error ?? "Couldn't load the join link.");
        return;
      }
      setLoadError(null);
      setToken(result.token);
    })();
    return () => {
      cancelled = true;
    };
  }, [groupId, groupQuery.data?.role]);

  const onCopy = async () => {
    if (!joinUrl) return;
    setShareError(null);
    await Clipboard.setStringAsync(joinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const onShareWhatsApp = async () => {
    if (!shareMessage) return;
    setShareError(null);
    setSharingWhatsApp(true);
    try {
      await shareInviteViaWhatsApp(shareMessage);
    } catch {
      setShareError("Couldn't open WhatsApp.");
    } finally {
      setSharingWhatsApp(false);
    }
  };

  const onShareMessages = async () => {
    if (!shareMessage) return;
    setShareError(null);
    setSharingSms(true);
    try {
      await shareInviteViaSms(shareMessage);
    } catch {
      setShareError("Couldn't open Messages.");
    } finally {
      setSharingSms(false);
    }
  };

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
          <Text className="font-sans-bold text-lg text-ink">Invite members</Text>
          <View className="h-10 w-10" />
        </View>
      </SafeAreaView>

      {groupQuery.isPending ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : !isAdmin ? (
        <View className="px-6 pt-10">
          <Text className="font-sans text-sm text-muted">Only admins can invite members.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 48, gap: 16 }}>
          <Text className="font-sans text-sm text-muted">
            Share this group&apos;s join link. Anyone who opens it can join after they sign in. WhatsApp and Messages
            send the same link — you pick who to send it to.
          </Text>

          {loadError ? (
            <Text className="font-sans-medium text-sm text-danger">{loadError}</Text>
          ) : !joinUrl ? (
            <View className="items-center py-8">
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : (
            <>
              <View className="gap-3 rounded-2xl border border-border bg-white p-4">
                <Text className="font-sans-medium text-xs uppercase tracking-wide text-muted">Join link</Text>
                <Text selectable className="font-sans text-sm text-ink">
                  {joinUrl}
                </Text>
                <Pressable
                  onPress={() => void onCopy()}
                  className="flex-row items-center justify-center gap-2 rounded-2xl bg-primary py-3.5"
                >
                  <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={16} color={colors.white} />
                  <Text className="font-sans-bold text-sm text-white">{copied ? 'Copied' : 'Copy link'}</Text>
                </Pressable>
              </View>

              <View className="flex-row gap-3">
                <Pressable
                  onPress={() => void onShareWhatsApp()}
                  disabled={sharingWhatsApp || sharingSms}
                  className="flex-1 flex-row items-center justify-center gap-2 rounded-2xl border border-border bg-white py-3.5"
                >
                  {sharingWhatsApp ? (
                    <ActivityIndicator color={colors.ink} />
                  ) : (
                    <>
                      <Ionicons name="logo-whatsapp" size={18} color={colors.ink} />
                      <Text className="font-sans-bold text-sm text-ink">WhatsApp</Text>
                    </>
                  )}
                </Pressable>
                <Pressable
                  onPress={() => void onShareMessages()}
                  disabled={sharingWhatsApp || sharingSms}
                  className="flex-1 flex-row items-center justify-center gap-2 rounded-2xl border border-border bg-white py-3.5"
                >
                  {sharingSms ? (
                    <ActivityIndicator color={colors.ink} />
                  ) : (
                    <>
                      <Ionicons name="chatbubble-outline" size={18} color={colors.ink} />
                      <Text className="font-sans-bold text-sm text-ink">Messages</Text>
                    </>
                  )}
                </Pressable>
              </View>
            </>
          )}

          {shareError ? <Text className="font-sans-medium text-sm text-danger">{shareError}</Text> : null}
        </ScrollView>
      )}
    </View>
  );
}
