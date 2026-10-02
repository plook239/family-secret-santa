# Security review

## Trust and authorization

GitHub Pages is a public static client. Its public key and UI state grant no privileged access. Every table has RLS enabled and browser grants revoked; no anon/authenticated policies exist. Public callers cannot query emails, assignments, session hashes, token hashes, or execute the service-only SQL routines. Table ownership and the Supabase service-role key are trusted administration boundaries.

Edge Functions use the automatically supplied service-role key only server-side to call explicit database routines. Each privileged handler validates a 256-bit opaque session via a restricted RPC. Each transaction checks it again and locks the event row. Browser IDs are validated/resolved against current database rows; supplied admin flags, assignments and revision/lock state are ignored. SQL functions use `SECURITY DEFINER`, an empty search path, qualified tables, parameterized inputs and restricted EXECUTE grants.

One organizer password lives in Supabase secrets. Login compares fixed-length SHA-256 digests without early-exit comparison. No password verifier is stored in the database. Sessions are random 32-byte tokens; Postgres stores HMAC-SHA-256(session token, organizer password), expires them after four hours, and revokes them on sign-out. Changing the password invalidates sessions once functions receive the new environment. The browser stores only the session in tab-scoped sessionStorage, never the password/hash, and clears it on a privileged 401.

## Atomic state changes

Every supported mutation locks the singleton event and increments its revision. SQL independently checks registration/draw state. Generation uses the unchanged tested augmenting-path solver with secure candidate-order randomness. Commit rechecks snapshot revision, cardinality, current IDs, households, no-self matches and lock state. PK/UNIQUE/FK constraints enforce one giver and recipient each. Errors roll back the entire transaction. Concurrent draws serialize; the second is rejected. Other concurrent mutations invalidate the snapshot.

Successful draws freeze the list. Reset requires a valid session and exact `RESET EVENT` confirmation, checked in SQL too. Reset atomically clears token hashes/assignments, increments revision and reopens registration while retaining households/participants.

## Reveal privacy

Generation returns success without pairings/tokens. Admin summaries include participant contact details and link-issued flags, never recipients, token hashes or values. A separate authorized action issues one 256-bit token for one selected participant, returns it once and stores only SHA-256. No bulk token endpoint exists. Issuance checks current draw revision under the event lock. Replacement revokes the old hash; reset deletes all hashes.

Reveal hashes the supplied credential and joins only its associated assignment. The only response fields are `participantName` and `recipientName`. URLs use fragments (not transmitted to GitHub Pages); reveal requests use JSON bodies rather than token-bearing function URLs. The reveal page uses no-referrer. Responses and fetch calls use no-store. Handler code does not log passwords, sessions, emails, tokens or response bodies.

Anyone possessing a reveal link can see that one result. The trusted organizer can deliberately replace a person's link and use it; this system does not make an organizer cryptographically unable to learn pairings. The UI never casually lists them. Delivery is manual; no email verification/provider is included.

## Cross-origin and abuse controls

Exact allowed origins, POST/OPTIONS, and explicit custom session headers support GitHub Pages without cookies/wildcards. GET cannot mutate/reveal. CORS is a browser restriction, not authorization: non-browser clients may omit/spoof Origin but still need valid admin/reveal credentials. Public endpoints remain intentionally public.

Atomic global counters throttle login, registration and reveal. Global login limits avoid trusting browser-supplied IP headers. A malicious caller can consume allowances and temporarily deny normal users. No CAPTCHA, invitation code, email ownership verification, per-IP distributed firewall or automatic mail service is implemented. Anyone can register while open; review the list before drawing. Duplicate errors can indicate that registration details are already in use; email values are never returned publicly.

Bodies are streamed with an 8 KiB cap. Content type/JSON shape, string lengths/control characters, email syntax, UUIDs, booleans and confirmation are checked. Raw database errors/constraint details are hidden. User text uses textContent/input values. No third-party scripts/fonts/frameworks are loaded by the application. HTTPS is required outside localhost. The frontend/browser must be trusted: a compromised frontend could steal bearer credentials.

## Deployment and verification

Public config uses production mode and contains only the hosted project URL and publishable key. Invalid or missing values fail closed. Demo is localhost-only with separate storage, never a production fallback. The manual Pages workflow validates configuration and repository-relative paths, then publishes a fixed allowlist of production frontend files. Demo modules, tests, SQL, helpers, ignored dependencies and secrets are excluded. No localStorage-to-production import occurs.

The password helper avoids history/process-argument exposure but uses a short-lived plaintext temp file, deleted in `finally`. Other processes under the same Windows account are outside this app's boundary. Use a password manager, keep `.env` files private and do not enable request-body logging. Supabase owners/service-role holders can read all database rows by design.

Tests exercised real PostgreSQL grants/RLS, restricted RPCs, sessions, locking, constraints, stale/invalid draws, rollback, repeat draws, token replacement/reset and response scope. Production UI was tested through the handler and Postgres locally. Deno checked all entrypoints. Hosted routing/bundling, deployed CORS, secret propagation and Pages still require a real-project smoke test. This is a reviewed implementation, not an independent penetration test.
