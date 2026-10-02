-- Explicit organizer-only full cleanup for the existing singleton event.
-- Applying this migration does not delete data; the organizer must invoke the RPC.
create function public.santa_reset_draw(p_session_hash text, p_confirmation text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.santa_assert_admin(p_session_hash);
  if p_confirmation is distinct from 'RESET DRAW' then
    raise exception using message = 'Type RESET DRAW exactly to confirm.', errcode = 'PT400';
  end if;
  -- The internal service-only RPC keeps its historical signature/confirmation.
  perform public.santa_admin_change(p_session_hash, 'reset', jsonb_build_object('confirmation','RESET EVENT'));
end $$;
revoke all on function public.santa_reset_draw(text,text) from public, anon, authenticated;
grant execute on function public.santa_reset_draw(text,text) to service_role;

create function public.santa_delete_event_data(p_session_hash text, p_confirmation text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_event public.santa_event;
begin
  perform public.santa_assert_admin(p_session_hash);
  if p_confirmation is distinct from 'DELETE EVERYTHING' then
    raise exception using message = 'Type DELETE EVERYTHING exactly to confirm.', errcode = 'PT400';
  end if;
  select * into v_event from public.santa_event where id = true for update;
  if not found then raise exception using message = 'The event could not be found.', errcode = 'PT409'; end if;
  -- Reuse the draw cleanup and active-email lease guard inside this same transaction.
  perform public.santa_reset_draw(p_session_hash, 'RESET DRAW');
  select * into v_event from public.santa_event where id = v_event.id;
  delete from public.santa_participants p
    where p.household_id in (select h.id from public.santa_households h)
      and exists(select 1 from public.santa_event e where e.id = v_event.id and e.revision = v_event.revision);
  delete from public.santa_households h
    where exists(select 1 from public.santa_event e where e.id = v_event.id and e.revision = v_event.revision);
  update public.santa_event set registration_locked = false, drawn_at = null,
    created_at = now(), updated_at = now() where id = v_event.id;
  -- Keep revision monotonic to invalidate pre-cleanup generation snapshots.
  -- The singleton settings row, organizer sessions and abuse counters remain in use.
end $$;
revoke all on function public.santa_delete_event_data(text,text) from public, anon, authenticated;
grant execute on function public.santa_delete_event_data(text,text) to service_role;
