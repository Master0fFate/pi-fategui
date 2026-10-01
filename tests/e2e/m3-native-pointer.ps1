param(
  [Parameter(Mandatory = $true)][long]$TargetHwnd,
  [Parameter(Mandatory = $true)][uint32]$ExpectedPid,
  [Parameter(Mandatory = $true)][double]$ClientX,
  [Parameter(Mandatory = $true)][double]$ClientY,
  [Parameter(Mandatory = $true)][double]$ActivationClientX,
  [Parameter(Mandatory = $true)][double]$ActivationClientY,
  [Parameter(Mandatory = $true)][double]$ViewportWidth,
  [Parameter(Mandatory = $true)][double]$ViewportHeight
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
[StructLayout(LayoutKind.Sequential)] public struct NativePoint { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)] public struct NativeRect { public int Left; public int Top; public int Right; public int Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct NativeMouseInput { public int X; public int Y; public uint Data; public uint Flags; public uint Time; public UIntPtr Extra; }
[StructLayout(LayoutKind.Sequential)] public struct NativeInput { public uint Type; public NativeMouseInput Mouse; }
[StructLayout(LayoutKind.Sequential)] public struct NativeGuiThreadInfo {
  public uint Size; public uint Flags;
  public IntPtr Active; public IntPtr Focus; public IntPtr Capture; public IntPtr MenuOwner; public IntPtr MoveSize; public IntPtr Caret;
  public NativeRect CaretRect;
}
public class NativePointer {
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder value, int length);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong32(IntPtr hwnd, int index);
  public static uint GetStyle(IntPtr hwnd, int index) { return unchecked((uint)(IntPtr.Size == 8 ? GetWindowLongPtr64(hwnd, index).ToInt64() : GetWindowLong32(hwnd, index))); }
  [DllImport("user32.dll")] public static extern bool GetLayeredWindowAttributes(IntPtr hwnd, out uint color, out byte alpha, out uint flags);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetWindowRect(IntPtr hwnd, out NativeRect rect);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetClientRect(IntPtr hwnd, out NativeRect rect);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool ClientToScreen(IntPtr hwnd, ref NativePoint point);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attribute, out uint value, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint length, out uint needed);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetCursorPos(out NativePoint point);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetClipCursor(out NativeRect rect);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, [In] NativeInput[] inputs, int size);
  public static uint MoveCursor(int x, int y) {
    int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
    int size = Marshal.SizeOf(typeof(NativeInput));
    if (size != (IntPtr.Size == 8 ? 40 : 28) || width <= 0 || height <= 0 || x < left || y < top || (long)x >= (long)left + width || (long)y >= (long)top + height)
      throw new InvalidOperationException("Invalid native INPUT layout or virtual-desktop point");
    // Target the centre of the physical pixel in the normalized 0..65535 grid.
    var move = new NativeInput();
    move.Mouse.X = (int)Math.Min(65535, Math.Floor(((double)x - left + 0.5) * 65536 / width));
    move.Mouse.Y = (int)Math.Min(65535, Math.Floor(((double)y - top + 0.5) * 65536 / height));
    move.Mouse.Flags = 0x0001 | 0x8000 | 0x4000; // MOVE | ABSOLUTE | VIRTUALDESK
    return SendInput(1, new NativeInput[] { move }, size);
  }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(NativePoint point);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetGUIThreadInfo(uint thread, ref NativeGuiThreadInfo info);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool ProcessIdToSessionId(uint pid, out uint session);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
