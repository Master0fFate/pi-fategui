# No named script parameters: user flags must not bind PowerShell parameters.
$LaunchArgs = @($args)
$ErrorActionPreference = 'Stop'
# The script binder consumes --. Windows PowerShell 5 also forwards a quoted
# trailing backslash incorrectly to native .cmd programs. Read the raw -File
# tail with Windows quoting rules, accepting that final single-backslash form
# as a closing path delimiter rather than a literal quote in the file name.
function Read-NativeArguments([string]$Line) {
  $result = New-Object 'System.Collections.Generic.List[string]'
  $token = New-Object Text.StringBuilder
  $quoted = $false; $started = $false
  for ($p = 0; $p -lt $Line.Length; $p++) {
    $char = $Line[$p]
    if (($char -eq ' ' -or $char -eq [char]9) -and !$quoted) {
      if ($started) { $result.Add($token.ToString()); [void]$token.Clear(); $started = $false }
      continue
    }
    $started = $true
    if ($char -eq '\') {
      $count = 1
      while ($p + 1 -lt $Line.Length -and $Line[$p + 1] -eq '\') { $count++; $p++ }
      if ($p + 1 -lt $Line.Length -and $Line[$p + 1] -eq '"') {
        $p++
        [void]$token.Append(('\' * [Math]::Floor($count / 2)))
        if ($count % 2 -eq 1) {
          if ($quoted -and ($p + 1 -eq $Line.Length -or $Line[$p + 1] -eq ' ' -or $Line[$p + 1] -eq [char]9)) {
            [void]$token.Append('\'); $quoted = $false
          } else { [void]$token.Append('"') }
        } else { $quoted = !$quoted }
      } else { [void]$token.Append(('\' * $count)) }
    } elseif ($char -eq '"') { $quoted = !$quoted }
    else { [void]$token.Append($char) }
  }
  if ($quoted) { throw 'Invalid command line quoting.' }
  if ($started) { $result.Add($token.ToString()) }
  return $result.ToArray()
}
try { $nativeArgs = @(Read-NativeArguments ([Environment]::CommandLine)) }
catch { [Console]::Error.WriteLine('Fate launch failed. Invalid command line quoting.'); exit 1 }
for ($i = 1; $i -lt $nativeArgs.Length - 1; $i++) {
  if ($nativeArgs[$i] -ieq '-File' -and [IO.Path]::GetFullPath($nativeArgs[$i + 1]) -eq $PSCommandPath) {
    $LaunchArgs = @($nativeArgs | Select-Object -Skip ($i + 2))
    break
  }
}
function Quote-Argument([string]$Value) {
  if ($Value -notmatch '[\s"]' -and $Value.Length -gt 0) { return $Value }
  return '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}
function Run-Program([string]$File, [string[]]$Arguments, [bool]$Wait) {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $File
  $start.UseShellExecute = $false
  # The process-scope policy that let this launcher run must not reach the app,
  # the host, or any shell a person later opens inside them.
  [void]$start.EnvironmentVariables.Remove('PSExecutionPolicyPreference')
  $start.Arguments = (($Arguments | ForEach-Object { Quote-Argument $_ }) -join ' ')
  $child = [System.Diagnostics.Process]::Start($start)
  if ($Wait) { $child.WaitForExit(); exit $child.ExitCode }
}
try {
  foreach ($value in $LaunchArgs) {
    if ($value -cmatch '(fo1|fc1|fb1|fs1|ft1|fx1)_' -or $value -match '[\x00\r\n]' -or $value.Length -gt 32768) { throw 'Invalid command-line value. Do not pass credentials.' }
  }
  $modes = @('init','serve','web','--web','provider','auth-code','access-key','doctor')
  if ($LaunchArgs.Count -gt 0 -and $modes -ccontains $LaunchArgs[0]) {
    # Get-Command returns EVERY application match on PATH (several Node installs,
    # or both npm and pnpm shims). Take the first, as the shell itself would; a
    # list would otherwise be joined into one nonexistent file name.
    $companion = Get-Command fate-server.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$companion -or !$node) { throw 'Install the separate fate-server Node package (Node 22.19+).' }
    # Ask the installed shim using a fixed, non-user-controlled query. Global
    # npm/pnpm shims are not adjacent to dist. Never feed user arguments back
    # through cmd.exe: the selected Node process receives them directly.
    $metadataText = & $companion.Source --launcher-entry
    if ($LASTEXITCODE -ne 0) { throw 'The installed Node companion needs the launcher-entry protocol. Update the separate package.' }
    $metadata = ($metadataText -join "`n") | ConvertFrom-Json
    if ($metadata.version -ne 1 -or $metadata.entry -isnot [string] -or ![IO.Path]::IsPathRooted($metadata.entry)) { throw 'The installed Node companion is incomplete.' }
    $entry = [IO.Path]::GetFullPath($metadata.entry)
    if (!(Test-Path -LiteralPath $entry -PathType Leaf) -or [IO.Path]::GetExtension($entry) -ne '.js') { throw 'The installed Node companion is incomplete.' }
    Run-Program $node.Source (@($entry) + $LaunchArgs) $true
    exit 0
  }
  $desktop = Join-Path $PSScriptRoot '../../fate-ui.exe'
  if ($LaunchArgs.Count -gt 0 -and $LaunchArgs[0] -ceq 'connect') {
    if ($LaunchArgs.Count -ne 2 -or $LaunchArgs[1] -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' -or $LaunchArgs[1] -cmatch '(fo1|fc1|fb1|fs1|ft1|fx1)_') { throw 'Use fate connect PROFILE.' }
    Run-Program $desktop @('--connection-profile=' + $LaunchArgs[1]) $false
    exit 0
  }
  $project = $null; $newInstance = $false; $literal = $false
  for ($i = 0; $i -lt $LaunchArgs.Count; $i++) {
    $value = $LaunchArgs[$i]
    if (!$literal) {
      if ($value -ceq '--') { $literal = $true; continue }
      if ($value -ceq '--new-instance') {
        if ($newInstance) { throw 'Duplicate --new-instance.' }; $newInstance = $true; continue
      }
      if ($value -ceq '--project') {
        $i++; if ($i -ge $LaunchArgs.Count) { throw 'Missing project path.' }; $value = $LaunchArgs[$i]
        if ($value.StartsWith('-')) { throw 'Missing project path.' }
      } elseif ($value.StartsWith('--project=')) { $value = $value.Substring(10); if ($value.StartsWith('-')) { throw 'Missing project path.' } }
      elseif ($value.StartsWith('-')) { throw 'Unknown option.' }
    }
    if (!$value -or $null -ne $project) { throw 'Use one project path.' }
    $project = $value
  }
  if ($null -eq $project) { $project = (Get-Location).Path }
  $desktopArgs = @('--project=' + [IO.Path]::GetFullPath($project))
  if ($newInstance) { $desktopArgs += '--new-instance' }
  Run-Program $desktop $desktopArgs $false
} catch { [Console]::Error.WriteLine('Fate launch failed. ' + $_.Exception.Message); exit 1 }
