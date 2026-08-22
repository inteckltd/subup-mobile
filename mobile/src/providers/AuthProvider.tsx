import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { PRIVACY_VERSION, TERMS_VERSION } from '../features/auth/schemas';
import { setSentryUser } from '../lib/sentry';
import { supabase } from '../lib/supabase';
import type { Profile } from '../types';

type AuthContextValue = {
  /** True until the initial session + (if any) profile hydration has finished. */
  initializing: boolean;
  session: Session | null;
  profile: Profile | null;
  /** True whenever a profile row is present and has a mobile number recorded. */
  hasMobile: boolean;
  /** True after the one-time SMS confirm (grandfathered for existing users). */
  mobileVerified: boolean;
  /** True when stored legal versions match the copy currently in the app. */
  legalCurrent: boolean;
  /**
   * True while the forgot-password flow is in progress. Keeps the user in
   * `(auth)` after `verifyOtp` creates a session, until they set a new password.
   */
  passwordRecovery: boolean;
  /** E.164 mobile collected on the forgot-password screen, used by OTP verify. */
  recoveryMobile: string | null;
  beginPasswordRecovery: (mobile: string) => void;
  endPasswordRecovery: () => void;
  /** Re-fetches the current user's profile row from the database. */
  refreshProfile: () => Promise<Profile | null>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function isLegalCurrent(profile: Profile | null): boolean {
  return !!profile && profile.terms_version === TERMS_VERSION && profile.privacy_version === PRIVACY_VERSION;
}

async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) {
    console.error('Failed to load profile', error);
    return null;
  }
  return data as Profile | null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [initializing, setInitializing] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [recoveryMobile, setRecoveryMobile] = useState<string | null>(null);
  const currentUserId = useRef<string | null>(null);

  const beginPasswordRecovery = useCallback((mobile: string) => {
    setPasswordRecovery(true);
    setRecoveryMobile(mobile);
  }, []);

  const endPasswordRecovery = useCallback(() => {
    setPasswordRecovery(false);
    setRecoveryMobile(null);
  }, []);

  const refreshProfile = useCallback(async (): Promise<Profile | null> => {
    const userId = currentUserId.current;
    if (!userId) {
      setProfile(null);
      return null;
    }
    const next = await fetchProfile(userId);
    setProfile(next);
    return next;
  }, []);

  useEffect(() => {
    let mounted = true;

    async function hydrate() {
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;

      currentUserId.current = data.session?.user.id ?? null;
      setSession(data.session);
      setSentryUser(currentUserId.current);

      if (data.session) {
        const initialProfile = await fetchProfile(data.session.user.id);
        if (!mounted) return;
        setProfile(initialProfile);
      }

      if (mounted) setInitializing(false);
    }

    hydrate();

    const { data: subscription } = supabase.auth.onAuthStateChange(async (event, nextSession) => {
      if (!mounted) return;

      setSession(nextSession);

      if (event === 'SIGNED_OUT' || !nextSession) {
        currentUserId.current = null;
        setProfile(null);
        setSentryUser(null);
        setPasswordRecovery(false);
        setRecoveryMobile(null);
        return;
      }

      setSentryUser(nextSession.user.id);

      if (nextSession.user.id !== currentUserId.current) {
        currentUserId.current = nextSession.user.id;
        const next = await fetchProfile(nextSession.user.id);
        if (!mounted) return;
        setProfile(next);
      }
    });

    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setSentryUser(null);
    setPasswordRecovery(false);
    setRecoveryMobile(null);
  }, []);

  const value: AuthContextValue = {
    initializing,
    session,
    profile,
    hasMobile: !!profile?.mobile,
    mobileVerified: !!profile?.mobile_verified_at,
    legalCurrent: isLegalCurrent(profile),
    passwordRecovery,
    recoveryMobile,
    beginPasswordRecovery,
    endPasswordRecovery,
    refreshProfile,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
