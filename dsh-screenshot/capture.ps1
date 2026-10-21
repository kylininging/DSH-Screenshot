#requires -Version 5.1
<#
    DSH screenshot helper.

    Two entry points over the same capture code:

      -Worker           Resident mode used by the composer button. Preloads GDI,
                        WinForms and the interop type once, prints a ready line,
                        then serves one JSON request per stdin line. This is what
                        makes a click feel instant: no process start per capture.
      -Request <b64>    One-shot mode: decode, capture, print, exit. Used as a
                        fallback and by anything that cannot keep a worker.

    Request JSON:
      {"out":"C:\\path\\shot.png","mode":"region"|"full","titles":["..."],"settleMs":260}

    Result (one line per request):
      {"ok":true,"path":..,"width":W,"height":H,"hidden":N,"mode":"region","ms":M}
      {"ok":true,"cancelled":true,...}
      {"ok":false,"error":"..."}
#>
param(
    [switch]$Worker,
    [string]$Request = '',
    [string]$Out = '',
    [string]$Mode = 'full',
    [string]$Restore = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Write-Result([hashtable]$payload) {
    $json = $payload | ConvertTo-Json -Compress -Depth 4
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

<#
    Is this window owned by the app the caller wants hidden?
    With no owner identity every title match counts (legacy behaviour). With one,
    the window must be the host process itself or a process sharing its executable
    name (Electron windows live in same-named child processes). A Chrome tab whose
    title merely mentions the app is NOT the app.
#>
$script:ownerPid = 0
$script:ownerName = ''

function Test-WindowOwner([int64]$winPid) {
    if ($script:ownerPid -le 0 -and $script:ownerName -eq '') { return $true }
    if ($winPid -eq $script:ownerPid) { return $true }
    if ($script:ownerName -ne '') {
        try {
            $name = ([System.Diagnostics.Process]::GetProcessById([int]$winPid)).ProcessName
            return $name -and $name.Equals($script:ownerName, [System.StringComparison]::OrdinalIgnoreCase)
        } catch {
            return $false
        }
    }
    return $false
}

function Restore-Hidden($windows, $zoomed, $saved) {
    if ($windows.Count -eq 0) { return }
    foreach ($h in $windows) {
        try {
            $rect = $saved[$h]
            if ($null -ne $rect) {
                # Parked off-screen: put it back exactly where it was.
                [void][Shot.Win]::SetWindowPos(
                    $h, [IntPtr]::Zero, $rect.L, $rect.T, ($rect.R - $rect.L), ($rect.B - $rect.T), 0x0054)
            } else {
                [void][Shot.Win]::ShowWindow($h, 9)   # SW_RESTORE
                if ($zoomed[$h]) { [void][Shot.Win]::ShowWindow($h, 3) }   # was maximized
            }
        } catch { }
    }
    try { [void][Shot.Win]::SetForegroundWindow($windows[0]) } catch { }
    $windows.Clear()
}

<#
    Freeze the shot behind a full-screen rubber-band picker.
    Returns a System.Drawing.Rectangle in bitmap pixels, or nothing when cancelled.
#>
function Select-Region([System.Drawing.Bitmap]$shot) {
    $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $form = New-Object System.Windows.Forms.Form
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    # Size the picker from the frozen bitmap, never from a second screen query: on a
    # scaled display a DPI-virtualized process reports a smaller virtual screen than
    # the pixels it captured, and mouse coordinates must map 1:1 onto bitmap pixels.
    $form.Bounds = [System.Drawing.Rectangle]::new($virtual.X, $virtual.Y, $shot.Width, $shot.Height)
    $form.TopMost = $true
    $form.ShowInTaskbar = $false
    $form.KeyPreview = $true
    $form.Cursor = [System.Windows.Forms.Cursors]::Cross
    $form.BackColor = [System.Drawing.Color]::Black

    # DoubleBuffered is protected on Control; enable it through reflection so the
    # rubber band repaints without flicker.
    try {
        $setStyle = [System.Windows.Forms.Control].GetMethod(
            'SetStyle',
            [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic)
        $styles = [System.Windows.Forms.ControlStyles]::UserPaint -bor
            [System.Windows.Forms.ControlStyles]::AllPaintingInWmPaint -bor
            [System.Windows.Forms.ControlStyles]::OptimizedDoubleBuffer
        $setStyle.Invoke($form, @($styles, $true))
    } catch { }

    $state = @{
        start     = $null
        current   = $null
        cancelled = $false
    }
    $font = New-Object System.Drawing.Font('Segoe UI', 9)
    $hintFont = New-Object System.Drawing.Font('Segoe UI', 12)
    $hintText = [string]::Concat([char]0x62D6, [char]0x52A8, [char]0x9F20, [char]0x6807, [char]0x6846, [char]0x9009, '  ', [char]0x00B7, '  Esc ', [char]0x53D6, [char]0x6D88)

    $form.add_Paint({
            param($sender, $eventArgs)
            $g = $eventArgs.Graphics
            $g.DrawImage($shot, 0, 0)
            $area = $form.ClientRectangle

            if ($null -eq $state.start -or $null -eq $state.current) {
                # Nothing selected yet: dim everything and explain the gesture once.
                $veil = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 0, 0, 0))
                $g.FillRectangle($veil, $area)
                $veil.Dispose()
                $size = $g.MeasureString($hintText, $hintFont)
                $x = [int](($area.Width - $size.Width) / 2)
                $y = [int]($area.Height * 0.08)
                $shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(180, 0, 0, 0))
                $g.FillRectangle($shadow, $x - 14, $y - 10, $size.Width + 28, $size.Height + 20)
                $shadow.Dispose()
                $g.DrawString($hintText, $hintFont, [System.Drawing.Brushes]::White, $x, $y)
                return
            }

            $left = [Math]::Min($state.start.X, $state.current.X)
            $top = [Math]::Min($state.start.Y, $state.current.Y)
            $width = [Math]::Abs($state.current.X - $state.start.X)
            $height = [Math]::Abs($state.current.Y - $state.start.Y)
            if ($width -lt 1 -or $height -lt 1) { return }

            $selection = [System.Drawing.Rectangle]::new($left, $top, $width, $height)

            # Dim the four bands around the selection, leaving the selection untouched.
            $veil = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 0, 0, 0))
            if ($top -gt 0) { $g.FillRectangle($veil, 0, 0, $area.Width, $top) }
            if ($top + $height -lt $area.Height) { $g.FillRectangle($veil, 0, $top + $height, $area.Width, $area.Height - ($top + $height)) }
            if ($left -gt 0) { $g.FillRectangle($veil, 0, $top, $left, $height) }
            if ($left + $width -lt $area.Width) { $g.FillRectangle($veil, $left + $width, $top, $area.Width - ($left + $width), $height) }
            $veil.Dispose()

            $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 76, 160, 255)), 1
            $g.DrawRectangle($pen, $selection)
            $pen.Dispose()

            # Corner handles, like a native crop tool.
            $handle = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 76, 160, 255))
            foreach ($corner in @(
                    @($selection.Left, $selection.Top),
                    @($selection.Right, $selection.Top),
                    @($selection.Left, $selection.Bottom),
                    @($selection.Right, $selection.Bottom))) {
                $g.FillRectangle($handle, [int]$corner[0] - 2, [int]$corner[1] - 2, 4, 4)
            }
            $handle.Dispose()

            # Size badge near the selection, kept inside the picker.
            $label = "$width x $height"
            $labelSize = $g.MeasureString($label, $font)
            $badgeX = [Math]::Max(0, [Math]::Min($left, $area.Width - $labelSize.Width - 12))
            $badgeY = $top - $labelSize.Height - 8
            if ($badgeY -lt 0) { $badgeY = $top + 4 }
            $bubble = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(210, 0, 0, 0))
            $g.FillRectangle($bubble, $badgeX, $badgeY, $labelSize.Width + 10, $labelSize.Height + 4)
            $bubble.Dispose()
            $g.DrawString($label, $font, [System.Drawing.Brushes]::White, $badgeX + 5, $badgeY + 2)
        })

    $form.add_MouseDown({
            param($sender, $eventArgs)
            if ($eventArgs.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
            $state.start = $eventArgs.Location
            $state.current = $eventArgs.Location
            $form.Invalidate()
        })

    $form.add_MouseMove({
            param($sender, $eventArgs)
            if ($null -eq $state.start) { return }
            $state.current = $eventArgs.Location
            $form.Invalidate()
        })

    $form.add_MouseUp({
            param($sender, $eventArgs)
            if ($eventArgs.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
            if ($null -eq $state.start) { return }
            $state.current = $eventArgs.Location
            $form.Invalidate()
            $form.Close()
        })

    $form.add_KeyDown({
            param($sender, $eventArgs)
            if ($eventArgs.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
                $state.cancelled = $true
                $form.Close()
            }
        })

    $form.add_Shown({
            param($sender, $eventArgs)
            # Both return bools; without [void] they would leak into the pipeline.
            [void]$form.Activate()
            [void]$form.Focus()
        })

    [void]$form.ShowDialog()
    $form.Dispose()
    $font.Dispose()
    $hintFont.Dispose()

    if ($state.cancelled -or $null -eq $state.start -or $null -eq $state.current) { return }

    $left = [Math]::Min($state.start.X, $state.current.X)
    $top = [Math]::Min($state.start.Y, $state.current.Y)
    $width = [Math]::Abs($state.current.X - $state.start.X)
    $height = [Math]::Abs($state.current.Y - $state.start.Y)
    if ($width -lt 4 -or $height -lt 4) { return }

    # Clamp to the frozen bitmap: a drag may end at the client edge.
    $left = [Math]::Max(0, [Math]::Min($left, $shot.Width - 1))
    $top = [Math]::Max(0, [Math]::Min($top, $shot.Height - 1))
    $width = [Math]::Min($width, $shot.Width - $left)
    $height = [Math]::Min($height, $shot.Height - $top)
    Write-Output ([System.Drawing.Rectangle]::new($left, $top, $width, $height))
}

<# Capture one request and return its result as a hashtable. #>
function Invoke-Capture($spec) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $hidden = New-Object System.Collections.Generic.List[IntPtr]
    $zoomed = @{}
    $saved = @{}

    $target = [string]$spec.out
    $shotMode = 'full'
    if ($spec.mode) { $shotMode = [string]$spec.mode }
    $settleMs = 50
    if ($null -ne $spec.settleMs) { $settleMs = [int]$spec.settleMs }
    $titles = @()
    if ($spec.titles) { $titles = @($spec.titles | Where-Object { $_ -is [string] -and $_.Length -gt 0 }) }
    # When the caller passes its own PID, a title match must ALSO belong to that
    # process (or one of its children). Without this, a browser tab titled
    # "… — DeepSeek Harness" gets parked too: title matching alone cannot tell
    # the app apart from a window that merely mentions it.
    $script:ownerPid = 0
    $script:ownerName = ''
    if ($null -ne $spec.ownerPid) {
        $script:ownerPid = [int64]$spec.ownerPid
        try { $script:ownerName = ([System.Diagnostics.Process]::GetProcessById([int]$script:ownerPid)).ProcessName } catch { }
    }

    try {
        if ($target -eq '') { throw 'no output path was requested' }

        if ($titles.Count -gt 0) {
            $needles = $titles
            $collector = $hidden
            $callback = [Shot.Win+EnumProc]{
                param($handle, $param)
                if (-not [Shot.Win]::IsWindowVisible($handle)) { return $true }
                # Already minimized: it covers nothing, and "restoring" it later would
                # pull a window the user had put away back onto the screen.
                if ([Shot.Win]::IsIconic($handle)) { return $true }
                $buffer = New-Object System.Text.StringBuilder 1024
                [void][Shot.Win]::GetWindowTextW($handle, $buffer, 1024)
                $title = $buffer.ToString()
                if ($title.Length -eq 0) { return $true }
                $matched = $false
                foreach ($needle in $needles) {
                    if ($title.Contains($needle)) { $matched = $true; break }
                }
                if ($matched) {
                    # A title match alone is not enough: a browser tab reading
                    # "… — DeepSeek Harness" belongs to Chrome, not to the app.
                    $winPid = 0
                    [void][Shot.Win]::GetWindowThreadProcessId($handle, [ref]$winPid)
                    if (Test-WindowOwner ([int64]$winPid)) { $collector.Add($handle) }
                }
                return $true
            }
            [void][Shot.Win]::EnumWindows($callback, [IntPtr]::Zero)

            # Park each window outside the desktop. A move is applied on the next
            # composited frame with no transition, while minimize and hide both run a
            # ~250ms animation that leaves a shrunken or faded copy in the grab. A
            # maximized window is pinned by the window manager and cannot be parked,
            # so it falls back to minimize and the caller waits out that animation.
            $needsAnimationWait = $false
            foreach ($handle in $hidden) {
                $zoomed[$handle] = [Shot.Win]::IsZoomed($handle)
                if ($zoomed[$handle]) {
                    $needsAnimationWait = $true
                    [void][Shot.Win]::ShowWindow($handle, 6)   # SW_MINIMIZE
                    continue
                }
                $rect = New-Object Shot.Win+RECT
                if (-not [Shot.Win]::GetWindowRect($handle, [ref]$rect)) { continue }
                $saved[$handle] = $rect
                # SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
                [void][Shot.Win]::SetWindowPos($handle, [IntPtr]::Zero, -32000, -32000, 0, 0, 0x0015)
            }
            if ($hidden.Count -gt 0) {
                if ($needsAnimationWait) { Start-Sleep -Milliseconds ([Math]::Max($settleMs, 260)) }
                else { Start-Sleep -Milliseconds $settleMs }
            }
        }

        $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        } finally {
            $graphics.Dispose()
        }

        $image = $bitmap
        $cancelled = $false
        if ($shotMode -eq 'region') {
            # Keep only the rectangle: a leaked event-handler value would otherwise
            # turn the pipeline result into an array.
            $picked = @(Select-Region $bitmap) | Where-Object { $_ -is [System.Drawing.Rectangle] } | Select-Object -First 1
            if ($null -eq $picked) {
                $cancelled = $true
            } else {
                $image = $bitmap.Clone($picked, $bitmap.PixelFormat)
            }
        }

        $dir = Split-Path -Parent $target
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $width = 0
        $height = 0
        if (-not $cancelled) {
            $image.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
            $width = $image.Width
            $height = $image.Height
        }
        if (-not [object]::ReferenceEquals($image, $bitmap)) { $image.Dispose() }
        $bitmap.Dispose()

        $hiddenCount = $hidden.Count
        if ($hiddenCount -gt 0) {
            Start-Sleep -Milliseconds 30
            Restore-Hidden $hidden $zoomed $saved
        }

        $sw.Stop()
        if ($cancelled) {
            return @{ ok = $true; cancelled = $true; mode = $shotMode; hidden = $hiddenCount; screen = "$($bounds.Width)x$($bounds.Height)"; ms = [int]$sw.ElapsedMilliseconds }
        }
        return @{ ok = $true; path = $target; width = $width; height = $height; hidden = $hiddenCount; mode = $shotMode; screen = "$($bounds.Width)x$($bounds.Height)"; ms = [int]$sw.ElapsedMilliseconds }
    } catch {
        $sw.Stop()
        
        try { Restore-Hidden $hidden $zoomed $saved } catch { }
        return @{ ok = $false; error = "$($_.Exception.Message)"; ms = [int]$sw.ElapsedMilliseconds }
    }
}

