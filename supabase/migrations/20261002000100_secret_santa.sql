-- All browser roles are denied table access. Only Edge Functions use service_role.
create table public.santa_event (
  id boolean primary key default true check (id),
  registration_locked boolean not null default false,
  drawn_at timestamptz,
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.santa_event(id) values (true);

create table public.santa_households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 60 and name = btrim(name)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index santa_household_name_unique on public.santa_households(lower(name));

create table public.santa_participants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80 and name = btrim(name)),
  email text not null check (length(email) <= 254 and email = lower(btrim(email)) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  household_id uuid not null references public.santa_households(id) on delete restrict,
  created_at timestamptz not null default now()
);
create unique index santa_participant_email_unique on public.santa_participants(email);
create unique index santa_participant_household_name_unique on public.santa_participants(household_id, lower(name));

create table public.santa_assignments (
  giver_id uuid primary key references public.santa_participants(id) on delete restrict,
  recipient_id uuid not null unique references public.santa_participants(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (giver_id <> recipient_id)
);
create table public.santa_reveal_tokens (
  participant_id uuid primary key references public.santa_assignments(giver_id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);
create table public.santa_admin_sessions (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table public.santa_rate_limits (
  bucket text primary key,
  window_start timestamptz not null,
  attempts integer not null check (attempts > 0)
);

alter table public.santa_event enable row level security;
alter table public.santa_households enable row level security;
alter table public.santa_participants enable row level security;
alter table public.santa_assignments enable row level security;
alter table public.santa_reveal_tokens enable row level security;
alter table public.santa_admin_sessions enable row level security;
alter table public.santa_rate_limits enable row level security;
-- Intentionally no anon/authenticated policies, including for households.
revoke all on public.santa_event, public.santa_households, public.santa_participants,
  public.santa_assignments, public.santa_reveal_tokens, public.santa_admin_sessions,
  public.santa_rate_limits from public, anon, authenticated;
grant all on public.santa_event, public.santa_households, public.santa_participants,
  public.santa_assignments, public.santa_reveal_tokens, public.santa_admin_sessions,
  public.santa_rate_limits to service_role;

create function public.santa_assert_admin(p_session_hash text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.santa_admin_sessions where token_hash = p_session_hash and expires_at > now()) then
    raise exception using message = 'Admin sign-in required.', errcode = 'PT401';
  end if;
end $$;

create function public.santa_rate_limit(p_bucket text, p_limit integer, p_window_seconds integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_attempts integer;
begin
  insert into public.santa_rate_limits(bucket, window_start, attempts) values (p_bucket, now(), 1)
  on conflict (bucket) do update set
    attempts = case when public.santa_rate_limits.window_start <= now() - make_interval(secs => p_window_seconds) then 1 else public.santa_rate_limits.attempts + 1 end,
    window_start = case when public.santa_rate_limits.window_start <= now() - make_interval(secs => p_window_seconds) then now() else public.santa_rate_limits.window_start end
  returning attempts into v_attempts;
  return v_attempts <= p_limit;
end $$;

create function public.santa_start_session(p_session_hash text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.santa_admin_sessions where expires_at <= now();
  insert into public.santa_admin_sessions(token_hash, expires_at) values (p_session_hash, now() + interval '4 hours');
end $$;
create function public.santa_end_session(p_session_hash text) returns void
language plpgsql security definer set search_path = '' as $$
begin delete from public.santa_admin_sessions where token_hash = p_session_hash; end $$;

create function public.santa_public_event() returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object('households', (select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'name', h.name) order by h.created_at, h.id), '[]'::jsonb) from public.santa_households h),
    'locked', e.registration_locked, 'drawn', e.drawn_at is not null)
  from public.santa_event e where e.id = true
$$;

create function public.santa_admin_data(p_session_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform public.santa_assert_admin(p_session_hash);
  -- Take the common event lock for a consistent organizer/snapshot read.
  perform 1 from public.santa_event where id = true for share;
  select public.santa_public_event() || jsonb_build_object(
    'participants', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'email', p.email, 'householdId', p.household_id,
      'linkIssued', exists(select 1 from public.santa_reveal_tokens t where t.participant_id = p.id)) order by p.created_at, p.id), '[]'::jsonb) from public.santa_participants p),
    'revision', e.revision, 'drawnAt', e.drawn_at)
  into v_result from public.santa_event e where e.id = true;
  return v_result;
end $$;

