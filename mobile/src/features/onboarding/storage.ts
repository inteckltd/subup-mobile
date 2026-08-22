import AsyncStorage from '@react-native-async-storage/async-storage';

function explainerKey(userId: string) {
  return `onboarding:explainer:seen:${userId}`;
}

function checklistKey(userId: string) {
  return `onboarding:checklist:dismissed:${userId}`;
}

/**
 * First-run flags are local UX state, not account data — keyed by user id so
 * a second account on the same device still sees the explainer. Fail closed
 * (treat as already seen/dismissed) if storage throws, so a broken store
 * cannot loop the modal every launch.
 */
async function readFlag(key: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(key)) === '1';
  } catch {
    return true;
  }
}

async function writeFlag(key: string): Promise<void> {
  try {
    await AsyncStorage.setItem(key, '1');
  } catch {
    // Best-effort; the in-memory hook state still updates.
  }
}

export function getExplainerSeen(userId: string): Promise<boolean> {
  return readFlag(explainerKey(userId));
}

export function markExplainerSeen(userId: string): Promise<void> {
  return writeFlag(explainerKey(userId));
}

export function getChecklistDismissed(userId: string): Promise<boolean> {
  return readFlag(checklistKey(userId));
}

export function dismissChecklist(userId: string): Promise<void> {
  return writeFlag(checklistKey(userId));
}