# --- preload: paid once, when the worker starts -------------------------------
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
if (-not ('Shot.Win' -as [type])) {
    Add-Type -Namespace Shot -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, System.IntPtr lParam);
public delegate bool EnumProc(System.IntPtr hWnd, System.IntPtr lParam);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsZoomed(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int cmd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint processId);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
'@
}
try { [void][Shot.Win]::SetProcessDPIAware() } catch { }

# --- safety valve: put back a window a crashed/timed-out capture left hidden ---
if ($Restore -ne '') {
    $shown = 0
    try {
        $json = $Restore
        if (-not $json.TrimStart().StartsWith('{')) {
            $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Restore))
        }
        $spec = $json | ConvertFrom-Json
        $needles = @($spec.titles | Where-Object { $_ -is [string] -and $_.Length -gt 0 })
        $script:ownerPid = 0
        $script:ownerName = ''
        if ($null -ne $spec.ownerPid) {
            $script:ownerPid = [int64]$spec.ownerPid
            try { $script:ownerName = ([System.Diagnostics.Process]::GetProcessById([int]$script:ownerPid)).ProcessName } catch { }
        }
        $counter = @{ shown = 0 }
        $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $callback = [Shot.Win+EnumProc]{
            param($handle, $param)
            $buffer = New-Object System.Text.StringBuilder 1024
            [void][Shot.Win]::GetWindowTextW($handle, $buffer, 1024)
            $title = $buffer.ToString()
            if ($title.Length -eq 0) { return $true }
            foreach ($needle in $needles) {
                if (-not $title.Contains($needle)) { continue }
                # Same ownership rule as the capture path: never touch a window
                # that merely mentions the app in its title.
                $winPid = 0
                [void][Shot.Win]::GetWindowThreadProcessId($handle, [ref]$winPid)
                if (-not (Test-WindowOwner ([int64]$winPid))) { break }
                if (-not [Shot.Win]::IsWindowVisible($handle)) {
                    [void][Shot.Win]::ShowWindow($handle, 5)   # SW_SHOW
                    $counter.shown = $counter.shown + 1
                    break
                }
                # A capture parks the window off-screen; bring it back if one is stuck there.
                $rect = New-Object Shot.Win+RECT
                if (-not [Shot.Win]::GetWindowRect($handle, [ref]$rect)) { break }
                $offscreen = ($rect.R -le $screen.Left) -or ($rect.L -ge ($screen.Left + $screen.Width)) -or
                    ($rect.B -le $screen.Top) -or ($rect.T -ge ($screen.Top + $screen.Height))
                if ($offscreen) {
                    $x = [Math]::Max($screen.Left, 80)
                    $y = [Math]::Max($screen.Top, 80)
                    [void][Shot.Win]::SetWindowPos(
                        $handle, [IntPtr]::Zero, $x, $y, ($rect.R - $rect.L), ($rect.B - $rect.T), 0x0054)
                    $counter.shown = $counter.shown + 1
                }
                break
            }
            return $true
        }
        [void][Shot.Win]::EnumWindows($callback, [IntPtr]::Zero)
        $shown = $counter.shown
    } catch { }
    Write-Result @{ ok = $true; shown = $shown }
    exit 0
}

