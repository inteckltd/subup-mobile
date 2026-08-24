import { Linking, Platform, Share } from 'react-native';

import { normalizeUkMobile } from '../../lib/phone';

export function inviteShareFirstName(fullName: string | null | undefined): string {
  const part = fullName?.trim().split(/\s+/)[0];
  return part || 'A teammate';
}

export function buildInviteShareMessage(input: {
  firstName: string;
  groupName: string;
  url: string;
  existingUser?: boolean;
}): string {
  if (input.existingUser) {
    return `${input.firstName} invited you to ${input.groupName} on PitchIn. Open the app to accept.`;
  }
  return `${input.firstName} invited you to ${input.groupName} on PitchIn. Download the app: ${input.url}`;
}

/** wa.me / WhatsApp send URLs want digits only (447…), no plus. */
function whatsappPhoneDigits(mobileInput?: string): string | null {
  const e164 = mobileInput ? normalizeUkMobile(mobileInput) : null;
  return e164 ? e164.slice(1) : null;
}

function smsRecipient(mobileInput?: string): string | null {
  return mobileInput ? normalizeUkMobile(mobileInput) : null;
}

function smsUrl(message: string, mobileInput?: string): string {
  const body = encodeURIComponent(message);
  const to = smsRecipient(mobileInput);
  if (Platform.OS === 'ios') {
    return to ? `sms:${to}&body=${body}` : `sms:&body=${body}`;
  }
  return to ? `sms:${to}?body=${body}` : `sms:?body=${body}`;
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

export async function shareInviteViaWhatsApp(message: string, mobileInput?: string): Promise<void> {
  const phone = whatsappPhoneDigits(mobileInput);
  const text = encodeURIComponent(message);
  const nativeUrl = phone ? `whatsapp://send?phone=${phone}&text=${text}` : `whatsapp://send?text=${text}`;
  const webUrl = phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`;

  try {
    if (await Linking.canOpenURL(nativeUrl)) {
      await Linking.openURL(nativeUrl);
      return;
    }
    await Linking.openURL(webUrl);
  } catch {
    await fallbackShare(message);
  }
}

export async function shareInviteViaSms(message: string, mobileInput?: string): Promise<void> {
  await openOrShare(smsUrl(message, mobileInput), message);
}
