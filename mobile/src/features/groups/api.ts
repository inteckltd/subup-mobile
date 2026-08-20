import * as Crypto from 'expo-crypto';

import { recordDiagnosticError } from '../../lib/diagnostics';
import { supabase } from '../../lib/supabase';
import type { CreateGroupFormValues } from './schemas';

const GENERIC_ERROR = 'Something went wrong. Please try again.';
const COVER_BUCKET = 'group-covers';

/** A friendly, user-safe message — never leak raw Supabase/Postgres error text (same pattern as features/auth/api.ts). */
function friendlyError(error: unknown, fallback = GENERIC_ERROR): string {
  recordDiagnosticError('groups', error);
  console.error('[groups]', error);
  return fallback;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Uploads a locally-picked image (expo-image-picker's `uri`) to the
 * `group-covers` bucket (004_group_covers_storage.sql) under the caller's
 * own auth.uid() folder, and returns its public URL. `fetch(uri).arrayBuffer()`
 * is the documented Supabase-on-React-Native pattern — more reliable across
 * RN/Expo versions than base64 string uploads.
 */
export async function uploadGroupCoverImage(userId: string, localUri: string): Promise<{ url?: string; error?: string }> {
  try {
    const response = await fetch(localUri);
    const arrayBuffer = await response.arrayBuffer();
    const extension = localUri.split('.').pop()?.toLowerCase().split('?')[0] || 'jpg';
    const contentType = extension === 'png' ? 'image/png' : 'image/jpeg';
    const path = `${userId}/${Date.now()}.${extension}`;

    const { error: uploadError } = await supabase.storage.from(COVER_BUCKET).upload(path, arrayBuffer, {
      contentType,
    });
    if (uploadError) return { error: friendlyError(uploadError, "Couldn't upload that image. Please try a different one.") };

    const { data } = supabase.storage.from(COVER_BUCKET).getPublicUrl(path);
    return { url: data.publicUrl };
  } catch (error) {
    return { error: friendlyError(error, "Couldn't upload that image. Please try a different one.") };
  }
}

/**
 * Creates a group via a direct, authenticated Supabase insert — secured
 * entirely by the existing RLS policy (`created_by = auth.uid()`, see
 * 003_domain.sql), the same "no privileged /api needed" pattern Home's reads
 * use (PLAN_PHASE2.md "No unauthenticated domain access"). The
 * `handle_new_group` trigger auto-adds the creator as an admin
 * `group_members` row, so no follow-up insert is needed here.
 *
 * `sport` comes from the create/edit form (`sport_type` enum).
 * Deliberately does NOT chain `.select()` after `.insert()`. Doing so makes
 * PostgREST request `INSERT ... RETURNING *`, and Postgres additionally
 * requires the *returned* row to satisfy the table's SELECT policy
 * (`is_group_member(id)`) — which only becomes true once the
 * `handle_new_group` AFTER INSERT trigger adds the caller's `group_members`
 * row, and that isn't reliably visible to the RETURNING-time policy check
 * within the same statement. That combination throws exactly "new row
 * violates row-level security policy for table groups" (42501) even though
 * the INSERT itself is entirely valid. Since nothing here needs the
 * inserted row back, the id is generated client-side with
 * `expo-crypto` `randomUUID()` and a
 * plain INSERT with no RETURNING sidesteps the issue completely.
 */
export async function createGroup(values: CreateGroupFormValues, userId: string): Promise<{ id?: string; error?: string }> {
  let coverImageUrl: string | null = null;
  if (values.coverImageUri) {
    const { url, error: uploadError } = await uploadGroupCoverImage(userId, values.coverImageUri);
    if (uploadError) return { error: uploadError };
    coverImageUrl = url ?? null;
  }

  const id = Crypto.randomUUID();

  const { error } = await supabase.from('groups').insert({
    id,
    name: values.name.trim(),
    sport: values.sport,
    lock_hours: values.lockHours,
    description: values.description?.trim() || null,
    cover_image_url: coverImageUrl,
    default_venue_name: values.venueName.trim(),
    default_venue_address: values.venueAddress.trim(),
    default_weekday: values.weekday,
    default_time: `${pad2(values.hour)}:${pad2(values.minute)}:00`,
    created_by: userId,
  });

  if (error) return { error: friendlyError(error) };
  return { id };
}

export async function updateGroup(
  groupId: string,
  values: CreateGroupFormValues,
  coverImageUrl: string | null,
): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('update_group', {
    p_group_id: groupId,
    p_name: values.name.trim(),
    p_sport: values.sport,
    p_description: values.description?.trim() || null,
    p_cover_image_url: coverImageUrl,
    p_default_venue_name: values.venueName.trim(),
    p_default_venue_address: values.venueAddress.trim(),
    p_default_weekday: values.weekday,
    p_default_time: `${pad2(values.hour)}:${pad2(values.minute)}:00`,
    p_lock_hours: values.lockHours,
  });

  if (error) {
    if (error.message?.startsWith('Only group admins')) return { error: error.message };
    if (error.message?.startsWith('Enter a group name')) return { error: error.message };
    if (error.message?.startsWith('Lock window')) return { error: error.message };
    return { error: friendlyError(error) };
  }
  return {};
}