# All native geometry/hit tests must use physical pixels, including mixed-DPI
# displays. System-DPI awareness alone can virtualize another window's rects.
$previousDpi = [NativePointer]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) # PER_MONITOR_AWARE_V2
if ($previousDpi -eq [IntPtr]::Zero -or [NativePointer]::GetAwarenessFromDpiAwarenessContext([NativePointer]::GetThreadDpiAwarenessContext()) -ne 2) {
  throw 'Could not establish per-monitor physical coordinate context'
}
$target = [IntPtr]::new($TargetHwnd)
function Assert-OwnedTarget {
  $targetPid = [uint32]0
  [void][NativePointer]::GetWindowThreadProcessId($target, [ref]$targetPid)
  if ($ExpectedPid -eq 0 -or -not [NativePointer]::IsWindow($target) -or $targetPid -ne $ExpectedPid -or [NativePointer]::GetAncestor($target, 2) -ne $target) {
    throw "Refusing activation of an unowned top-level HWND: hwnd=$TargetHwnd owner=$targetPid expected=$ExpectedPid"
  }
}
function Get-DesktopName([IntPtr]$handle) {
  $name = New-Object System.Text.StringBuilder 256
  $needed = [uint32]0
  if ($handle -eq [IntPtr]::Zero -or -not [NativePointer]::GetUserObjectInformation($handle, 2, $name, 512, [ref]$needed)) {
    throw "Cannot identify desktop: handle=$handle win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  return $name.ToString()
}
function Get-ProcessIdentity([uint32]$processId) {
  $process = $null
  try {
    if ($processId -eq 0) { throw 'No process identity' }
    $process = [Diagnostics.Process]::GetProcessById([int]$processId)
    # Only executable basename/creation time; never title, command line, user
    # profile, process memory or an unrelated window's content.
    return @{ status = 'read'; name = $process.ProcessName; startedAt = $process.StartTime.ToUniversalTime().ToString('o') }
  } catch { return @{ status = 'unavailable'; errorType = $_.Exception.GetType().FullName } }
  finally { if ($null -ne $process) { $process.Dispose() } }
}
function Write-NativeReceipt([string]$stage) {
  Assert-OwnedTarget
  $foreground = [NativePointer]::GetForegroundWindow()
  $foregroundPid = [uint32]0
  $foregroundThread = [NativePointer]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
  $foregroundClass = New-Object System.Text.StringBuilder 256
  [void][NativePointer]::GetClassName($foreground, $foregroundClass, 256)
  $identity = Get-ProcessIdentity $foregroundPid
  $helperSession = [uint32]0; $targetSession = [uint32]0; $foregroundSession = [uint32]0
  $helperSessionRead = [NativePointer]::ProcessIdToSessionId([uint32]$PID, [ref]$helperSession)
  $targetSessionRead = [NativePointer]::ProcessIdToSessionId($ExpectedPid, [ref]$targetSession)
  $foregroundSessionRead = [NativePointer]::ProcessIdToSessionId($foregroundPid, [ref]$foregroundSession)
  $gui = New-Object NativeGuiThreadInfo
  $gui.Size = [Runtime.InteropServices.Marshal]::SizeOf([type][NativeGuiThreadInfo])
  $guiRead = [NativePointer]::GetGUIThreadInfo($targetThread, [ref]$gui)
  $guiError = if ($guiRead) { 0 } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
  $afterPid = [uint32]0
  $after = [NativePointer]::GetForegroundWindow()
  [void][NativePointer]::GetWindowThreadProcessId($after, [ref]$afterPid)
  $stable = $foreground -eq $after -and $foregroundPid -eq $afterPid
  Write-Host ('[T20 native receipt] ' + ([ordered]@{
    utc = [DateTime]::UtcNow.ToString('o'); stage = $stage; helperPid = $PID; helperThread = [NativePointer]::GetCurrentThreadId(); inputSize = [Runtime.InteropServices.Marshal]::SizeOf([type][NativeInput]);
    targetHwnd = $target.ToInt64(); expectedPid = $ExpectedPid; targetThread = $targetThread;
    foregroundHwnd = $foreground.ToInt64(); foregroundPid = $foregroundPid; foregroundThread = $foregroundThread; foregroundClass = $foregroundClass.ToString(); foregroundIdentity = $identity;
    helperSessionRead = $helperSessionRead; helperSession = $helperSession; targetSessionRead = $targetSessionRead; targetSession = $targetSession; foregroundSessionRead = $foregroundSessionRead; foregroundSession = $foregroundSession;
    stable = $stable; foregroundAfter = $after.ToInt64(); foregroundPidAfter = $afterPid;
    targetGuiRead = $guiRead; targetGuiError = $guiError; targetActive = $gui.Active.ToInt64(); targetFocus = $gui.Focus.ToInt64(); targetCapture = $gui.Capture.ToInt64(); targetMenuOwner = $gui.MenuOwner.ToInt64(); targetGuiFlags = $gui.Flags;
  } | ConvertTo-Json -Compress -Depth 5))
  return @{ foreground = $foreground; foregroundPid = $foregroundPid; stable = $stable; gui = $gui; guiRead = $guiRead; sessionsOwned = $helperSessionRead -and $targetSessionRead -and $helperSession -eq $targetSession -and $helperSession -ne 0 }
}
function Assert-OwnedForeground([string]$stage) {
  $receipt = Write-NativeReceipt $stage
  if (-not $receipt.stable -or $receipt.foreground -ne $target -or $receipt.foregroundPid -ne $ExpectedPid -or -not $receipt.sessionsOwned) {
    throw "OWNED_FOREGROUND_UNAVAILABLE: stage=$stage hwnd=$($receipt.foreground) pid=$($receipt.foregroundPid) target=$target expected=$ExpectedPid; interactive owned-window handoff required, no pointer injection"
  }
  if (-not $receipt.guiRead -or $receipt.gui.Active -ne $target -or $receipt.gui.Capture -ne [IntPtr]::Zero -or ($receipt.gui.Flags -band 0x1E) -ne 0) {
    throw "OWNED_INPUT_QUEUE_UNAVAILABLE: stage=$stage active=$($receipt.gui.Active) capture=$($receipt.gui.Capture) flags=$($receipt.gui.Flags); refusing input during capture/menu/move-size or unreadable queue"
  }
}
function Get-Geometry([switch]$DiagnosticOnly) {
  Assert-OwnedTarget
  $window = New-Object NativeRect
  $client = New-Object NativeRect
  $origin = New-Object NativePoint
  if (-not [NativePointer]::GetWindowRect($target, [ref]$window) -or -not [NativePointer]::GetClientRect($target, [ref]$client) -or -not [NativePointer]::ClientToScreen($target, [ref]$origin)) {
    throw "Cannot read owned HWND geometry: win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  $cloaked = [uint32]0
  $cloakResult = [NativePointer]::DwmGetWindowAttribute($target, 14, [ref]$cloaked, 4) # DWMWA_CLOAKED
  $dpi = [NativePointer]::GetDpiForWindow($target)
  $className = New-Object System.Text.StringBuilder 256
  [void][NativePointer]::GetClassName($target, $className, 256)
  $style = [NativePointer]::GetStyle($target, -16)
  $extendedStyle = [NativePointer]::GetStyle($target, -20)
  $layerColor = [uint32]0; $layerAlpha = [byte]0; $layerFlags = [uint32]0
  $layered = [NativePointer]::GetLayeredWindowAttributes($target, [ref]$layerColor, [ref]$layerAlpha, [ref]$layerFlags)
  Write-Host "[T20 native window facts] class=$className enabled=$([NativePointer]::IsWindowEnabled($target)) style=$($style.ToString('X8')) extendedStyle=$($extendedStyle.ToString('X8')) layeredAttributes=$layered alpha=$layerAlpha layerFlags=$layerFlags"
  $geometry = @{ window = $window; client = $client; origin = $origin; width = $client.Right - $client.Left; height = $client.Bottom - $client.Top }
  Write-Host "[T20 native geometry] hwnd=$target pid=$ExpectedPid window=$($window.Left),$($window.Top),$($window.Right),$($window.Bottom) client=$($client.Left),$($client.Top),$($client.Right),$($client.Bottom) clientScreenOrigin=$($origin.X),$($origin.Y) dpi=$dpi awareness=$([NativePointer]::GetAwarenessFromDpiAwarenessContext([NativePointer]::GetThreadDpiAwarenessContext())) cloakHresult=$cloakResult cloaked=$cloaked visible=$([NativePointer]::IsWindowVisible($target)) iconic=$([NativePointer]::IsIconic($target)) viewport=$ViewportWidth,$ViewportHeight"
  if ($DiagnosticOnly) { return $geometry }
  if ($cloakResult -ne 0 -or $cloaked -ne 0 -or $dpi -eq 0 -or -not [NativePointer]::IsWindowVisible($target) -or -not [NativePointer]::IsWindowEnabled($target) -or [NativePointer]::IsIconic($target) -or $client.Left -ne 0 -or $client.Top -ne 0 -or $geometry.width -le 0 -or $geometry.height -le 0) {
    throw 'Owned HWND is not an enabled uncloaked visible nonempty physical client'
  }
  return $geometry
}
function Get-ScreenPoint($geometry, [double]$x, [double]$y) {
  foreach ($value in @($x, $y, $ViewportWidth, $ViewportHeight)) {
    if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) { throw 'Nonfinite DOM coordinate or viewport' }
  }
  if ($ViewportWidth -le 0 -or $ViewportHeight -le 0 -or $x -lt 0 -or $y -lt 0 -or $x -ge $ViewportWidth -or $y -ge $ViewportHeight) { throw 'DOM point is outside its viewport' }
  $point = New-Object NativePoint
  $point.X = [int][Math]::Round($x * $geometry.width / $ViewportWidth)
  $point.Y = [int][Math]::Round($y * $geometry.height / $ViewportHeight)
  if ($point.X -lt 0 -or $point.Y -lt 0 -or $point.X -ge $geometry.width -or $point.Y -ge $geometry.height) { throw 'Rounded point is outside actual client bounds' }
  if (-not [NativePointer]::ClientToScreen($target, [ref]$point)) { throw 'Cannot map client point to screen' }
  if ($point.X -lt $geometry.origin.X -or $point.Y -lt $geometry.origin.Y -or $point.X -ge $geometry.origin.X + $geometry.width -or $point.Y -ge $geometry.origin.Y + $geometry.height) { throw 'Screen point is outside actual client' }
  return $point
}
function Assert-PointOwned($point, [string]$purpose) {
  Assert-OwnedTarget
  $pointPid = [uint32]0
  $hit = [NativePointer]::WindowFromPoint($point)
  [void][NativePointer]::GetWindowThreadProcessId($hit, [ref]$pointPid)
  $root = [NativePointer]::GetAncestor($hit, 2)
  $hitClass = New-Object System.Text.StringBuilder 256
  [void][NativePointer]::GetClassName($hit, $hitClass, 256)
  Write-Host "[T20 native hit class] class=$hitClass"
  Write-Host "[T20 native hit] purpose=$purpose point=$($point.X),$($point.Y) hwnd=$hit root=$root pid=$pointPid target=$target expected=$ExpectedPid foreground=$([NativePointer]::GetForegroundWindow())"
  if ($pointPid -ne $ExpectedPid -or $root -ne $target) { throw "Refusing $purpose on another window: owner=$pointPid expected=$ExpectedPid hwnd=$hit root=$root target=$target point=$($point.X),$($point.Y)" }
}
function Assert-GeometryUnchanged($before) {
  $current = Get-Geometry
  if ($current.width -ne $before.width -or $current.height -ne $before.height -or $current.origin.X -ne $before.origin.X -or $current.origin.Y -ne $before.origin.Y) { throw 'Owned HWND client geometry changed after DOM sampling; refusing stale target' }
}
function Move-NativePointer($expected, $geometry, [string]$purpose) {
  Assert-OwnedForeground "before-$purpose-move"
  Assert-GeometryUnchanged $geometry
  Assert-PointOwned $expected $purpose
  $clip = New-Object NativeRect
  if (-not [NativePointer]::GetClipCursor([ref]$clip) -or $expected.X -lt $clip.Left -or $expected.Y -lt $clip.Top -or $expected.X -ge $clip.Right -or $expected.Y -ge $clip.Bottom) {
    throw "Native target is outside the readable cursor clip: point=$($expected.X),$($expected.Y) clip=$($clip.Left),$($clip.Top),$($clip.Right),$($clip.Bottom)"
  }
  # Send exactly one real OS MOVE, not a DOM/CDP event or a movement retry.
  # SendInput reports insertion, not delivery: observe delivery within 80 ms.
  $sent = [NativePointer]::MoveCursor($expected.X, $expected.Y)
  $moveError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($sent -ne 1) { throw "Native MOVE insertion refused: sent=$sent win32=$moveError" }
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $cursor = New-Object NativePoint
  do {
    $read = [NativePointer]::GetCursorPos([ref]$cursor)
    $readError = if ($read) { 0 } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
    if ($read -and $cursor.X -eq $expected.X -and $cursor.Y -eq $expected.Y) {
      Assert-GeometryUnchanged $geometry
      Assert-PointOwned $cursor $purpose
      Write-Host "[T20 native MOVE delivered] purpose=$purpose sent=$sent cursor=$($cursor.X),$($cursor.Y) expected=$($expected.X),$($expected.Y) elapsedMs=$($clock.ElapsedMilliseconds) clip=$($clip.Left),$($clip.Top),$($clip.Right),$($clip.Bottom)"
      return @{ sent = $sent; read = $read; cursor = $cursor }
    }
    if ($clock.ElapsedMilliseconds -lt 80) { Start-Sleep -Milliseconds 4 }
  } while ($clock.ElapsedMilliseconds -lt 80)
  throw "Native MOVE not delivered: purpose=$purpose sent=$sent read=$read win32=$readError cursor=$($cursor.X),$($cursor.Y) expected=$($expected.X),$($expected.Y) clip=$($clip.Left),$($clip.Top),$($clip.Right),$($clip.Bottom)"
}
try {
  Assert-OwnedTarget
  $targetPid = [uint32]0
  $targetThread = [NativePointer]::GetWindowThreadProcessId($target, [ref]$targetPid)
  # Preserve exact pre-activation geometry even if desktop diagnostics refuse
  # input. Hidden/iconic state here is diagnostic; restore/show still follows.
  [void](Get-Geometry -DiagnosticOnly)
  $inputDesktop = [NativePointer]::OpenInputDesktop(0, $false, 1) # DESKTOP_READOBJECTS only
  try {
    $targetDesktopName = Get-DesktopName ([NativePointer]::GetThreadDesktop($targetThread))
    $pointerDesktopName = Get-DesktopName ([NativePointer]::GetThreadDesktop([NativePointer]::GetCurrentThreadId()))
    $inputDesktopName = Get-DesktopName $inputDesktop
    Write-Host "[T20 native desktops] target=$targetDesktopName pointer=$pointerDesktopName input=$inputDesktopName"
    if ($targetDesktopName -ne $inputDesktopName -or $pointerDesktopName -ne $inputDesktopName) { throw 'Owned HWND and pointer are not on the input desktop' }
  } finally {
    if ($inputDesktop -ne [IntPtr]::Zero) { [void][NativePointer]::CloseDesktop($inputDesktop) }
  }
  # Retain restore/show/raise of only the validated HWND. The caller finally
  # removes topmost. Geometry is read AFTER this, not from Electron's cache.
  $showCommand = if ([NativePointer]::IsIconic($target)) { 9 } else { 5 }
  [void][NativePointer]::ShowWindow($target, $showCommand)
  $raised = [NativePointer]::SetWindowPos($target, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0053)
  if (-not $raised) { throw "Could not raise owned Electron HWND: win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  [void](Write-NativeReceipt 'before-owned-activation')
  # Request activation only for the validated target. Attaching an unrelated
  # foreground input queue is not permission to bypass Windows focus policy.
  $activated = [NativePointer]::SetForegroundWindow($target)
  Start-Sleep -Milliseconds 80
  [void](Write-NativeReceipt 'after-owned-activation')
  $geometry = Get-Geometry
  $point = Get-ScreenPoint $geometry $ClientX $ClientY
  $activationPoint = Get-ScreenPoint $geometry $ActivationClientX $ActivationClientY
  Write-Host "[T20 native mapping] closeDom=$ClientX,$ClientY closeScreen=$($point.X),$($point.Y) activationDom=$ActivationClientX,$ActivationClientY activationScreen=$($activationPoint.X),$($activationPoint.Y) scale=$($geometry.width / $ViewportWidth),$($geometry.height / $ViewportHeight)"
  $ownerPid = [uint32]0
  $foreground = [NativePointer]::GetForegroundWindow()
  [void][NativePointer]::GetWindowThreadProcessId($foreground, [ref]$ownerPid)
  # Do not inject activation input while a different process owns foreground.
  # A topmost WindowFromPoint hit says nothing about capture/activation delivery.
  Assert-PointOwned $activationPoint 'activation preflight'
  Assert-OwnedForeground 'before-native-close'
  Assert-GeometryUnchanged $geometry
  Assert-PointOwned $point 'native close'
  $movement = Move-NativePointer $point $geometry 'native close'
  $moved = $movement.sent -eq 1
  $cursor = $movement.cursor
  $readCursor = $movement.read
  Assert-GeometryUnchanged $geometry
  Assert-PointOwned $cursor 'native close'
  $ownerPid = [uint32]0
  $foreground = [NativePointer]::GetForegroundWindow()
  [void][NativePointer]::GetWindowThreadProcessId($foreground, [ref]$ownerPid)
  $evidence = "activated=$activated raised=$raised activationInjection=False moved=$moved cursor=$($cursor.X),$($cursor.Y) foregroundHwnd=$foreground targetHwnd=$target targetPid=$targetPid foregroundPid=$ownerPid expectedPid=$ExpectedPid"
  if (-not $moved -or -not $readCursor -or $cursor.X -ne $point.X -or $cursor.Y -ne $point.Y -or $ownerPid -ne $ExpectedPid -or $foreground -ne $target) { throw "Refusing native click without owned foreground/cursor: $evidence" }
  Assert-OwnedForeground 'before-close-mousedown'
  # Receipts above can take time: re-read actual cursor/hit/geometry after them.
  if (-not [NativePointer]::GetCursorPos([ref]$cursor) -or $cursor.X -ne $point.X -or $cursor.Y -ne $point.Y) { throw 'Cursor changed before native close mouse-down' }
  Assert-GeometryUnchanged $geometry
  Assert-PointOwned $cursor 'native close final'
  $foreground = [NativePointer]::GetForegroundWindow()
  $ownerPid = [uint32]0
  [void][NativePointer]::GetWindowThreadProcessId($foreground, [ref]$ownerPid)
  if ($foreground -ne $target -or $ownerPid -ne $ExpectedPid) { throw 'Foreground changed before native close mouse-down' }
  # The legacy API has no insertion result. Success still requires the caller's
  # real trusted renderer click AND hidden dialog; this is only a send attempt.
  [NativePointer]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [NativePointer]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Write-Output $evidence
} catch {
  try { [void](Write-NativeReceipt 'refused') }
  catch { Write-Host "[T20 native receipt unavailable] $($_.Exception.GetType().FullName)" }
  throw
} finally {
  [void][NativePointer]::SetThreadDpiAwarenessContext($previousDpi)
}
