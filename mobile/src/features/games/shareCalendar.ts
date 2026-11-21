import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform, Share } from 'react-native';

function isShareDismissed(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /cancel|dismiss|did not share/i.test(message);
}

/**
 * Writes an .ics into the app cache and opens the system share sheet so the
 * user can add it to their own calendar. Uses expo-file-system (already in
 * the app) and expo-sharing. No calendar permission and no calendar API.
 */
export async function shareGameCalendarFile(input: { filename: string; contents: string }): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      await Share.share({ message: input.contents, title: 'Add to calendar' });
    } catch (error) {
      if (isShareDismissed(error)) return;
      throw error;
    }
    return;
  }

  const file = new File(Paths.cache, input.filename);
  file.create({ overwrite: true });
  file.write(input.contents);

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'text/calendar',
      UTI: 'com.apple.ical.ics',
      dialogTitle: 'Add to calendar',
    });
    return;
  }

  try {
    await Share.share(
      Platform.OS === 'ios'
        ? { url: file.uri, title: 'Add to calendar' }
        : { message: input.contents, title: 'Add to calendar' },
    );
  } catch (error) {
    if (isShareDismissed(error)) return;
    throw error;
  }
}