if ($Worker) {
    try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }
    Write-Result @{ ready = $true; pid = $PID }
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }
        $line = $line.Trim()
        if ($line -eq '') { continue }
        if ($line -eq 'exit') { break }
        try {
            $spec = $line | ConvertFrom-Json
        } catch {
            Write-Result @{ ok = $false; error = 'malformed request' }
            continue
        }
        $result = @(Invoke-Capture $spec) | Where-Object { $_ -is [hashtable] } | Select-Object -First 1
        if ($null -eq $result) { $result = @{ ok = $false; error = 'capture produced no result' } }
        Write-Result $result
    }
    exit 0
}

# --- one-shot mode ------------------------------------------------------------
try {
    $spec = $null
    if ($Request -ne '') {
        # Windows PowerShell re-parses `-File` arguments and strips quotes, so the
        # caller sends the JSON body as base64.
        $json = $Request
        if (-not $json.TrimStart().StartsWith('{')) {
            $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Request))
        }
        $spec = $json | ConvertFrom-Json
    }
    if ($null -eq $spec) { $spec = [pscustomobject]@{ out = $Out; mode = $Mode } }
    if (-not $spec.out -and $Out -ne '') { $spec | Add-Member -NotePropertyName out -NotePropertyValue $Out -Force }
    $result = @(Invoke-Capture $spec) | Where-Object { $_ -is [hashtable] } | Select-Object -First 1
    if ($null -eq $result) { $result = @{ ok = $false; error = 'capture produced no result' } }
    Write-Result $result
    if ($result.ok -ne $true) { exit 1 }
} catch {
    Write-Result @{ ok = $false; error = "$($_.Exception.Message)" }
    exit 1
}
