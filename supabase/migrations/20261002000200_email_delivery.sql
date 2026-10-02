-- Private durable outbox. Only the service role can access it; organizers see aggregates.
create table public.santa_email_deliveries (
  participant_id uuid primary key references public.santa_assignments(giver_id) on delete cascade,
  delivery_id uuid not null unique default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending','sending','failed','sent','uncertain','cancelled')),
  token_hash text unique check (token_hash ~ '^[a-f0-9]{64}$'),
  encrypted_payload text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  uncertain_since timestamptz,
  lease_id uuid,
  lease_until timestamptz,
  sent_at timestamptz,
  resend_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'sent' or sent_at is not null)
);
alter table public.santa_email_deliveries enable row level security;
revoke all on public.santa_email_deliveries from public, anon, authenticated;
grant all on public.santa_email_deliveries to service_role;

create function public.santa_queue_draw_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.santa_email_deliveries(participant_id) values (new.giver_id);
  return new;
end $$;
create trigger santa_queue_draw_email after insert on public.santa_assignments
for each row execute function public.santa_queue_draw_email();
-- Existing completed draws are preserved. Email hashes coexist with manually issued links.
insert into public.santa_email_deliveries(participant_id) select giver_id from public.santa_assignments;

create function public.santa_email_summary(p_session_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform public.santa_assert_admin(p_session_hash);
  select jsonb_build_object('sent', count(*) filter(where status = 'sent'),
    'failed', count(*) filter(where status = 'failed'),
    'pending', count(*) filter(where status = 'pending'),
    'sending', count(*) filter(where status = 'sending'),
    'uncertain', count(*) filter(where status = 'uncertain'),
    'cancelled', count(*) filter(where status = 'cancelled'),
    'problems', coalesce((select jsonb_agg(jsonb_build_object('name',p.name,'status',d.status,'error',d.last_error))
      from public.santa_email_deliveries d join public.santa_participants p on p.id = d.participant_id
      where d.status in ('failed','uncertain')), '[]'::jsonb)) into v_result
  from public.santa_email_deliveries;
  return v_result;
end $$;

alter function public.santa_admin_data(text) rename to santa_admin_data_without_email;
create function public.santa_admin_data(p_session_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_result jsonb; v_participants jsonb;
begin
  v_result := public.santa_admin_data_without_email(p_session_hash);
  select coalesce(jsonb_agg(x || jsonb_build_object('linkIssued', (x->>'linkIssued')::boolean or
    exists(select 1 from public.santa_email_deliveries d where d.participant_id = (x->>'id')::uuid and d.token_hash is not null))), '[]'::jsonb)
  into v_participants from jsonb_array_elements(v_result->'participants') x;
  return v_result || jsonb_build_object('participants', v_participants, 'emailDelivery', public.santa_email_summary(p_session_hash));
end $$;

-- One leased message at a time. The event lock serializes reset/token replacement/claim.
create function public.santa_claim_email(p_session_hash text, p_exclude uuid[] default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_row public.santa_email_deliveries; v_lease uuid := gen_random_uuid(); v_result jsonb;
begin
  perform public.santa_assert_admin(p_session_hash);
  perform 1 from public.santa_event where id = true and drawn_at is not null for update;
  if not found then raise exception using message = 'Generate the assignments before sending emails.', errcode = 'PT409'; end if;
  -- Resend deduplicates for 24h. Leave a one-hour margin, never blindly resend older ambiguity.
  update public.santa_email_deliveries set status = 'uncertain', lease_id = null, lease_until = null,
    last_error = 'Delivery outcome needs review in Resend; automatic retry stopped to prevent duplicates.', updated_at = now()
  where status in ('pending','failed','sending') and uncertain_since <= now() - interval '23 hours'
    and (lease_until is null or lease_until <= now());
  select * into v_row from public.santa_email_deliveries
  where status in ('pending','failed','sending') and not (participant_id = any(p_exclude))
    and (lease_until is null or lease_until <= now())
  order by created_at, participant_id for update skip locked limit 1;
  if not found then return null; end if;
  update public.santa_email_deliveries set status = 'sending', lease_id = v_lease,
    lease_until = now() + interval '90 seconds', updated_at = now() where participant_id = v_row.participant_id;
  select jsonb_build_object('participantId', p.id, 'name', p.name, 'email', p.email,
    'deliveryId', v_row.delivery_id, 'leaseId', v_lease, 'encryptedPayload', v_row.encrypted_payload,
    'tokenHash', v_row.token_hash) into v_result from public.santa_participants p where p.id = v_row.participant_id;
  return v_result;
end $$;

-- Commit the immutable encrypted Resend request + hash before making any network request.
create function public.santa_prepare_email(p_session_hash text, p_participant_id uuid, p_lease_id uuid,
  p_token_hash text, p_encrypted_payload text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.santa_assert_admin(p_session_hash);
  perform 1 from public.santa_event where id = true for update;
  if length(p_encrypted_payload) not between 1 and 30000 or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception using message = 'Invalid email preparation.', errcode = 'PT400'; end if;
  update public.santa_email_deliveries set token_hash = p_token_hash, encrypted_payload = p_encrypted_payload,
    updated_at = now() where participant_id = p_participant_id and lease_id = p_lease_id
    and lease_until > now() and status = 'sending' and encrypted_payload is null;
  if not found then raise exception using message = 'Email delivery changed. Refresh and try again.', errcode = 'PT409'; end if;
end $$;

create function public.santa_begin_email_attempt(p_session_hash text, p_participant_id uuid, p_lease_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.santa_assert_admin(p_session_hash);
  perform 1 from public.santa_event where id = true for update;
  update public.santa_email_deliveries set attempt_count = attempt_count + 1, last_attempt_at = now(),
    uncertain_since = coalesce(uncertain_since, now()), updated_at = now()
  where participant_id = p_participant_id and lease_id = p_lease_id and lease_until > now()
    and status = 'sending' and encrypted_payload is not null;
  if not found then raise exception using message = 'Email lease expired. Refresh and retry.', errcode = 'PT409'; end if;
end $$;

create function public.santa_finish_email(p_session_hash text, p_participant_id uuid, p_lease_id uuid,
  p_message_id text, p_error text, p_definite_failure boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.santa_assert_admin(p_session_hash);
  perform 1 from public.santa_event where id = true for update;
  update public.santa_email_deliveries set
    status = case when p_message_id is not null then 'sent' else 'failed' end,
    sent_at = case when p_message_id is not null then now() else null end,
    resend_message_id = left(p_message_id, 200), last_error = left(p_error, 300),
    encrypted_payload = case when p_message_id is not null then null else encrypted_payload end,
    uncertain_since = case when p_message_id is not null or (p_definite_failure and uncertain_since = last_attempt_at)
      then null else uncertain_since end,
    lease_id = null, lease_until = null, updated_at = now()
  where participant_id = p_participant_id and lease_id = p_lease_id and status = 'sending';
  if not found then raise exception using message = 'Email delivery changed. Refresh for its saved status.', errcode = 'PT409'; end if;
end $$;

-- Reset must not race an external send. Reset deletes assignments before updating event state.
create function public.santa_guard_email_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from public.santa_email_deliveries where lease_until > now()) then
    raise exception using message = 'Emails are being sent. Wait 90 seconds before resetting.', errcode = 'PT409';
  end if;
  return old;
end $$;
create trigger santa_guard_email_delete before delete on public.santa_assignments
for each row execute function public.santa_guard_email_delete();

alter function public.santa_issue_token(text, uuid, text, bigint) rename to santa_issue_token_without_email;
create function public.santa_issue_token(p_session_hash text, p_participant_id uuid, p_token_hash text, p_revision bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.santa_assert_admin(p_session_hash);
  perform 1 from public.santa_event where id = true for update;
  if exists(select 1 from public.santa_email_deliveries where participant_id = p_participant_id and lease_until > now()) then
    raise exception using message = 'This email is being sent. Wait before replacing its link.', errcode = 'PT409'; end if;
  perform public.santa_issue_token_without_email(p_session_hash, p_participant_id, p_token_hash, p_revision);
  -- Explicit manual replacement revokes its email link and cancels any unsent invitation.
  update public.santa_email_deliveries set token_hash = null, encrypted_payload = null,
    status = case when status = 'sent' then 'sent' else 'cancelled' end,
    lease_id = null, lease_until = null, updated_at = now() where participant_id = p_participant_id;
end $$;

create or replace function public.santa_reveal(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  select jsonb_build_object('participantName', g.name, 'recipientName', r.name) into v_result
  from public.santa_assignments a join public.santa_participants g on g.id = a.giver_id
  join public.santa_participants r on r.id = a.recipient_id
  where a.giver_id in (select participant_id from public.santa_reveal_tokens where token_hash = p_token_hash
    union select participant_id from public.santa_email_deliveries where token_hash = p_token_hash);
  if v_result is null then raise exception using message = 'This reveal link is invalid or has expired. Ask your organizer for a current link.', errcode = 'PT404'; end if;
  return v_result;
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'santa_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.signature);
    execute format('grant execute on function %s to service_role', f.signature);
  end loop;
end $$;
