$ErrorActionPreference = 'Stop'
$santaProjectRoot = Split-Path -Parent $PSScriptRoot
$santaNpx = Get-Command npx.cmd -ErrorAction SilentlyContinue
if (-not $santaNpx) { throw 'npx is unavailable. Install Node.js and npm, then reopen PowerShell.' }
if (-not (Test-Path -LiteralPath (Join-Path $santaProjectRoot 'node_modules/.bin/supabase.cmd') -PathType Leaf)) {
  throw 'Install the project CLI by running npm install supabase --save-dev from the repository root.'
}
$santaFunctionNames = @(
  'public-event', 'register-participant', 'admin-login', 'admin-logout', 'admin-data',
  'create-household', 'rename-household', 'delete-household', 'remove-participant',
  'set-registration', 'generate-assignments', 'issue-reveal-token', 'reveal-assignment', 'reset-event'
)
Push-Location -LiteralPath $santaProjectRoot
try {
  foreach ($santaFunctionName in $santaFunctionNames) {
    # Use the project's installed CLI; never download a different version implicitly.
    # Platform Auth JWTs are not used. Our handler and SQL enforce opaque admin sessions.
    & $santaNpx --no-install supabase functions deploy $santaFunctionName --no-verify-jwt --use-api
    if ($LASTEXITCODE -ne 0) { throw "Deployment failed for $santaFunctionName. Fix the error before retrying." }
  }
} finally {
  Pop-Location
}
