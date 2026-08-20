-- Drop group_invite notifications once the invite is no longer pending
-- (accepted, declined, or cancelled). The notifications list is a live
-- inbox, not a history of resolved invites.

create or replace function public.accept_group_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.group_invites;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_invite from public.group_invites where id = p_invite_id for update;
  if v_invite.id is null then
    raise exception 'Invite not found';
  end if;

  if v_invite.invited_user_id is distinct from auth.uid() then
    raise exception 'This invite is not for you' using errcode = '42501';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'This invite is no longer pending';
  end if;

  insert into public.group_members (group_id, user_id, role)
  values (v_invite.group_id, auth.uid(), 'member')
  on conflict (group_id, user_id) do nothing;

  update public.group_invites
  set status = 'accepted'
  where id = p_invite_id;

  delete from public.notifications
  where type = 'group_invite'
    and data->>'inviteId' = p_invite_id::text;
end;
$$;

create or replace function public.decline_group_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.group_invites;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_invite from public.group_invites where id = p_invite_id for update;
  if v_invite.id is null then
    raise exception 'Invite not found';
  end if;

  if v_invite.invited_user_id is distinct from auth.uid() then
    raise exception 'This invite is not for you' using errcode = '42501';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'This invite is no longer pending';
  end if;

  update public.group_invites
  set status = 'declined'
  where id = p_invite_id;

  delete from public.notifications
  where type = 'group_invite'
    and data->>'inviteId' = p_invite_id::text;
end;
$$;

create or replace function public.cancel_group_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.group_invites;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_invite from public.group_invites where id = p_invite_id for update;
  if v_invite.id is null then
    raise exception 'Invite not found';
  end if;

  if not public.is_group_admin(v_invite.group_id) then
    raise exception 'Only group admins can cancel invites' using errcode = '42501';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'This invite is no longer pending';
  end if;

  update public.group_invites
  set status = 'cancelled'
  where id = p_invite_id;

  delete from public.notifications
  where type = 'group_invite'
    and data->>'inviteId' = p_invite_id::text;
end;
$$;

comment on function public.accept_group_invite(uuid) is
  'Invitee joins the group. Removes the matching group_invite notification from their inbox.';

-- Clear already-resolved invite notifications left over from before this change.
delete from public.notifications n
where n.type = 'group_invite'
  and exists (
    select 1
    from public.group_invites gi
    where gi.id::text = n.data->>'inviteId'
      and gi.status <> 'pending'
  );
