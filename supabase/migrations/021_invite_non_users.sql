-- Allow group invites for people who do not have a PitchIn account yet.
-- Pending rows keep invited_user_id null until sign-up claims them.
-- SMS is sent by notify-group-invite; this migration only changes the RPC
-- and the claim/list paths.

create unique index if not exists group_invites_one_pending_per_mobile
  on public.group_invites (group_id, mobile)
  where status = 'pending' and mobile is not null;

create or replace function public.invite_group_member(p_group_id uuid, p_mobile text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invitee public.profiles;
  v_group_name text;
  v_invite_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if not public.is_group_admin(p_group_id) then
    raise exception 'Only group admins can invite members' using errcode = '42501';
  end if;

  select name into v_group_name from public.groups where id = p_group_id and archived_at is null;
  if v_group_name is null then
    raise exception 'Group not found';
  end if;

  select * into v_invitee from public.profiles where mobile = p_mobile;

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
        and (invited_user_id = v_invitee.id or mobile = p_mobile)
    ) then
      raise exception 'This person has already been invited';
    end if;

    insert into public.group_invites (group_id, invited_by, mobile, invited_user_id, status)
    values (p_group_id, auth.uid(), p_mobile, v_invitee.id, 'pending')
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
      and mobile = p_mobile
      and status = 'pending'
  ) then
    raise exception 'This person has already been invited';
  end if;

  begin
    insert into public.group_invites (group_id, invited_by, mobile, invited_user_id, status)
    values (p_group_id, auth.uid(), p_mobile, null, 'pending')
    returning id into v_invite_id;
  exception
    when unique_violation then
      raise exception 'This person has already been invited';
  end;

  return v_invite_id;
end;
$$;

comment on function public.invite_group_member(uuid, text) is
  'Admin-only. Invites by E.164 mobile. Existing users get a notification; unknown mobiles get a pending row (SMS is a separate best-effort step). Does not create users.';

create or replace function public.claim_pending_invites_for_mobile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite record;
  v_group_name text;
begin
  if new.mobile is null then
    return new;
  end if;

  for v_invite in
    update public.group_invites gi
    set invited_user_id = new.id
    where gi.mobile = new.mobile
      and gi.invited_user_id is null
      and gi.status = 'pending'
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

comment on function public.claim_pending_invites_for_mobile() is
  'When a profile gets a mobile, attach pending group_invites for that number and insert inbox rows.';

drop trigger if exists claim_pending_invites_on_profile_mobile on public.profiles;
create trigger claim_pending_invites_on_profile_mobile
  after insert or update of mobile on public.profiles
  for each row
  execute function public.claim_pending_invites_for_mobile();

drop function if exists public.get_group_pending_invites(uuid);

create function public.get_group_pending_invites(p_group_id uuid)
returns table (
  invite_id uuid,
  invited_user_id uuid,
  full_name text,
  avatar_url text,
  awaiting_signup boolean,
  created_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    gi.id as invite_id,
    gi.invited_user_id,
    p.full_name,
    p.avatar_url,
    (gi.invited_user_id is null) as awaiting_signup,
    gi.created_at
  from public.group_invites gi
  left join public.profiles p on p.id = gi.invited_user_id
  where gi.group_id = p_group_id
    and gi.status = 'pending'
    and public.is_group_member(p_group_id);
$$;

comment on function public.get_group_pending_invites(uuid) is
  'Pending invites for a group the caller belongs to. security definer so members can see the Invited section. Does not return mobiles. awaiting_signup is true when the invitee has no account yet.';

revoke all on function public.get_group_pending_invites(uuid) from public, anon;
grant execute on function public.get_group_pending_invites(uuid) to authenticated;
