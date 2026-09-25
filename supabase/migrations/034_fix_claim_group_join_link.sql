-- Qualify group_members columns in claim_group_join_link. RETURNS TABLE
-- exposes group_id as a PL/pgSQL variable, so the unqualified membership
-- check raised 42702 ("column reference group_id is ambiguous") on every Join.

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
    select 1 from public.group_members gm
    where gm.group_id = v_group.id and gm.user_id = auth.uid()
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
