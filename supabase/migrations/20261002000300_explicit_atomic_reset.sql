-- Upgrade existing projects; do not edit already-deployed migrations or reset live data.
-- Retain the existing RPC signature so deployed Edge Functions remain compatible.
-- The schema has exactly one event (boolean PK constrained to true), not multiple
-- event_id partitions. Assignment rows belong to that singleton by construction.
-- Supabase's safe-delete protection requires explicit WHERE clauses, even in RPCs.
create or replace function public.santa_admin_change(p_session_hash text, p_action text, p_data jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_event public.santa_event; v_id uuid; v_name text;
begin
  perform public.santa_assert_admin(p_session_hash);
  select * into v_event from public.santa_event where id = true for update;
  if p_action = 'reset' then
    if p_data->>'confirmation' is distinct from 'RESET EVENT' then
      raise exception using message = 'Type RESET EVENT exactly to confirm.', errcode = 'PT400';
    end if;
    -- Check before clearing child rows: the assignment DELETE trigger would otherwise
    -- no longer see active leases. All email claims also lock this same event row.
    if exists(select 1 from public.santa_email_deliveries where lease_until > now()) then
      raise exception using message = 'Emails are being sent. Wait 90 seconds before resetting.', errcode = 'PT409';
    end if;
    -- Explicit child-first cleanup works with CASCADE and NO ACTION/RESTRICT FKs.
    -- NULL tokens/payloads/leases on backfilled draws require no special handling.
    delete from public.santa_email_deliveries d
      where d.participant_id in (select a.giver_id from public.santa_assignments a)
        and exists(select 1 from public.santa_event e where e.id = v_event.id and e.revision = v_event.revision);
    delete from public.santa_reveal_tokens t
      where t.participant_id in (select a.giver_id from public.santa_assignments a)
        and exists(select 1 from public.santa_event e where e.id = v_event.id and e.revision = v_event.revision);
    delete from public.santa_assignments a
      where a.giver_id in (select p.id from public.santa_participants p)
        and exists(select 1 from public.santa_event e where e.id = v_event.id and e.revision = v_event.revision);
    update public.santa_event set drawn_at = null, registration_locked = false,
      revision = revision + 1, updated_at = now() where id = true;
    return;
  end if;
  if v_event.drawn_at is not null then raise exception using message = 'The draw is complete. Reset the event before making changes.', errcode = 'PT409'; end if;
  if p_action in ('rename-household', 'delete-household', 'remove-participant') then v_id = (p_data->>'id')::uuid; end if;
  if p_action in ('create-household', 'rename-household') then
    v_name = p_data->>'name';
    if v_name is null or length(v_name) not between 1 and 60 then raise exception using message = 'Household names must be 1–60 characters.', errcode = 'PT400'; end if;
  end if;
  case p_action
    when 'create-household' then insert into public.santa_households(name) values (v_name);
    when 'rename-household' then
      update public.santa_households set name = v_name, updated_at = now() where id = v_id;
      if not found then raise exception using message = 'Household not found.', errcode = 'PT404'; end if;
    when 'delete-household' then
      if exists(select 1 from public.santa_participants where household_id = v_id) then raise exception using message = 'Only empty households can be deleted.', errcode = 'PT409'; end if;
      delete from public.santa_households where id = v_id;
      if not found then raise exception using message = 'Household not found.', errcode = 'PT404'; end if;
    when 'remove-participant' then
      delete from public.santa_participants where id = v_id;
      if not found then raise exception using message = 'Participant not found.', errcode = 'PT404'; end if;
    when 'set-registration' then
      if jsonb_typeof(p_data->'locked') is distinct from 'boolean' then raise exception using message = 'A lock setting is required.', errcode = 'PT400'; end if;
      update public.santa_event set registration_locked = (p_data->>'locked')::boolean where id = true;
    else raise exception using message = 'Unknown organizer operation.', errcode = 'PT400';
  end case;
  update public.santa_event set revision = revision + 1, updated_at = now() where id = true;
exception when unique_violation then
  raise exception using message = 'That household name already exists.', errcode = 'PT409';
end $$;

revoke all on function public.santa_admin_change(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.santa_admin_change(text,text,jsonb) to service_role;
