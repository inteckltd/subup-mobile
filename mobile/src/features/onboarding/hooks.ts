import { useCallback, useEffect, useState } from 'react';

import {
  dismissChecklist as persistChecklistDismissed,
  getChecklistDismissed,
  getExplainerSeen,
} from './storage';

/**
 * User ids that have already been pushed to `/onboarding` this JS session.
 * Stops React Strict Mode / a Home remount from stacking a second modal
 * before Skip has written the AsyncStorage flag.
 */
const explainerPresentedThisSession = new Set<string>();

export function consumeExplainerPresentation(userId: string): boolean {
  if (explainerPresentedThisSession.has(userId)) return false;
  explainerPresentedThisSession.add(userId);
  return true;
}

export function useOnboardingFlags(userId: string | undefined) {
  // Default to "already done" so Home does not flash the checklist or push
  // the explainer while storage is still loading.
  const [explainerSeen, setExplainerSeen] = useState(true);
  const [checklistDismissed, setChecklistDismissed] = useState(true);
  const [loadedForUserId, setLoadedForUserId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!userId) return;

    let cancelled = false;

    void Promise.all([getExplainerSeen(userId), getChecklistDismissed(userId)]).then(
      ([seen, dismissed]) => {
        if (cancelled) return;
        setExplainerSeen(seen);
        setChecklistDismissed(dismissed);
        setLoadedForUserId(userId);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const dismissChecklist = useCallback(async () => {
    if (!userId) return;
    setChecklistDismissed(true);
    await persistChecklistDismissed(userId);
  }, [userId]);

  const refetch = useCallback(() => {
    if (!userId) return;
    void Promise.all([getExplainerSeen(userId), getChecklistDismissed(userId)]).then(([seen, dismissed]) => {
      setExplainerSeen(seen);
      setChecklistDismissed(dismissed);
      setLoadedForUserId(userId);
    });
  }, [userId]);

  return {
    ready: !!userId && loadedForUserId === userId,
    explainerSeen,
    checklistDismissed,
    dismissChecklist,
    refetch,
  };
}
