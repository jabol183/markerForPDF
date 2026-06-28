# Invoice OCR - Windows Installer
# Runs from windows-installer\ folder; repo root is one level up.

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$VenvDir  = Join-Path $RepoRoot "venv"
$TrayApp  = Join-Path $PSScriptRoot "tray_app.py"

function Write-Step($msg) {
    Write-Host ""
    Write-Host "  >> $msg" -ForegroundColor Cyan
}

function Write-OK($msg) {
    Write-Host "     $msg" -ForegroundColor Green
}

function Write-Warn($msg) {
    Write-Host "     WARNING: $msg" -ForegroundColor Yellow
}

function Write-Fail($msg) {
    Write-Host ""
    Write-Host "  ERROR: $msg" -ForegroundColor Red
    Write-Host ""
    Read-Host "  Press Enter to exit"
    exit 1
}

# ---------------------------------------------------------------------------
# 1. Find or install Python 3.10+
# ---------------------------------------------------------------------------

Write-Step "Checking Python installation..."

$PythonExe = $null

foreach ($cmd in @("python", "python3", "py")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python (\d+)\.(\d+)") {
            $major = [int]$Matches[1]
            $minor = [int]$Matches[2]
            if ($major -eq 3 -and $minor -ge 10) {
                $PythonExe = (Get-Command $cmd).Source
                Write-OK "Found $ver at $PythonExe"
                break
            }
        }
    } catch {}
}

if (-not $PythonExe) {
    Write-Warn "Python 3.10+ not found. Downloading Python 3.11..."

    $PyInstaller = Join-Path $env:TEMP "python-3.11-installer.exe"
    $PyUrl = "https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe"

    Write-Host "     Downloading from $PyUrl ..." -ForegroundColor Yellow
    try {
        Invoke-WebRequest -Uri $PyUrl -OutFile $PyInstaller -UseBasicParsing
    } catch {
        Write-Fail "Could not download Python. Please install Python 3.10+ manually from https://www.python.org and re-run install.bat"
    }

    Write-Host "     Running Python installer (follow the prompts, tick 'Add to PATH')..." -ForegroundColor Yellow
    Start-Process -FilePath $PyInstaller -ArgumentList "/passive", "PrependPath=1", "Include_pip=1" -Wait
    Remove-Item $PyInstaller -Force

    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")

    $PythonExe = (Get-Command "python" -ErrorAction SilentlyContinue)?.Source
    if (-not $PythonExe) {
        Write-Fail "Python installation succeeded but python.exe still not on PATH. Please restart your PC and re-run install.bat"
    }
    Write-OK "Python installed at $PythonExe"
}

# ---------------------------------------------------------------------------
# 2. Create virtual environment
# ---------------------------------------------------------------------------

Write-Step "Creating virtual environment..."

if (Test-Path $VenvDir) {
    Write-OK "Virtual environment already exists at $VenvDir — skipping creation"
} else {
    & $PythonExe -m venv $VenvDir
    Write-OK "Created venv at $VenvDir"
}

$VenvPython  = Join-Path $VenvDir "Scripts\python.exe"
$VenvPythonW = Join-Path $VenvDir "Scripts\pythonw.exe"
$VenvPip     = Join-Path $VenvDir "Scripts\pip.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Fail "Virtual environment creation failed. Check that Python is installed correctly."
}

# ---------------------------------------------------------------------------
# 3. Upgrade pip
# ---------------------------------------------------------------------------

Write-Step "Upgrading pip..."
& $VenvPython -m pip install --upgrade pip --quiet
Write-OK "pip up to date"

# ---------------------------------------------------------------------------
# 4. Install Marker (local editable install)
# ---------------------------------------------------------------------------

Write-Step "Installing Marker PDF and dependencies (this may take 5–15 minutes on first run)..."
Write-Host "     Installing local marker package..." -ForegroundColor DarkGray

Set-Location $RepoRoot
& $VenvPython -m pip install -e . --quiet

if ($LASTEXITCODE -ne 0) {
    # Fallback: install from PyPI
    Write-Warn "Local editable install failed, falling back to PyPI marker-pdf..."
    & $VenvPython -m pip install marker-pdf --quiet
}

