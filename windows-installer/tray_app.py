"""
Invoice OCR - System Tray Application
Sits in the Windows system tray and manages the invoice_server.py process.
"""

import os
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

import pystray
from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent
SERVER_SCRIPT = REPO_ROOT / "invoice_server.py"
ENV_FILE = REPO_ROOT / ".env"
LOG_FILE = REPO_ROOT / "invoice_server.log"

# Python executable in the venv (same python running this script)
PYTHON_EXE = sys.executable

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

server_process: subprocess.Popen | None = None
server_lock = threading.Lock()
tray_icon: pystray.Icon | None = None


# ---------------------------------------------------------------------------
# Icon drawing
# ---------------------------------------------------------------------------

def _make_icon(color: str) -> Image.Image:
    """Draw a document icon; color is the status dot color."""
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Document body
    doc_color = (79, 142, 247)       # blue
    fold_color = (50, 100, 200)
    bg = (30, 40, 70)

    # Background circle
    d.ellipse([0, 0, size - 1, size - 1], fill=bg)

    # Document shape
    margin = 12
    fold = 16
    d.polygon([
        (margin, margin),
        (size - margin - fold, margin),
        (size - margin, margin + fold),
        (size - margin, size - margin),
        (margin, size - margin),
    ], fill=doc_color)

    # Fold corner
    d.polygon([
        (size - margin - fold, margin),
        (size - margin, margin + fold),
        (size - margin - fold, margin + fold),
    ], fill=fold_color)

    # Text lines
    line_color = (255, 255, 255, 180)
    for y_offset in [28, 35, 42]:
        d.rectangle([margin + 6, y_offset, size - margin - 6, y_offset + 3], fill=line_color)

    # Status dot (bottom-right)
    dot_colors = {"green": (34, 197, 94), "red": (239, 68, 68), "amber": (245, 158, 11)}
    dot_rgb = dot_colors.get(color, (100, 100, 100))
    dot_r = 10
    dot_x = size - dot_r - 4
    dot_y = size - dot_r - 4
    d.ellipse([dot_x - dot_r, dot_y - dot_r, dot_x + dot_r, dot_y + dot_r],
              fill=(*dot_rgb, 255), outline=(0, 0, 0, 180), width=2)

    return img


ICON_RUNNING = _make_icon("green")
ICON_STOPPED = _make_icon("red")
ICON_STARTING = _make_icon("amber")


# ---------------------------------------------------------------------------
# .env loader
# ---------------------------------------------------------------------------

def _load_env():
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                key, _, val = line.partition("=")
                os.environ.setdefault(key.strip(), val.strip())


# ---------------------------------------------------------------------------
# Server management
# ---------------------------------------------------------------------------

def _is_running() -> bool:
    with server_lock:
        return server_process is not None and server_process.poll() is None


def start_server():
    global server_process
    with server_lock:
        if server_process and server_process.poll() is None:
            return  # already running

        _load_env()
        env = os.environ.copy()

        log_f = open(LOG_FILE, "a", buffering=1)
        server_process = subprocess.Popen(
            [PYTHON_EXE, str(SERVER_SCRIPT)],
            cwd=str(REPO_ROOT),
            env=env,
            stdout=log_f,
            stderr=log_f,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )

    _update_icon("amber", "Invoice OCR — Starting...")
    # Poll until server responds or times out
    threading.Thread(target=_wait_for_server, daemon=True).start()


def _wait_for_server(timeout=120):
    import urllib.request
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _is_running():
            _update_icon("red", "Invoice OCR — Stopped (crashed)")
            return
        try:
            with urllib.request.urlopen("http://localhost:8765/health", timeout=2) as r:
                if r.status == 200:
                    _update_icon("green", "Invoice OCR — Running")
                    return
        except Exception:
            pass
        time.sleep(2)
    _update_icon("amber", "Invoice OCR — Starting (slow model load)")


def stop_server():
    global server_process
    with server_lock:
        if server_process and server_process.poll() is None:
            server_process.terminate()
            try:
                server_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server_process.kill()
        server_process = None
    _update_icon("red", "Invoice OCR — Stopped")


def restart_server():
    stop_server()
    time.sleep(1)
    start_server()


# ---------------------------------------------------------------------------
# Tray icon helpers
# ---------------------------------------------------------------------------

def _update_icon(color: str, tooltip: str):
    if tray_icon is None:
        return
    icons = {"green": ICON_RUNNING, "red": ICON_STOPPED, "amber": ICON_STARTING}
    tray_icon.icon = icons.get(color, ICON_STOPPED)
    tray_icon.title = tooltip
    tray_icon.update_menu()


# ---------------------------------------------------------------------------
# Tray menu actions
# ---------------------------------------------------------------------------

def action_start(icon, item):
    if not _is_running():
        threading.Thread(target=start_server, daemon=True).start()


def action_stop(icon, item):
    threading.Thread(target=stop_server, daemon=True).start()


def action_restart(icon, item):
    threading.Thread(target=restart_server, daemon=True).start()


def action_open_logs(icon, item):
    if LOG_FILE.exists():
        os.startfile(str(LOG_FILE))
    else:
        import tkinter.messagebox as mb
        mb.showinfo("Invoice OCR", "No log file yet. Start the server first.")


def action_open_extensions(icon, item):
    webbrowser.open("chrome://extensions")


def action_open_api_docs(icon, item):
    webbrowser.open("http://localhost:8765/docs")


def action_set_gemini_key(icon, item):
    import tkinter as tk
    import tkinter.simpledialog as sd

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)

    current = os.environ.get("GEMINI_API_KEY", "")
    key = sd.askstring(
        "Gemini API Key",
        "Paste your Gemini API key (leave blank to clear):\n"
        "Get one free at https://aistudio.google.com",
        initialvalue=current,
        parent=root,
    )
    root.destroy()

    if key is None:
        return  # cancelled
    key = key.strip()
    if key:
        os.environ["GEMINI_API_KEY"] = key
        ENV_FILE.write_text(f"GEMINI_API_KEY={key}\n")
        import tkinter.messagebox as mb
        mb.showinfo("Invoice OCR", "Gemini API key saved.\nRestart the server to apply.")
    else:
        os.environ.pop("GEMINI_API_KEY", None)
        if ENV_FILE.exists():
            ENV_FILE.unlink()


def action_quit(icon, item):
    stop_server()
    icon.stop()


# ---------------------------------------------------------------------------
# Menu builder
# ---------------------------------------------------------------------------

def _build_menu() -> pystray.Menu:
    def status_text(item) -> str:
        return "Status: Running  " if _is_running() else "Status: Stopped  "

    return pystray.Menu(
        pystray.MenuItem(status_text, None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Start server",   action_start,   enabled=lambda item: not _is_running()),
        pystray.MenuItem("Stop server",    action_stop,    enabled=lambda item: _is_running()),
        pystray.MenuItem("Restart server", action_restart, enabled=lambda item: _is_running()),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("View server logs",        action_open_logs),
        pystray.MenuItem("Open API docs (browser)", action_open_api_docs, enabled=lambda item: _is_running()),
        pystray.MenuItem("Open Chrome extensions",  action_open_extensions),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Set Gemini API key...", action_set_gemini_key),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", action_quit),
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    global tray_icon

    _load_env()

    tray_icon = pystray.Icon(
        name="invoice_ocr",
        icon=ICON_STOPPED,
        title="Invoice OCR — Stopped",
        menu=_build_menu(),
    )

    # Auto-start server when tray app launches
    threading.Thread(target=start_server, daemon=True).start()

    tray_icon.run()


if __name__ == "__main__":
    main()
