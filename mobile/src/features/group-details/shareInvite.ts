import { Linking, Platform, Share } from 'react-native';

export function inviteShareFirstName(fullName: string | null | undefined): string {
  const part = fullName?.trim().split(/\s+/)[0];
  return part || 'A teammate';
}

export function buildInviteShareMessage(input: {
  firstName: string;
  groupName: string;
  joinUrl: string;
}): string {
  return `${input.firstName} invited you to ${input.groupName} on SubUp. Join here: ${input.joinUrl}`;
}

function smsUrl(message: string): string {
  const body = encodeURIComponent(message);
  if (Platform.OS === 'ios') {
    return `sms:&body=${body}`;
  }
  return `sms:?body=${body}`;
}

async function fallbackShare(message: string): Promise<void> {
  try {
    await Share.share({ message });
  } catch {
    // User cancelled the share sheet, or no share target is available.
  }
}

async function openOrShare(url: string, message: string): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch {
    await fallbackShare(message);
  }
}

/** Probe the scheme only — a full send URL can make canOpenURL return false. */
const WHATSAPP_SCHEME = 'whatsapp://send';

export async function shareInviteViaWhatsApp(message: string): Promise<void> {
  const text = encodeURIComponent(message);
  // Do not put a phone on the URL. WhatsApp then looks that number up:
  // unregistered contacts get an "Invite via SMS" dialog on Android, and
  // `whatsapp://send?phone=&text=` is a no-op on iOS.
  const nativeUrl = `${WHATSAPP_SCHEME}?text=${text}`;
  const webUrl = `https://wa.me/?text=${text}`;

  try {
    if (await Linking.canOpenURL(WHATSAPP_SCHEME)) {
      await Linking.openURL(nativeUrl);
      return;
    }
    await Linking.openURL(webUrl);
  } catch {
    await fallbackShare(message);
  }
}

export async function shareInviteViaSms(message: string): Promise<void> {
  await openOrShare(smsUrl(message), message);
}