Write-OK "Marker installed"

# ---------------------------------------------------------------------------
# 5. Install server + tray dependencies
# ---------------------------------------------------------------------------

Write-Step "Installing server and tray dependencies..."
& $VenvPython -m pip install fastapi uvicorn python-multipart pystray --quiet
Write-OK "fastapi, uvicorn, python-multipart, pystray installed"

# ---------------------------------------------------------------------------
# 6. Optional: Gemini API key
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "  -----------------------------------------------" -ForegroundColor DarkGray
Write-Host "   Optional: Gemini API key for better accuracy" -ForegroundColor White
Write-Host "   (free at https://aistudio.google.com)" -ForegroundColor DarkGray
Write-Host "   Leave blank to skip — you can add it later" -ForegroundColor DarkGray
Write-Host "  -----------------------------------------------" -ForegroundColor DarkGray
$GeminiKey = Read-Host "  Enter Gemini API key (or press Enter to skip)"

$EnvFile = Join-Path $RepoRoot ".env"
if ($GeminiKey) {
    Set-Content -Path $EnvFile -Value "GEMINI_API_KEY=$GeminiKey"
    Write-OK "API key saved to .env"
} else {
    Write-OK "Skipped — regex extraction will be used (still works well)"
}

# ---------------------------------------------------------------------------
# 7. Create Desktop shortcut
# ---------------------------------------------------------------------------

Write-Step "Creating Desktop shortcut..."

$DesktopPath = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $DesktopPath "Invoice OCR.lnk"

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath      = $VenvPythonW
$Shortcut.Arguments       = "`"$TrayApp`""
$Shortcut.WorkingDirectory = $RepoRoot
$Shortcut.Description     = "Invoice OCR Server (system tray)"
$Shortcut.WindowStyle     = 7  # minimised / no window
$Shortcut.Save()

Write-OK "Shortcut created: $ShortcutPath"

# ---------------------------------------------------------------------------
# 8. Optional: Start on Windows login
# ---------------------------------------------------------------------------

Write-Host ""
$StartupChoice = Read-Host "  Auto-start Invoice OCR when Windows logs in? (y/N)"
if ($StartupChoice -match "^[Yy]") {
    $StartupDir = [Environment]::GetFolderPath("Startup")
    $StartupShortcut = Join-Path $StartupDir "Invoice OCR.lnk"
    $Shortcut2 = $WshShell.CreateShortcut($StartupShortcut)
    $Shortcut2.TargetPath       = $VenvPythonW
    $Shortcut2.Arguments        = "`"$TrayApp`""
    $Shortcut2.WorkingDirectory = $RepoRoot
    $Shortcut2.WindowStyle      = 7
    $Shortcut2.Save()
    Write-OK "Added to Windows startup"
} else {
    Write-OK "Skipped startup entry"
}

# ---------------------------------------------------------------------------
# 9. Done
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Green
Write-Host "   Installation complete!" -ForegroundColor Green
Write-Host "  ============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  HOW TO USE:" -ForegroundColor White
Write-Host "   1. Double-click 'Invoice OCR' on your Desktop" -ForegroundColor Gray
Write-Host "   2. A tray icon appears in the bottom-right system tray" -ForegroundColor Gray
Write-Host "   3. Right-click the tray icon to Start / Stop the server" -ForegroundColor Gray
Write-Host "   4. Open Chrome, use the Invoice OCR extension as normal" -ForegroundColor Gray
Write-Host ""
Write-Host "  NOTE: First launch downloads ~1-2 GB of AI models." -ForegroundColor Yellow
Write-Host "        This is a one-time download." -ForegroundColor Yellow
Write-Host ""

$LaunchNow = Read-Host "  Launch Invoice OCR now? (Y/n)"
if ($LaunchNow -notmatch "^[Nn]") {
    Start-Process -FilePath $VenvPythonW -ArgumentList "`"$TrayApp`"" -WorkingDirectory $RepoRoot
    Write-Host ""
    Write-Host "  Server starting... check your system tray (bottom-right)." -ForegroundColor Cyan
}

Write-Host ""
Read-Host "  Press Enter to close this window"
