param([Parameter(ValueFromRemainingArguments=$true)][string[]]$LaunchArgs)
$ErrorActionPreference = 'Stop'
function Quote-Argument([string]$Value) {
  if ($Value -notmatch '[\s"]' -and $Value.Length -gt 0) { return $Value }
  return '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}
function Run-Program([string]$File, [string[]]$Arguments, [bool]$Wait) {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $File
  $start.UseShellExecute = $false
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
    $companion = Get-Command fate-server.cmd -CommandType Application -ErrorAction SilentlyContinue
    $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if (!$companion -or !$node) { throw 'Install the separate fate-server Node package (Node 22.19+).' }
    $entry = Join-Path (Split-Path $companion.Source) '../dist/cli/main.js'
    if (!(Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'The installed Node companion is incomplete.' }
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
