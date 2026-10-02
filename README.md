# Family Secret Santa

The existing vanilla HTML/CSS/JavaScript frontend now uses Supabase Postgres and Edge Functions. GitHub Pages serves only static files. No framework, bundler, service-role key or organizer password is needed in browser code.

Transactional Resend invitations are sent after the atomic draw commits. For an already-live project, follow [Add Resend to the live app](#add-resend-to-the-live-app) below; you do not need a new project, new frontend keys or a new draw.

**Default mode is production (`supabase`).** The app reports missing configuration until you create/link a project, apply the migration, set secrets, deploy functions, and fill in `js/config.js`. Existing localStorage registrations are not uploaded. The original demo remains available explicitly on localhost.

## Windows setup, in order

Use a regular PowerShell window, not an administrator window. Replace capitalized placeholders with your own values. These steps configure Supabase; they do not publish the frontend yet.

### 1. Install the Supabase CLI

Supabase supports Scoop on Windows. This works with your current Node 14 installation; the npm/npx CLI route requires Node 20+. See [official installation](https://supabase.com/docs/guides/local-development/cli/getting-started) and [Windows commands](https://github.com/supabase/cli#installation).

If Scoop is not installed, run one command at a time:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
Invoke-RestMethod -Uri 'https://get.scoop.sh' | Invoke-Expression
```

The first permits local PowerShell scripts for your Windows account; confirm with `Y`. The second runs the [official Scoop installer](https://github.com/ScoopInstaller/Install). Reopen PowerShell if `scoop` is not found afterward.

Install Git if needed, then Supabase:

```powershell
scoop install git
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
supabase --version
```

Do not run `supabase init`: this repository already has `supabase/config.toml`.

### 2. Log in

```powershell
Set-Location -LiteralPath 'C:\Users\Peter\Desktop\Secret Santa\family-secret-santa'
supabase login
```

Follow the browser/token prompt. This authenticates the CLI to your Supabase account. Do not commit an access token.

### 3. Create a project

```powershell
Start-Process 'https://supabase.com/dashboard'
```

Sign up/sign in, choose **New project**, choose an organization, name it `family-secret-santa`, generate/save a strong **database password**, and choose a nearby region. Review the plan and wait for provisioning. The database password is different from the organizer password below.

Copy the reference from the dashboard URL: `https://supabase.com/dashboard/project/PROJECT_REF`.

### 4. Link this repository

```powershell
supabase link --project-ref YOUR_PROJECT_REF
```

Enter the database password if prompted. Never put it in browser configuration.

### 5. Apply migrations

For your new, empty project:

```powershell
supabase db push
```

Review/confirm the migration prompt. This creates the event, households, participants/emails, assignments, reveal-token hashes, session hashes, rate-limit tables and restricted transactional routines. All tables have RLS and no browser grants or policies. Do not run a remote database reset.

### 6. Set the organizer password and allowed origins

The helper prompts without echoing the password or putting it in shell history:

```powershell
.\scripts\set-admin-password.ps1
```

Choose a unique 16–128-character password. The helper excludes whitespace, quotes, backslashes and dollar signs so dotenv parsing preserves it exactly. It uploads through a temporary file and deletes the file in `finally`. Save the password in your password manager. Its persistent application storage is the Supabase `ADMIN_PASSWORD` secret. Never put it in `js/config.js`, a commit or GitHub Pages. Changing this secret invalidates old sessions once functions receive the new environment.

Allow exact origins, with scheme/hostname/port but **no path or trailing slash**:

```powershell
supabase secrets set 'ALLOWED_ORIGINS=http://127.0.0.1:8000,http://localhost:8000,https://YOUR_GITHUB_USERNAME.github.io'
```

Replace the username. Add a custom HTTPS domain if applicable. The repository path is not part of the origin. Keep localhost entries while testing; remove later if desired. Hosted functions automatically receive `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; never copy those secrets to browser code.

### 7. Deploy the Edge Functions

```powershell
.\scripts\deploy-functions.ps1
```

This deploys all 15 functions, stopping on failure. The API bundler (`--use-api`) avoids requiring Docker for hosted deployment. `verify_jwt = false` is deliberate: this app uses public endpoints and custom password-based sessions, not Supabase Auth users. Privileged handlers and SQL transactions both validate the admin session. The public key is not admin authorization. See [function authentication](https://supabase.com/docs/guides/functions/auth).

Redeploy one changed function with, for example:

```powershell
supabase functions deploy admin-login --no-verify-jwt --use-api
```

Redeploy **all** functions after changes to shared code or the solver.

### 8. Find the project URL and public key

Use **Connect** or **Settings → API / API Keys** in the Supabase dashboard:

- Project URL: `https://YOUR_PROJECT_REF.supabase.co`.
- Preferred browser key: **publishable**, starting `sb_publishable_`.
- The legacy **anon** key also works.

Never use **secret**, **service_role**, a database connection string, or the organizer password in the frontend. The adapter rejects known secret/service-role formats. See [API keys](https://supabase.com/docs/guides/getting-started/api-keys).

### 9. Configure the frontend

```powershell
notepad .\js\config.js
```

Fill in its existing public configuration:

```javascript
export const config = Object.freeze({
  mode: 'supabase',
  supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',
  publicKey: 'YOUR_PUBLISHABLE_OR_LEGACY_ANON_KEY'
});
```

This public file should be committed for deployment. Use the project root URL, without `/rest/v1` or `/functions/v1`. HTTPS is required outside localhost. GitHub Pages needs no build or runtime environment injection.

### 10. Run and test locally against hosted Supabase

In PowerShell:

```powershell
Set-Location -LiteralPath 'C:\Users\Peter\Desktop\Secret Santa\family-secret-santa'
python -m http.server 8000 --bind 127.0.0.1
```

Leave it running. In another PowerShell window:

```powershell
Start-Process 'http://127.0.0.1:8000/admin.html'
```

Sign in, create at least two households, open the home page to register sample people, close registration, and draw. If Resend secrets are configured, each participant receives a private invitation; its email never contains their drawn name. The organizer sees delivery counts and **Retry failed emails** when needed. Email failure preserves the draw. See the Resend instructions below before testing on real participants. Manual link replacement remains available under **Personal reveal links** and invalidates that person's old manual/emailed link; an unsent invitation is cancelled. The copied replacement is shown only once, so share it privately before leaving the page.

Before real invitations, test duplicate registration, impossible household sizes, removal, lock/unlock, repeat generation, one-person reveals, refresh, link replacement, and reset. Reset the sample draw and remove sample participants before real registration; reset retains the family list. Stop the frontend server with `Ctrl+C`; Supabase data persists. These steps use the actual hosted project, so use a separate development project once real registration starts.

**Optional: fully local Supabase.** Install/open [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/), then:

```powershell
supabase start
supabase db reset --local
Copy-Item .\supabase\.env.example .\supabase\.env.local
notepad .\supabase\.env.local
supabase functions serve --env-file .\supabase\.env.local --no-verify-jwt
```

Set a separate development password in the ignored `.env.local`. Leave functions running. In another window, run `supabase status`; put the local URL (normally `http://127.0.0.1:54321`) and **publishable/anon** key in `js/config.js`. Then use the Python frontend server. `db reset --local` clears local data only; never use `--linked`. Restore the hosted URL/key before publishing. Stop the stack with `supabase stop`.

### 11. Publish later to GitHub Pages

Your backend is already deployed and `js/config.js` contains the public hosted configuration. Leave `mode: 'supabase'`; publishing the frontend does not require redeploying Supabase or changing its database.

The supplied `.github/workflows/pages.yml` is **manual-only**. Pushing commits does not deploy. It validates the public configuration and repository-relative paths, then copies a fixed allowlist of production HTML/CSS/JS files unchanged. Demo modules, backend code, tests, SQL, helpers, local dependencies and secret files are excluded. No bundler or install step is required in the workflow; the generated `site/` folder is ignored by Git.

**Create the remote repository first.** The local Git repository already exists, but currently has no commits or configured remote. In GitHub, create an empty repository named `family-secret-santa`. Choose **Public** for GitHub Pages on a free personal account. Do not initialize it with a README, license or .gitignore; those would create a competing first commit. If you already created an empty repository with that name, use it. Replace `USERNAME` below with your GitHub username.

From PowerShell, run:

```powershell
Set-Location -LiteralPath 'C:\Users\Peter\Desktop\Secret Santa\family-secret-santa'
git branch -M main
git add .
git diff --cached --name-only
git diff --cached
git commit -m "Prepare Secret Santa for GitHub Pages"
git remote add origin https://github.com/USERNAME/family-secret-santa.git
git push -u origin main
```

Review the staged files before the commit. The project URL and publishable key in `js/config.js` are intentionally public and safe to commit. Keep `.env` files, backend secret keys, database passwords and organizer passwords out of Git. The supplied ignore rules exclude secret env files and local Supabase state. If Git requests your author identity, configure your own name/email, then retry the commit. Authenticate the push using GitHub's browser/credential-manager prompt. If an `origin` remote already exists, inspect `git remote -v` and use it rather than adding a second one.

In the GitHub repository:

1. Open **Settings → Pages → Build and deployment → Source**.
2. Select **GitHub Actions**. Do not select **Deploy from a branch** for this workflow.
3. Open **Actions → Publish frontend to GitHub Pages → Run workflow**.
4. Select branch **main**, then click **Run workflow**. This is the explicit deployment step.
5. Open the URL reported by the successful deployment. Use the trailing slash on the home URL.

Expected addresses:

```text
https://USERNAME.github.io/family-secret-santa/
https://USERNAME.github.io/family-secret-santa/index.html
https://USERNAME.github.io/family-secret-santa/admin.html
https://USERNAME.github.io/family-secret-santa/reveal.html#/reveal/TOKEN
```

Both `index.html#/reveal/TOKEN` and the directory home `#/reveal/TOKEN` redirect to the reveal page within the same repository path. Refreshing a reveal URL requests the real `reveal.html` file; no SPA rewrite, custom 404 page or server router is needed.

**Add the Pages origin to Supabase before using the published app.** The origin is exactly `https://USERNAME.github.io`, without `/family-secret-santa/` or a trailing slash. Since you installed the CLI locally, use `npx`:

```powershell
npx supabase secrets set 'ALLOWED_ORIGINS=http://127.0.0.1:8000,https://USERNAME.github.io'
```

This command sets the entire comma-separated value; preserve any other origins you still need, such as `http://localhost:8000`. For a custom domain, also add its exact HTTPS origin. No GitHub repository secret is needed; Supabase retains all backend secrets.

After deployment, open the home and organizer pages, sign in, and confirm the household list loads. Create reveal links from the published organizer page so their URLs use the production hostname. Previously created local links still point at localhost; their same token can be used with the production `reveal.html` URL without regenerating the draw. Public configuration remains the same on both sites. See [GitHub's workflow guide](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

**Repeat the Pages checks locally, without deploying:**

```powershell
node .\tests\pages.mjs
python .\tests\pages-server.py
```

Leave that server running. In another PowerShell window:

```powershell
Start-Process 'http://127.0.0.1:8001/pages-browser.html'
```

The test harness serves the exact Pages artifact at `/family-secret-santa/` and intercepts API calls with local fixtures. It does not query or modify the live Supabase project. Verified: 22 asset/module references and 22 browser checks covering CSS/JS loading, native navigation, all three pages, generated reveal URLs, both home hash aliases, reveal refresh and mobile width. The existing seven algorithm/service test groups also pass. Stop the test server with `Ctrl+C`.

## Structure and API

```text
index.html / admin.html / reveal.html   Existing UI; organizer sign-in added
css/styles.css                         Original mobile-first design
js/config.js                           Public frontend configuration
js/service.js                          Production/demo composition point
js/supabase-service.js                 Fetch adapter, tab-scoped session
js/demo-service.js                     Explicit localhost-only demo
js/assignment.js                       Re-export of the single shared solver
supabase/migrations/                   Schema, RLS, grants, SQL transactions
supabase/functions/_shared/            Canonical solver, validation, crypto, HTTP/CORS
supabase/functions/*/index.ts          Named Edge entrypoints
scripts/                               Password/deployment helpers
tests/                                 Algorithm, UI, Edge, database checks
docs/SECURITY.md                        Security review and limits
```

| Function | Authorization | Purpose |
|---|---|---|
| `public-event` | Public | Households and status only |
| `register-participant` | Public, throttled | Validated registration |
| `admin-login` | Password secret, throttled | Issue four-hour admin session |
| `admin-logout` | Admin session | Revoke session |
| `admin-data` | Admin session | Participants/emails, no pairs/tokens |
| `create-household`, `rename-household`, `delete-household` | Admin session | Household management, empty-only deletion |
| `remove-participant` | Admin session | Remove before draw |
| `set-registration` | Admin session | Lock/unlock before draw |
| `generate-assignments` | Admin session | Tested solver + atomic commit |
| `retry-failed-emails` | Admin session | Retry unsent invitations; never redraw or resend recorded successes |
| `issue-reveal-token` | Admin session | One participant's link, returned once |
| `reveal-assignment` | Reveal token, throttled | Only giver/recipient names |
| `reset-event` | Admin + exact confirmation | Clear draw/tokens, reopen |

Endpoints use JSON POST and CORS OPTIONS. Browser code never queries tables. Every state mutation acquires the event row lock and increments its revision. Generation computes a complete matching from a server snapshot; its commit rechecks revision, lock and membership and atomically inserts all assignments/marks completion. Database constraints enforce one giver/recipient. Stale/invalid draws save nothing; repeat generation is blocked in both layers.

## Demo and tests

For frontend work without Supabase, serve the files and open:

```powershell
Start-Process 'http://127.0.0.1:8000/index.html?demo=1'
Start-Process 'http://127.0.0.1:8000/admin.html?demo=1'
```

Use `?demo=1` on each page, or temporarily set `mode: 'demo'` on localhost. This override is ignored on GitHub Pages; production cannot fall back to localStorage. Demo data is not private and is separate from Supabase data.

Existing dependency-free Node 14+ tests:

```powershell
node .\tests\run.mjs
```

With the Python server running:

```powershell
Start-Process 'http://127.0.0.1:8000/tests/browser.html'
Start-Process 'http://127.0.0.1:8000/tests/backend.html'
```

For real PostgreSQL migration/RLS/transaction checks without Docker, install an optional test dependency in an ignored folder:

```powershell
npm install --prefix .backend-test --no-save @electric-sql/pglite@0.5.8
Start-Process 'http://127.0.0.1:8000/tests/backend.html?database=1'
Start-Process 'http://127.0.0.1:8000/tests/production-ui.html'
```

The production UI harness exercises UI → production adapter → Edge handler → PostgreSQL in memory, including sign-in, link issuance, reveal, reset and logout. Test pages never connect to your hosted database. PGlite is not an application dependency. `tests/database.sql` also runs against local Supabase Postgres and rolls sample data back; use only a disposable/local test database.

Automated checks include the original seven algorithm/demo groups, 40 demo UI checks, Edge/security/adapter and PostgreSQL checks, native Deno tests, production organizer/email UI integration, and Pages subpath tests. All 15 Edge entrypoints pass Deno checking. Tests use local PostgreSQL and mocked Resend, never your hosted project. Real Resend delivery still requires the configuration and smoke test below; no remote deployment or real email was performed during implementation.

If Deno is installed, run the six native Edge HTTP/crypto tests without any network or extra dependencies:

```powershell
deno test .\tests\edge.test.js
```

## Security and manual settings

Read [the security review](docs/SECURITY.md). Configure manually: account/project/reference/database password, organizer password secret, allowed origins, frontend URL/public key, GitHub Pages settings, and the Resend secrets below.

## Add Resend to the live app

### 1. Configure Resend and a sending domain

Run in PowerShell to open Resend:

```powershell
Start-Process 'https://resend.com/domains'
Start-Process 'https://resend.com/api-keys'
```

Create/sign into your Resend account. In **Domains → Add domain**, enter a domain or subdomain you own, for example `mail.yourdomain.com`. Add the exact SPF/DKIM DNS records Resend displays at your domain's DNS provider, then use **Verify DNS records** and wait for verification. Your GitHub Pages address does not need to change. You cannot verify `github.io` as your sending domain because you do not own its DNS. See [Resend domain verification](https://resend.com/docs/dashboard/domains/introduction).

Choose a sender on the verified domain, e.g. `Family Secret Santa <santa@mail.yourdomain.com>`. Keep click/open tracking disabled for these private invitations. In **API Keys → Create API key**, name it `Family Secret Santa`, choose **Sending access**, restrict it to the verified domain, and copy the generated key starting with `re_`. Save it in your password manager; do not put it in GitHub or `js/config.js`. See [API key permissions](https://resend.com/docs/dashboard/api-keys/introduction).

Resend's default test sender `onboarding@resend.dev` is restricted to the account owner's address. To email family members, verify your own domain first. Check your account's sending quota before a real draw. “Sent” in this app means Resend accepted the message, not that it reached an inbox; use Resend's **Emails** dashboard to check delivery/bounces. No webhook or bounce-triggered resend is implemented.

### 2. Apply the additive migration and set the three secrets

Your existing linked project, organizer password, CORS origins and public frontend config remain in use. In PowerShell:

```powershell
Set-Location -LiteralPath 'C:\Users\Peter\Desktop\Secret Santa\family-secret-santa'
npx supabase db push
powershell -ExecutionPolicy Bypass -File .\scripts\set-email-secrets.ps1
```

The migration adds a private delivery outbox with RLS and restricted RPCs. Existing assignments and manually issued links are preserved; each existing assignment gets an unsent invitation row. Do **not** reset or regenerate your live draw to enable email.

The helper uses the project's locally installed Supabase CLI through `npx --no-install`. It prompts for:

| Supabase secret | Enter |
| --- | --- |
| `RESEND_API_KEY` | Your `re_...` key; input is hidden |
| `EMAIL_FROM` | Your verified sender, e.g. `Family Secret Santa <santa@mail.yourdomain.com>` |
| `PUBLIC_SITE_URL` | Press Enter for `https://plook239.github.io/family-secret-santa/` |

The site URL must use HTTPS and include the repository path and final `/`, without a query or hash. Email links become `https://plook239.github.io/family-secret-santa/reveal.html#/reveal/TOKEN`, even when the organizer opens the app on localhost. The helper sends all three values to Supabase using a short-lived temporary env file and deletes it in `finally`; it neither commits values nor changes frontend config. It never prints the API key or puts it in your command history. These values are read only by Edge Functions via `Deno.env.get()`.

Keep the existing `ADMIN_PASSWORD` unchanged while queued emails may need retries: failed-message payloads are AES-GCM encrypted using a domain-separated key derived from this secret. No extra encryption secret is required. Once an invitation is recorded as sent, its ciphertext is erased and only its token hash remains. Password rotation still revokes organizer sessions; previously sent reveal links continue to work, but queued ciphertext cannot be opened with a new password. If rotation is necessary, deliver affected invitations through explicit manual replacement links rather than resetting the draw.

### 3. Deploy all updated Edge Functions

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-functions.ps1
```

This deploys all 15 endpoints, including **retry-failed-emails**, and updates every function that imports the shared handler. It does not deploy GitHub Pages. Deploy the migration first; new handlers depend on the new SQL routines. No Resend key is needed in GitHub Actions.

### 4. Check the UI locally, then publish the frontend

```powershell
python -m http.server 8000 --bind 127.0.0.1
```

In a second PowerShell window:

```powershell
Start-Process 'http://127.0.0.1:8000/admin.html'
```

Sign in and inspect the existing draw's email counts. Clicking **Retry failed emails** will send real invitations to registered addresses; it also sends pending invitations for a draw created before this update. Review those addresses first. Successful messages are skipped. Do not reset the family's live draw for testing.

For a controlled real-email smoke test, use a separate test Supabase project with two household registrations at email addresses you control, configure/deploy there, and generate the draw once. Verify both individual HTML/text invitations, private URLs, hidden reveal results until the button is clicked, and unchanged assignments after another retry. For simulated failures, use the automated tests below rather than altering live secrets or sending to invented addresses.

After local review, publish the UI update to your existing repository:

```powershell
git add README.md docs/SECURITY.md admin.html js/admin.js js/supabase-service.js scripts/deploy-functions.ps1 scripts/set-email-secrets.ps1 supabase/config.toml supabase/.env.example supabase/functions/_shared/handler.js supabase/functions/_shared/email.js supabase/functions/retry-failed-emails/index.ts supabase/migrations/20261002000200_email_delivery.sql tests/backend.html tests/production-ui.html tests/email.test.js
git diff --cached
git commit -m "Add private Secret Santa email invitations with Resend"
git push origin main
Start-Process 'https://github.com/plook239/family-secret-santa/actions'
```

In GitHub, choose **Publish frontend to GitHub Pages → Run workflow → main → Run workflow**. The existing workflow is manual-only. When complete:

```powershell
Start-Process 'https://plook239.github.io/family-secret-santa/admin.html'
```

### Retry and interruption behavior

The draw and queued outbox rows commit atomically before any Resend call. Email outages/configuration errors preserve that draw; they return an organizer-only summary/error. Invitations are sent in bounded batches of up to 20. The UI continues remaining pending batches while open, stopping if the provider reports an error. No always-running worker is required. If you close/refresh during a large batch, saved progress survives; reopen the organizer page, use **Refresh email status**, then **Retry failed emails** to resume unsent invitations. A crashed worker's lease expires after 90 seconds. Reset and manual link replacement are blocked while a relevant send lease is active.

Each email has one stable random token and one delivery UUID/idempotency key. The immutable email body is encrypted before sending so a retry uses the identical private URL and provider request. Database leases prevent simultaneous sends of a message; recorded successes are permanently excluded until an explicit event reset. The organizer response never contains pairings or email tokens.

Resend retains [idempotency keys for 24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys). After 23 hours, messages with an ambiguous earlier outcome enter **Needs review** and automatic retry stops instead of risking a duplicate. Check Resend's Emails dashboard against the participant name shown in the organizer's problem list. If already accepted, leave it alone and share their original email. If a replacement is necessary, **Replace reveal link** creates a manual link, revokes the emailed link and cancels any unsent invitation; share it privately. Do not reset/redraw to fix mail. Fully definite failures can be retried later, but do not change the frozen sender/site/body while retrying an ambiguous request.

### Offline automated email tests

No test sends real email. Install optional tooling in the ignored test folder:

```powershell
npm install --prefix .backend-test --no-save @electric-sql/pglite@0.5.8 deno
node .\tests\run.mjs
node .\tests\pages.mjs
& .\.backend-test\deno.cmd test --allow-read --allow-env .\tests\edge.test.js .\tests\email.test.js
& .\.backend-test\deno.cmd check .\supabase\functions\*\index.ts
```

Deno has no network permission in this test command. Email tests run the real migrations/Edge handlers against isolated in-memory PostgreSQL, intercept Resend, and cover success, partial failure, identical-token retries, no successful resend, unchanged draws, concurrent generation/retries, reset races, scoped reveal/revocation, encryption, credential/config errors, and expiry of uncertain delivery. No test reads your live credentials.

With the local Python server running, open the browser integration checks:

```powershell
Start-Process 'http://127.0.0.1:8000/tests/browser.html'
Start-Process 'http://127.0.0.1:8000/tests/backend.html?database=1'
Start-Process 'http://127.0.0.1:8000/tests/production-ui.html'
```

These also use local fixtures/PostgreSQL and mock Resend. The production UI test covers partial failure, the retry button, refresh without resending, and mobile width. Backend files and secret helpers remain excluded from the GitHub Pages artifact.

Registration is intentionally public and does not verify email ownership. Admin sessions are bearer credentials in sessionStorage. Use HTTPS, a unique high-entropy organizer password and sign out on shared computers. Global database-backed limits are 20 logins/15 minutes, 60 registrations/hour and 120 reveals/minute; noisy traffic can exhaust them. Adjust limits in the shared handler/redeploy if needed. Do not disable RLS or add public SELECT grants to fix configuration errors.
