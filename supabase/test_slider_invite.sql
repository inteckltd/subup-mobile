-- Throwaway: create a football group and invite 07725209316 to it, so the
-- join-questions (slider) flow can be tested. Run in the Supabase SQL editor.
--
-- Part 1 creates the group, a pending invite and the in-app invite
-- notification (Notifications -> Accept opens the sliders). Part 2, further
-- down, removes everything again. Run them separately.
--
-- The group is created by the oldest other profile (so it needs an admin
-- member). That person will also see "ZZ Slider Test" in their groups until
-- cleanup. To use someone specific, set v_admin_mobile below.

-- ---------------------------------------------------------------------------
-- Part 1: create
-- ---------------------------------------------------------------------------
do $$
declare
  v_mobile text := '+447725209316';
  v_admin_mobile text := null;  -- e.g. '+447700900001'; null = oldest other profile
  v_target uuid;
  v_admin uuid;
  v_group uuid;
  v_invite uuid;
begin
  select id into v_target from public.profiles where mobile = v_mobile;
  if v_target is null then
    raise exception 'No profile found with mobile %', v_mobile;
  end if;

  if v_admin_mobile is not null then
    select id into v_admin from public.profiles where mobile = v_admin_mobile and id <> v_target;
  else
    select id into v_admin from public.profiles where id <> v_target order by created_at limit 1;
  end if;
  if v_admin is null then
    raise exception 'No other profile found to own the test group';
  end if;

  -- The new-group trigger adds the creator as admin and makes the join link.
  insert into public.groups (name, sport, created_by)
  values ('ZZ Slider Test (delete me)', 'football', v_admin)
  returning id into v_group;

  insert into public.group_invites (group_id, invited_by, mobile, invited_user_id, status, expires_at)
  values (v_group, v_admin, v_mobile, v_target, 'pending', now() + interval '7 days')
  returning id into v_invite;

  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_target,
    'group_invite',
    'You''re invited to ZZ Slider Test (delete me)',
    'Accept to join this group.',
    jsonb_build_object('type', 'group_invite', 'groupId', v_group, 'inviteId', v_invite)
  );

  raise notice 'Created group % with pending invite % for %', v_group, v_invite, v_mobile;
end
$$;

-- ---------------------------------------------------------------------------
-- Part 2: clean up (run after testing)
-- ---------------------------------------------------------------------------
-- do $$
-- begin
--   delete from public.notifications
--   where type = 'group_invite'
--     and data->>'groupId' in (select id::text from public.groups where name = 'ZZ Slider Test (delete me)');
--
--   -- Deleting a group cascades into group_members; prevent_last_admin_loss
--   -- would block removing the last admin, so it is disabled for this only.
--   alter table public.group_members disable trigger prevent_last_admin_loss;
--   begin
--     delete from public.groups where name = 'ZZ Slider Test (delete me)';
--     alter table public.group_members enable trigger prevent_last_admin_loss;
--   exception when others then
--     alter table public.group_members enable trigger prevent_last_admin_loss;
--     raise;
--   end;
-- end
-- $$;
