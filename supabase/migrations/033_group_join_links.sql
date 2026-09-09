-- Unique shareable join link per group. Anyone with the URL can accept
-- after signing in; WhatsApp/SMS only carry this link (no per-number invite).

create table if not exists public.group_join_links (
  group_id uuid primary key references public.groups (id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now(),
  check (char_length(token) between 32 and 64)
);

comment on table public.group_join_links is
  'One standing join token per group. Admins share https://www.subupapp.co.uk/join/<token>.';

alter table public.group_join_links enable row level security;

revoke all on public.group_join_links from public, anon, authenticated;

create or replace function public.new_group_join_token()
returns text
language sql
volatile
as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

revoke all on function public.new_group_join_token() from public, anon, authenticated;

create or replace function public.handle_new_group()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.group_members (group_id, user_id, role)
  values (new.id, new.created_by, 'admin')
  on conflict (group_id, user_id) do nothing;

  insert into public.group_join_links (group_id, token)
  values (new.id, public.new_group_join_token())
  on conflict (group_id) do nothing;

  return new;
end;
$$;

insert into public.group_join_links (group_id, token)
select g.id, public.new_group_join_token()
from public.groups g
where not exists (
  select 1 from public.group_join_links l where l.group_id = g.id
);

-- ---------------------------------------------------------------------------
-- Admin: read (or create) this group's join token
-- ---------------------------------------------------------------------------

create or replace function public.get_group_join_token(p_group_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if not public.is_group_admin(p_group_id) then
    raise exception 'Only group admins can share a join link' using errcode = '42501';
  end if;

  if not exists (select 1 from public.groups where id = p_group_id and archived_at is null) then
    raise exception 'Group not found';
  end if;

  select token into v_token from public.group_join_links where group_id = p_group_id;
  if v_token is null then
    v_token := public.new_group_join_token();
    insert into public.group_join_links (group_id, token) values (p_group_id, v_token);
  end if;

  return v_token;
end;
$$;

comment on function public.get_group_join_token(uuid) is
  'Admin-only. Returns the standing join token for a group, creating one if missing.';

revoke all on function public.get_group_join_token(uuid) from public, anon;
grant execute on function public.get_group_join_token(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Public preview (token is the capability)
-- ---------------------------------------------------------------------------

create or replace function public.preview_group_join_link(p_token text)
returns table (
  group_id uuid,
  group_name text,
  sport public.sport_type
)
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
begin
  if p_token is null or char_length(trim(p_token)) < 32 then
    return;
  end if;

  return query
  select grp.id, grp.name, grp.sport
  from public.group_join_links lnk
  join public.groups grp on grp.id = lnk.group_id
  where lnk.token = trim(p_token)
    and grp.archived_at is null;
end;
$$;

comment on function public.preview_group_join_link(text) is
  'Looks up a join token. Safe for signed-out users: name and sport only.';

revoke all on function public.preview_group_join_link(text) from public;
grant execute on function public.preview_group_join_link(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Signed-in user: create (or reuse) a pending invite from the join link
-- ---------------------------------------------------------------------------

create or replace function public.claim_group_join_link(p_token text)
returns table (
  invite_id uuid,
  group_id uuid,
  group_name text,
  already_member boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_group public.groups;
  v_admin uuid;
  v_invite_id uuid;
  v_mobile text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  perform public.assert_rate_limit('claim_group_join_link', auth.uid()::text, 30, interval '1 hour');

  if p_token is null or char_length(trim(p_token)) < 32 then
    raise exception 'Invite not found';
  end if;

  select grp.* into v_group
  from public.group_join_links lnk
  join public.groups grp on grp.id = lnk.group_id
  where lnk.token = trim(p_token);

  if v_group.id is null or v_group.archived_at is not null then
    raise exception 'Invite not found';
  end if;

  if exists (
    select 1 from public.group_members
    where group_id = v_group.id and user_id = auth.uid()
  ) then
    invite_id := null;
    group_id := v_group.id;
    group_name := v_group.name;
    already_member := true;
    return next;
    return;
  end if;

  select mobile into v_mobile from public.profiles where id = auth.uid();

  select gi.id into v_invite_id
  from public.group_invites gi
  where gi.group_id = v_group.id
    and gi.status = 'pending'
    and (
      gi.invited_user_id = auth.uid()
      or (v_mobile is not null and gi.mobile = v_mobile)
    )
  order by gi.created_at
  limit 1;

  if v_invite_id is not null then
    update public.group_invites
    set invited_user_id = auth.uid()
    where id = v_invite_id
      and invited_user_id is null;
    invite_id := v_invite_id;
    group_id := v_group.id;
    group_name := v_group.name;
    already_member := false;
    return next;
    return;
  end if;

  select gm.user_id into v_admin
  from public.group_members gm
  where gm.group_id = v_group.id and gm.role = 'admin'
  order by gm.joined_at
  limit 1;

  if v_admin is null then
    raise exception 'Group not found';
  end if;

  begin
    insert into public.group_invites (
      group_id, invited_by, mobile, invited_user_id, status, expires_at
    )
    values (
      v_group.id,
      v_admin,
      v_mobile,
      auth.uid(),
      'pending',
      now() + interval '1 year'
    )
    returning id into v_invite_id;
  exception
    when unique_violation then
      select gi.id into v_invite_id
      from public.group_invites gi
      where gi.group_id = v_group.id
        and gi.status = 'pending'
        and (
          gi.invited_user_id = auth.uid()
          or (v_mobile is not null and gi.mobile = v_mobile)
        )
      order by gi.created_at
      limit 1;
      if v_invite_id is null then
        raise;
      end if;
      invite_id := v_invite_id;
      group_id := v_group.id;
      group_name := v_group.name;
      already_member := false;
      return next;
      return;
  end;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    auth.uid(),
    'group_invite',
    'You''re invited to ' || v_group.name,
    'Accept to join this group.',
    jsonb_build_object('type', 'group_invite', 'groupId', v_group.id, 'inviteId', v_invite_id)
  );

  invite_id := v_invite_id;
  group_id := v_group.id;
  group_name := v_group.name;
  already_member := false;
  return next;
end;
$$;

comment on function public.claim_group_join_link(text) is
  'Signed-in user: create or reuse a pending group invite from a join token, and drop an inbox notification.';

revoke all on function public.claim_group_join_link(text) from public, anon;
grant execute on function public.claim_group_join_link(text) to authenticated;
