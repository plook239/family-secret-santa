# Prompt privately; the API key is never placed in command history.
$ErrorActionPreference = 'Stop'
$santaProjectRoot = Split-Path -Parent $PSScriptRoot
$santaNpx = Get-Command npx.cmd -ErrorAction SilentlyContinue
if (-not $santaNpx -or -not (Test-Path -LiteralPath (Join-Path $santaProjectRoot 'node_modules/.bin/supabase.cmd') -PathType Leaf)) {
  throw 'Install the project CLI first: npm install supabase --save-dev'
}
$santaSecureKey = Read-Host 'Paste your Resend API key (hidden)' -AsSecureString
$santaKeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($santaSecureKey)
$santaSecretFile = $null
try {
  $santaPlainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($santaKeyPointer)
  if ($santaPlainKey -notmatch '^re_[A-Za-z0-9_-]+$') { throw 'Enter the Resend API key starting with re_.' }
  $santaFrom = Read-Host 'Sender, e.g. Family Secret Santa <santa@your-verified-domain.com>'
  if ($santaFrom -notmatch '^(?:[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+|[^<>]+ <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>)$' -or $santaFrom -match '[\x00-\x1f\x7f''"\\$]' -or $santaFrom.Length -gt 254) {
    throw 'Use an address on your verified domain, optionally with a display name. Do not use quotes, backslashes or dollar signs.'
  }
  $santaSite = Read-Host 'Public site URL (Enter for https://plook239.github.io/family-secret-santa/)'
  if (-not $santaSite) { $santaSite = 'https://plook239.github.io/family-secret-santa/' }
  $santaSiteUri = $null
  if (-not [Uri]::TryCreate($santaSite, [UriKind]::Absolute, [ref]$santaSiteUri) -or
      $santaSiteUri.Scheme -ne 'https' -or $santaSiteUri.UserInfo -or $santaSiteUri.Query -or $santaSiteUri.Fragment -or
      -not $santaSiteUri.AbsolutePath.EndsWith('/') -or $santaSite -match '[\s''"\\$]') {
    throw 'Use the HTTPS site base URL ending in /, without query, fragment or credentials.'
  }
  $santaSecretFile = [IO.Path]::GetTempFileName()
  [IO.File]::WriteAllText($santaSecretFile, "RESEND_API_KEY='$santaPlainKey'`nEMAIL_FROM='$santaFrom'`nPUBLIC_SITE_URL='$santaSite'`n", [Text.UTF8Encoding]::new($false))
  Push-Location -LiteralPath $santaProjectRoot
  try {
    & $santaNpx --no-install supabase secrets set --env-file $santaSecretFile
    if ($LASTEXITCODE -ne 0) { throw 'Supabase did not accept the secrets. Check CLI login and project linking.' }
  } finally { Pop-Location }
  Write-Host 'Email secrets set in Supabase. No frontend configuration was changed.'
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($santaKeyPointer)
  if ($santaSecretFile -and (Test-Path -LiteralPath $santaSecretFile)) { Remove-Item -LiteralPath $santaSecretFile -Force }
  $santaPlainKey = $null
  $santaSecureKey.Dispose()
}
