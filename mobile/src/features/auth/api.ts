import { recordDiagnosticError } from '../../lib/diagnostics';
import { supabase } from '../../lib/supabase';
import { PRIVACY_VERSION, TERMS_VERSION } from './schemas';

/** A friendly, user-safe message — never leak raw Supabase/Postgres error text. */
const GENERIC_ERROR = 'Something went wrong. Please try again.';

function friendlyError(error: unknown, fallback = GENERIC_ERROR): string {
  recordDiagnosticError('auth', error);
  console.error('[auth]', error);
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message);
    if (/rate limit|too many requests/i.test(message)) {
      return "You've tried too many times. Please wait a moment and try again.";
    }
  }
  return fallback;
}

type SignUpInput = {
  mobile: string;
  password: string;
  fullName: string;
  email?: string;
};

const EMAIL_TAKEN_ERROR = 'That email address is already registered. Try logging in instead.';

export async function signUpWithPassword({
  mobile,
  password,
  fullName,
  email,
}: SignUpInput): Promise<{ error?: string }> {
  const trimmedEmail = email?.trim() || null;

  // Checked *before* auth.signUp: profiles has no public SELECT policy, so
  // this can't be checked client-side any other way, and catching a
  // duplicate only via the DB unique constraint after signUp has already
  // created the auth.users row would orphan it.
  if (trimmedEmail) {
    const { data: taken, error: checkError } = await supabase.rpc('is_email_taken', {
      check_email: trimmedEmail,
    });
    if (checkError) {
      return { error: friendlyError(checkError) };
    }
    if (taken) {
      return { error: EMAIL_TAKEN_ERROR };
    }
  }

  const { data, error } = await supabase.auth.signUp({ phone: mobile, password });
  if (error) {
    if (/already registered|already exists/i.test(error.message)) {
      return { error: 'That mobile number is already registered. Try logging in instead.' };
    }
    return { error: friendlyError(error) };
  }

  const userId = data.user?.id;
  if (!userId) {
    console.error('[auth] sign-up: signUp succeeded but returned no user', data);
    return { error: GENERIC_ERROR };
  }

  // `update`, not `upsert` — the handle_new_user trigger already created
  // this row, and `profiles` has no INSERT RLS policy.
  const { error: profileError } = await supabase
    .from('profiles')
    .update({
      full_name: fullName,
      mobile,
      email: trimmedEmail,
      terms_accepted_at: new Date().toISOString(),
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
    })
    .eq('id', userId);
  if (profileError) {
    if (profileError.code === '23505') {
      return { error: EMAIL_TAKEN_ERROR };
    }
    return { error: friendlyError(profileError) };
  }

  return {};
}

export async function loginWithPassword(mobile: string, password: string): Promise<{ error?: string }> {
  const { error } = await supabase.auth.signInWithPassword({ phone: mobile, password });
  if (error) return { error: friendlyError(error, 'Invalid mobile or password.') };
  return {};
}

export async function acceptCurrentLegal(): Promise<{ error?: string }> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return { error: GENERIC_ERROR };

  const { error } = await supabase
    .from('profiles')
    .update({
      terms_accepted_at: new Date().toISOString(),
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
    })
    .eq('id', userId);
  if (error) return { error: friendlyError(error, "Couldn't save your acceptance. Please try again.") };
  return {};
}
