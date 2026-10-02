# Prompt without echoing the password or putting it in shell history/process arguments.
# Run after `supabase login` and `supabase link`.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command supabase -ErrorAction SilentlyContinue)) { throw 'Install the Supabase CLI first; see README.md.' }
$santaSecurePassword = Read-Host 'New organizer password (16-128 characters; no whitespace, quotes, backslashes or dollar signs)' -AsSecureString
$santaPasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($santaSecurePassword)
$santaSecretFile = $null
try {
  $santaPlainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($santaPasswordPointer)
  if ($santaPlainPassword.Length -lt 16 -or $santaPlainPassword.Length -gt 128 -or $santaPlainPassword -match '[\s''"\\$]') {
    throw 'Use 16-128 characters without whitespace, quotes, backslashes or dollar signs. A password manager can generate one.'
  }
  $santaSecretFile = [IO.Path]::GetTempFileName()
  [IO.File]::WriteAllText($santaSecretFile, "ADMIN_PASSWORD='$santaPlainPassword'`n", [Text.UTF8Encoding]::new($false))
  & supabase secrets set --env-file $santaSecretFile
  if ($LASTEXITCODE -ne 0) { throw 'Supabase did not accept the secret. Check login and project linking.' }
  Write-Host 'Organizer password secret set. Existing organizer sessions will no longer work.'
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($santaPasswordPointer)
  if ($santaSecretFile -and (Test-Path -LiteralPath $santaSecretFile)) { Remove-Item -LiteralPath $santaSecretFile -Force }
  $santaPlainPassword = $null
  $santaSecurePassword.Dispose()
}