create function public.santa_register(p_name text, p_email text, p_household_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_event public.santa_event;
begin
  select * into v_event from public.santa_event where id = true for update;
  if v_event.registration_locked or v_event.drawn_at is not null then
    raise exception using message = 'Registration is closed. Contact the organizer.', errcode = 'PT409';
  end if;
  if (select count(*) from public.santa_participants) >= 200 then
    raise exception using message = 'The event has reached its 200-participant limit.', errcode = 'PT409';
  end if;
  if not exists(select 1 from public.santa_households where id = p_household_id) then
    raise exception using message = 'Choose a current household from the list.', errcode = 'PT400';
  end if;
  insert into public.santa_participants(name, email, household_id) values (p_name, p_email, p_household_id);
  update public.santa_event set revision = revision + 1, updated_at = now() where id = true;
  return jsonb_build_object('name', p_name);
exception when unique_violation then
  raise exception using message = 'These registration details are already registered. Contact the organizer.', errcode = 'PT409';
end $$;

create function public.santa_admin_change(p_session_hash text, p_action text, p_data jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_event public.santa_event; v_id uuid; v_name text;
begin
  perform public.santa_assert_admin(p_session_hash);
  select * into v_event from public.santa_event where id = true for update;
  if p_action = 'reset' then
    if p_data->>'confirmation' is distinct from 'RESET EVENT' then raise exception using message = 'Type RESET EVENT exactly to confirm.', errcode = 'PT400'; end if;
    delete from public.santa_reveal_tokens;
    delete from public.santa_assignments;
    update public.santa_event set drawn_at = null, registration_locked = false, revision = revision + 1, updated_at = now() where id = true;
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

create function public.santa_commit_draw(p_session_hash text, p_revision bigint, p_pairs jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_event public.santa_event; v_count integer;
begin
  perform public.santa_assert_admin(p_session_hash);
  select * into v_event from public.santa_event where id = true for update;
  if v_event.drawn_at is not null then raise exception using message = 'The draw is already complete. Reset is required to draw again.', errcode = 'PT409'; end if;
  if not v_event.registration_locked then raise exception using message = 'Close registration before drawing names.', errcode = 'PT409'; end if;
  if v_event.revision is distinct from p_revision then raise exception using message = 'The family list changed. Refresh and try again; nothing was saved.', errcode = 'PT409'; end if;
  select count(*) into v_count from public.santa_participants;
  if v_count < 2 or jsonb_typeof(p_pairs) is distinct from 'array' or jsonb_array_length(p_pairs) <> v_count then
    raise exception using message = 'A complete valid draw is required.', errcode = 'PT400';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_pairs) as x("giverId" uuid, "recipientId" uuid)
    left join public.santa_participants g on g.id = x."giverId"
    left join public.santa_participants r on r.id = x."recipientId"
    where g.id is null or r.id is null or g.id = r.id or g.household_id = r.household_id
  ) then raise exception using message = 'Invalid assignment: household and self restrictions apply.', errcode = 'PT400'; end if;
  -- PK/UNIQUE/FK constraints independently enforce a bijection over current participants.
  insert into public.santa_assignments(giver_id, recipient_id)
    select "giverId", "recipientId" from jsonb_to_recordset(p_pairs) as x("giverId" uuid, "recipientId" uuid);
  update public.santa_event set drawn_at = now(), revision = revision + 1, updated_at = now() where id = true;
end $$;

create function public.santa_issue_token(p_session_hash text, p_participant_id uuid, p_token_hash text, p_revision bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare v_event public.santa_event;
begin
  perform public.santa_assert_admin(p_session_hash);
  select * into v_event from public.santa_event where id = true for update;
  if v_event.drawn_at is null or v_event.revision is distinct from p_revision then
    raise exception using message = 'The event changed. Refresh before creating this link.', errcode = 'PT409';
  end if;
  if not exists(select 1 from public.santa_assignments where giver_id = p_participant_id) then
    raise exception using message = 'Participant not found in this draw.', errcode = 'PT404';
  end if;
  insert into public.santa_reveal_tokens(participant_id, token_hash) values (p_participant_id, p_token_hash)
    on conflict(participant_id) do update set token_hash = excluded.token_hash, created_at = now();
end $$;

create function public.santa_reveal(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  select jsonb_build_object('participantName', g.name, 'recipientName', r.name) into v_result
  from public.santa_reveal_tokens t
  join public.santa_assignments a on a.giver_id = t.participant_id
  join public.santa_participants g on g.id = a.giver_id
  join public.santa_participants r on r.id = a.recipient_id
  where t.token_hash = p_token_hash;
  if v_result is null then raise exception using message = 'This reveal link is invalid or has expired. Ask your organizer for a current link.', errcode = 'PT404'; end if;
  return v_result;
end $$;

-- New functions otherwise receive PUBLIC execution by default. Lock every routine.
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
