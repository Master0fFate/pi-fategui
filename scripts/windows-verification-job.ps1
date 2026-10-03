param([Parameter(Mandatory=$true)][string]$PipeName, [Parameter(Mandatory=$true)][string]$Nonce)

# No profiles, elevation, execution-policy overrides, downloads, or application imports.
# If local policy prevents compilation/execution, the caller retains its fixture.
$ErrorActionPreference = 'Stop'
$pipe = $null
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-verification-job.cs')
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName,
        [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
    $pipe.Connect(30000)
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $reader = [System.IO.StreamReader]::new($pipe, $utf8, $false, 4096, $true)
    $writer = [System.IO.StreamWriter]::new($pipe, $utf8, 4096, $true)
    $writer.AutoFlush = $true
    $writer.WriteLine($Nonce)
    $request = [Fate.VerificationJob]::ReadBoundedLine($reader, 1048576) | ConvertFrom-Json
    if ($null -eq $request -or $request.version -ne 1) { throw 'Invalid verification launch request.' }
    [string[]]$keys = @($request.env.PSObject.Properties | ForEach-Object { $_.Name })
    [string[]]$values = @($request.env.PSObject.Properties | ForEach-Object { [string]$_.Value })
    [Fate.VerificationJob]::Run($reader, $writer, [string]$request.executable,
        [string[]]@($request.args), [string]$request.cwd, $keys, $values,
        [int]$request.descendantGraceMs, [int]$request.settlementTimeoutMs)
} catch {
    [Console]::Error.WriteLine('Windows verification supervisor failed: ' + $_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $pipe) { $pipe.Dispose() }
}
