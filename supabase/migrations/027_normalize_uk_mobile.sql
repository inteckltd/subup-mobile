-- Canonicalise UK mobiles to E.164 (+447XXXXXXXXX). Auth often stores
-- auth.users.phone without '+', and handle_new_user copied that verbatim
-- into profiles.mobile — which broke Stripe Connect, invite matching, and
-- "did the number change?" checks on profile save.

create or replace function public.normalize_uk_mobile(input text)
returns text
language plpgsql
immutable
as $$
declare
  trimmed text;
  rest text;
  candidate text;
begin
  if input is null then
    return null;
  end if;

  trimmed := regexp_replace(btrim(input), '[\s-]', '', 'g');
  if trimmed = '' then
    return null;
  end if;

  if left(trimmed, 3) = '+44' then
    rest := substr(trimmed, 4);
    if left(rest, 1) = '0' then
      rest := substr(rest, 2);
    end if;
    candidate := '+44' || rest;
  elsif left(trimmed, 2) = '44' then
    rest := substr(trimmed, 3);
    if left(rest, 1) = '0' then
      rest := substr(rest, 2);
    end if;
    candidate := '+44' || rest;
  elsif left(trimmed, 2) = '07' then
    candidate := '+44' || substr(trimmed, 2);
  elsif trimmed ~ '^7[0-9]{9}$' then
    candidate := '+44' || trimmed;
  else
    return null;
  end if;

  if candidate ~ '^\+447[0-9]{9}$' then
    return candidate;
  end if;
  return null;
end;
$$;

comment on function public.normalize_uk_mobile(text) is
  'Normalises a UK mobile to E.164 (+447XXXXXXXXX). Returns null if the input is not a UK mobile.';

revoke all on function public.normalize_uk_mobile(text) from public, anon;
grant execute on function public.normalize_uk_mobile(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- New sign-ups: store the normalised number, not auth.users.phone as-is
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, mobile, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(public.normalize_uk_mobile(new.phone), new.phone),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Backfill existing rows that Auth stored without '+'
-- ---------------------------------------------------------------------------

update public.profiles p
set mobile = n.normalised
from (
  select id, public.normalize_uk_mobile(mobile) as normalised
  from public.profiles
  where mobile is not null
) n
where p.id = n.id
  and n.normalised is not null
  and p.mobile is distinct from n.normalised
  and not exists (
    select 1 from public.profiles other
    where other.id <> p.id
      and other.mobile = n.normalised
  );

update public.group_invites gi
set mobile = n.normalised
from (
  select id, public.normalize_uk_mobile(mobile) as normalised
  from public.group_invites
  where mobile is not null
) n
where gi.id = n.id
  and n.normalised is not null
  and gi.mobile is distinct from n.normalised
  and not exists (
    select 1 from public.group_invites other
    where other.id <> gi.id
      and other.group_id = gi.group_id
      and other.mobile = n.normalised
      and other.status = 'pending'
      and gi.status = 'pending'
  );

-- ---------------------------------------------------------------------------
-- Invites: always look up / store the canonical E.164 form
-- ---------------------------------------------------------------------------

create or replace function public.invite_group_member(p_group_id uuid, p_mobile text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mobile text;
  v_invitee public.profiles;
  v_group_name text;
  v_invite_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  perform public.assert_rate_limit('invite_group_member', auth.uid()::text, 20, interval '1 hour');

  if not public.is_group_admin(p_group_id) then
    raise exception 'Only group admins can invite members' using errcode = '42501';
  end if;

  select name into v_group_name from public.groups where id = p_group_id and archived_at is null;
  if v_group_name is null then
    raise exception 'Group not found';
  end if;

  v_mobile := public.normalize_uk_mobile(p_mobile);
  if v_mobile is null then
    raise exception 'Enter a valid UK mobile number';
  end if;

  select * into v_invitee
  from public.profiles
  where mobile = v_mobile
     or public.normalize_uk_mobile(mobile) = v_mobile
  limit 1;

  if v_invitee.id is not null then
    if exists (
      select 1 from public.group_members
      where group_id = p_group_id and user_id = v_invitee.id
    ) then
      raise exception 'This person is already a member of the group';
    end if;

    if exists (
      select 1 from public.group_invites
      where group_id = p_group_id
        and status = 'pending'
        and (
          invited_user_id = v_invitee.id
          or mobile = v_mobile
          or public.normalize_uk_mobile(mobile) = v_mobile
        )
    ) then
      raise exception 'This person has already been invited';
    end if;

    insert into public.group_invites (group_id, invited_by, mobile, invited_user_id, status)
    values (p_group_id, auth.uid(), v_mobile, v_invitee.id, 'pending')
    returning id into v_invite_id;

    insert into public.notifications (user_id, type, title, body, data)
    values (
      v_invitee.id,
      'group_invite',
      'You''re invited to ' || v_group_name,
      'Accept to join this group.',
      jsonb_build_object('type', 'group_invite', 'groupId', p_group_id, 'inviteId', v_invite_id)
    );

    return v_invite_id;
  end if;

  if exists (
    select 1 from public.group_invites
    where group_id = p_group_id
      and status = 'pending'
      and (mobile = v_mobile or public.normalize_uk_mobile(mobile) = v_mobile)
  ) then
    raise exception 'This person has already been invited';
  end if;

  begin
    insert into public.group_invites (group_id, invited_by, mobile, invited_user_id, status)
    values (p_group_id, auth.uid(), v_mobile, null, 'pending')
    returning id into v_invite_id;
  exception
    when unique_violation then
      raise exception 'This person has already been invited';
  end;

  return v_invite_id;
end;
$$;

-- Claim pending SMS invites even if the stored invite mobile lacked '+'
create or replace function public.claim_pending_invites_for_mobile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite record;
  v_group_name text;
  v_mobile text;
begin
  if new.mobile is null or new.mobile_verified_at is null then
    return new;
  end if;

  v_mobile := coalesce(public.normalize_uk_mobile(new.mobile), new.mobile);

  for v_invite in
    update public.group_invites gi
    set invited_user_id = new.id
    where gi.invited_user_id is null
      and gi.status = 'pending'
      and (
        gi.mobile = v_mobile
        or public.normalize_uk_mobile(gi.mobile) = v_mobile
      )
      and not exists (
        select 1 from public.group_invites existing
        where existing.group_id = gi.group_id
          and existing.invited_user_id = new.id
          and existing.status = 'pending'
      )
    returning *
  loop
    select name into v_group_name from public.groups where id = v_invite.group_id;
    insert into public.notifications (user_id, type, title, body, data)
    values (
      new.id,
      'group_invite',
      'You''re invited to ' || coalesce(v_group_name, 'a group'),
      'Accept to join this group.',
      jsonb_build_object('type', 'group_invite', 'groupId', v_invite.group_id, 'inviteId', v_invite.id)
    );
  end loop;

  return new;
end;
$$;
