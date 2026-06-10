#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]
// BagIdea Office — THE program. One exe runs the whole stack:
//   • spawns the event daemon (node) if not already running
//   • spawns the Godot office (Windows: embedded behind the desktop icons via
//     WorkerW; macOS: a DYLD shim drops it to the desktop window level)
//   • circular chat head (drag anywhere, click toggles the overlay)
//   • frameless rounded overlay with custom chrome
//   • system tray icon — the ONLY place to exit; quitting tears the whole
//     stack down and restores the user's wallpaper.
//
// All OS-specific plumbing lives in the `platform` module: one impl per OS,
// the same surface. `main()` stays platform-neutral.

use std::path::PathBuf;
use std::process::{Child, Command};

use tao::{
    dpi::{LogicalPosition, LogicalSize},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::{Icon, Window, WindowBuilder},
};
use tray_icon::{
    menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    TrayIconBuilder, TrayIconEvent,
};

const ORB_SIZE: f64 = 72.0;
const FULL: (f64, f64) = (560.0, 700.0);
const MINI: (f64, f64) = (390.0, 430.0);
const FEED_W: f64 = 330.0;
const PARK: (f64, f64) = (-9000.0, 100.0);
const SPLASH_SIZE: f64 = 210.0;

#[derive(Debug)]
enum UserEvent {
    Toggle,
    DragOrb,
    DragOverlay,
    HideOverlay,
    MiniToggle,
    FeedToggle,
    SetHotkey(String),
    PttKey(bool), // global voice hotkey: true = pressed, false = released
    WorldReady,
    EditorOpening, // show the logo splash + launch the 3D editor tiny behind it
    EditorReady,   // the editor window is on screen → drop the splash
}

// Run a child process without flashing a console window (Windows); a no-op
// elsewhere.
fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

// ----------------------------------------------------------------- HTML chrome
const SPLASH_HTML: &str = r#"<!doctype html>
<html><body style="margin:0;overflow:hidden;background:#070b13">
<img src="http://127.0.0.1:8787/brand/logo_ico_cute.png" draggable="false"
     style="position:absolute;left:0;top:0;width:100%;height:100%;animation:p 1.5s ease-in-out infinite"
     onerror="document.body.style.background='radial-gradient(circle at 32% 28%,#2a78d8,#0b1422)'">
<style>@keyframes p{0%,100%{transform:scale(1)}50%{transform:scale(0.92)}}</style>
</body></html>"#;

const ORB_HTML: &str = r#"<!doctype html>
<html><body style="margin:0;overflow:hidden;background:#0a111d;user-select:none;-webkit-user-select:none;cursor:pointer">
<div id="ring"></div>
<img id="logo" src="http://127.0.0.1:8787/brand/logo_ico_cute.png" draggable="false"
     onerror="document.body.style.background='radial-gradient(circle at 32% 28%,#2a78d8,#0b1422)'">
<style>
  /* a quiet living ring: slow drift at rest, eager spin while agents work */
  #ring { position:absolute; inset:0; border-radius:50%;
    background: conic-gradient(from 0deg,
      rgba(94,200,255,0) 0%, rgba(94,200,255,0.9) 22%,
      rgba(168,130,255,0.55) 38%, rgba(94,200,255,0) 60%);
    animation: spin 4.5s linear infinite; }
  #ring::after { content:""; position:absolute; inset:2.5px; border-radius:50%; background:#0a111d; }
  #logo { position:absolute; left:3.4px; top:3.9px; width:65.8px; height:65.8px;
    z-index:2; border-radius:50%; animation: breathe 3.4s ease-in-out infinite; }
  body.busy #ring { animation-duration: 1.1s;
    background: conic-gradient(from 0deg,
      rgba(255,176,84,0) 0%, rgba(255,176,84,0.95) 22%,
      rgba(94,200,255,0.7) 38%, rgba(255,176,84,0) 60%); }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes breathe { 0%,100% { transform: scale(1); } 50% { transform: scale(0.955); } }
</style>
<script>
  // Live pulse: the ring knows when the office is actually working.
  let busy = 0;
  function wire() {
    try {
      const ws = new WebSocket('ws://127.0.0.1:8787/ws');
      ws.onmessage = (m) => {
        try {
          const e = JSON.parse(m.data);
          if (e.replay) return;
          if (e.type === 'task.started') busy++;
          else if (e.type === 'task.completed' || e.type === 'task.failed') busy = Math.max(0, busy - 1);
          document.body.classList.toggle('busy', busy > 0);
        } catch {}
      };
      ws.onclose = () => { busy = 0; document.body.classList.remove('busy'); setTimeout(wire, 5000); };
    } catch { setTimeout(wire, 5000); }
  }
  wire();
</script>
<script>
  // Messenger chat-head feel: press-and-move drags, clean click toggles.
  let downAt = null, dragged = false;
  document.body.addEventListener('mousedown', (e) => {
    if (e.button === 0) { downAt = [e.screenX, e.screenY]; dragged = false; }
  });
  document.body.addEventListener('mousemove', (e) => {
    if (downAt && !dragged &&
        Math.hypot(e.screenX - downAt[0], e.screenY - downAt[1]) > 10) {
      dragged = true;
      window.ipc.postMessage('drag-orb');
    }
  });
  document.body.addEventListener('mouseup', () => { downAt = null; });
  document.body.addEventListener('click', () => {
    if (!dragged) window.ipc.postMessage('toggle');
    dragged = false;
  });
  // Right-click flips chat ↔ streamer feed (a quiet right-edge status strip).
  document.body.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.ipc.postMessage('mode');
  });
</script>
</body></html>"#;

// ----------------------------------------------------------- shared orchestration
fn project_root() -> PathBuf {
    // Walk up from the exe until we find the repo root (has daemon/server.js).
    if let Ok(exe) = std::env::current_exe() {
        for dir in exe.ancestors() {
            if dir.join("daemon").join("server.js").exists() {
                return dir.to_path_buf();
            }
        }
    }
    PathBuf::from(".")
}

fn daemon_running() -> bool {
    std::net::TcpStream::connect_timeout(
        &"127.0.0.1:8787".parse().unwrap(),
        std::time::Duration::from_millis(400),
    )
    .is_ok()
}

fn spawn_daemon(root: &PathBuf) -> Option<Child> {
    if daemon_running() {
        return None;
    }
    let mut c = Command::new("node");
    c.arg(root.join("daemon").join("server.js"));
    hidden(&mut c).spawn().ok()
}

fn spawn_office(root: &PathBuf, cx: i32, cy: i32) -> Option<Child> {
    let godot = platform::godot_exe(root);
    if !std::path::Path::new(&godot).exists() {
        return None; // overlay-only mode
    }
    let mut c = Command::new(godot);
    platform::office_args(&mut c, root, cx, cy);
    hidden(&mut c).spawn().ok()
}

fn spawn_editor(root: &PathBuf, cx: i32, cy: i32) -> Option<Child> {
    let godot = platform::godot_exe(root);
    if !std::path::Path::new(&godot).exists() {
        return None;
    }
    let mut c = Command::new(godot);
    c.args(["--path"])
        .arg(root.join("godot"))
        .args(["--resolution", "64x64"])
        .arg("--position")
        .arg(format!("{},{}", cx - 32, cy - 32))
        .args(["--", "--editor3d"]);
    hidden(&mut c).spawn().ok()
}

// Watch for the daemon's "open the editor" request, then for the editor's
// "ready" handoff — drives the splash show/hide via the event loop.
fn watch_editor_requests(proxy: tao::event_loop::EventLoopProxy<UserEvent>) {
    std::thread::spawn(move || {
        let req = std::env::temp_dir().join("bagidea_editor_open_request");
        let ready = std::env::temp_dir().join("bagidea_editor_ready");
        let _ = std::fs::remove_file(&req);
        loop {
            if req.exists() {
                let _ = std::fs::remove_file(&req);
                let _ = std::fs::remove_file(&ready);
                let _ = proxy.send_event(UserEvent::EditorOpening);
                let start = std::time::SystemTime::now();
                loop {
                    let fresh = std::fs::metadata(&ready)
                        .and_then(|x| x.modified())
                        .map(|t| t >= start)
                        .unwrap_or(false);
                    if fresh || start.elapsed().unwrap_or_default() > std::time::Duration::from_secs(60) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
                let _ = proxy.send_event(UserEvent::EditorReady);
            }
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    });
}

/// Fire-and-forget visibility event to the daemon (curl ships with both OSes).
fn post_visibility(on: bool) {
    let mut c = Command::new("curl");
    c.args(["-s", "-X", "POST", "http://127.0.0.1:8787/event",
        "-H", "content-type: application/json",
        "-d", &format!("{{\"type\":\"ui.visibility\",\"on\":{}}}", on)]);
    let _ = hidden(&mut c).spawn();
}

/// Debug beacon: stages of the hotkey chain reported to the daemon.
fn ptt_beacon(stage: &str) {
    let body = format!(r#"{{"type":"ui.ptt","stage":"{}"}}"#, stage);
    let mut c = Command::new("curl");
    c.args(["-s", "-X", "POST", "http://127.0.0.1:8787/event",
        "-H", "content-type: application/json", "-d", &body]);
    let _ = hidden(&mut c).spawn();
}

fn icon_rgba() -> Option<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory(include_bytes!("../../godot/assets/brand/logo_ico_cute.png"))
        .ok()?
        .into_rgba8();
    let (w, h) = img.dimensions();
    Some((img.into_raw(), w, h))
}

fn app_icon() -> Option<Icon> {
    let (rgba, w, h) = icon_rgba()?;
    Icon::from_rgba(rgba, w, h).ok()
}

fn tray_app_icon() -> Option<tray_icon::Icon> {
    let (rgba, w, h) = icon_rgba()?;
    tray_icon::Icon::from_rgba(rgba, w, h).ok()
}

// =====================================================================
//  Windows platform implementation
// =====================================================================
#[cfg(windows)]
mod platform {
    use super::{ptt_beacon, UserEvent};
    use std::path::PathBuf;
    use std::process::Command;
    use tao::platform::windows::{WindowBuilderExtWindows, WindowExtWindows};
    use tao::window::{Window, WindowBuilder};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateEllipticRgn, CreateRectRgn, CreateRoundRectRgn, SetWindowRgn,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowExW, FindWindowW, GetWindowLongW, GetWindowThreadProcessId,
        IsWindowVisible, SendMessageTimeoutW, SetLayeredWindowAttributes, SetParent,
        SetWindowLongW, ShowWindow, SystemParametersInfoW, GWL_EXSTYLE, LWA_ALPHA,
        SMTO_NORMAL, SPI_SETDESKWALLPAPER, SW_HIDE, SW_SHOW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW,
    };

    static PTT_THREAD_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn parse_vk(s: &str) -> Option<(u32, u32)> {
        let mut mods = 0u32;
        let mut vk = None;
        for part in s.to_lowercase().split('+') {
            match part.trim() {
                "ctrl" | "control" => mods |= 0x0002,
                "shift" => mods |= 0x0004,
                "alt" => mods |= 0x0001,
                "space" => vk = Some(0x20u32),
                "f5" => vk = Some(0x74),
                "f6" => vk = Some(0x75),
                "f7" => vk = Some(0x76),
                "f8" => vk = Some(0x77),
                "f9" => vk = Some(0x78),
                "f10" => vk = Some(0x79),
                "none" | "" => return None,
                _ => {}
            }
        }
        vk.map(|v| (mods, v))
    }

    pub fn godot_exe(root: &PathBuf) -> String {
        let branded = root.join("godot").join("bin").join("BagIdeaOffice.exe");
        if branded.exists() {
            return branded.to_string_lossy().into_owned();
        }
        std::env::var("BAGIDEA_GODOT")
            .unwrap_or_else(|_| r"E:\Tools\Godot\Godot_v4.6.3-stable_win64.exe".into())
    }

    pub fn office_args(c: &mut Command, root: &PathBuf, cx: i32, cy: i32) {
        // Born 64px DEAD CENTER — under the shell's circular splash, so the
        // loading window hides behind the logo. office_floor.gd grows it.
        c.args(["--path"])
            .arg(root.join("godot"))
            .args(["--resolution", "64x64"])
            .arg("--position")
            .arg(format!("{},{}", cx - 32, cy - 32))
            .args(["--", "--wallpaper"]);
    }

    pub fn ensure_single_instance() -> bool {
        unsafe {
            use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
            use windows_sys::Win32::System::Threading::CreateMutexW;
            let name = wide("BagIdeaOfficeShellSingleton");
            CreateMutexW(std::ptr::null(), 0, name.as_ptr());
            GetLastError() != ERROR_ALREADY_EXISTS
        }
    }

    pub fn spawn_hotkey_thread(proxy: tao::event_loop::EventLoopProxy<UserEvent>) {
        let initial = parse_vk("f6");
        std::thread::spawn(move || unsafe {
            use std::sync::atomic::Ordering;
            use windows_sys::Win32::System::Threading::GetCurrentThreadId;
            use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey};
            use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_APP, WM_HOTKEY};
            PTT_THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);
            let mut ok = false;
            if let Some((m, v)) = initial {
                ok = RegisterHotKey(std::ptr::null_mut(), 1, m | 0x4000, v) != 0;
            }
            ptt_beacon(if ok { "registered" } else { "register-FAILED" });
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                if msg.message == WM_HOTKEY {
                    ptt_beacon("hook-press");
                    let _ = proxy.send_event(UserEvent::PttKey(true));
                } else if msg.message == WM_APP {
                    UnregisterHotKey(std::ptr::null_mut(), 1);
                    let vk = msg.lParam as u32;
                    if vk != 0 {
                        let r = RegisterHotKey(std::ptr::null_mut(), 1, (msg.wParam as u32) | 0x4000, vk);
                        ptt_beacon(if r != 0 { "rehook-ok" } else { "rehook-FAILED" });
                    } else {
                        ptt_beacon("rehook-none");
                    }
                }
            }
        });
    }

    pub fn rebind_hotkey(s: &str) {
        use std::sync::atomic::Ordering;
        use windows_sys::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_APP};
        let tid = PTT_THREAD_ID.load(Ordering::SeqCst);
        if tid == 0 {
            return;
        }
        let (mods, vk) = parse_vk(s).unwrap_or((0, 0));
        unsafe {
            PostThreadMessageW(tid, WM_APP, mods as usize, vk as isize);
        }
    }

    unsafe extern "system" fn find_workerw_cb(top: HWND, out: windows_sys::Win32::Foundation::LPARAM) -> i32 {
        let shell_class = wide("SHELLDLL_DefView");
        let shell = FindWindowExW(top, 0 as HWND, shell_class.as_ptr(), std::ptr::null());
        if shell != 0 as HWND {
            let worker_class = wide("WorkerW");
            let worker = FindWindowExW(0 as HWND, top, worker_class.as_ptr(), std::ptr::null());
            if worker != 0 as HWND {
                *(out as *mut HWND) = worker;
            }
        }
        1
    }

    struct FindByPid {
        pid: u32,
        hwnd: HWND,
    }

    unsafe extern "system" fn find_by_pid_cb(h: HWND, lp: windows_sys::Win32::Foundation::LPARAM) -> i32 {
        let data = &mut *(lp as *mut FindByPid);
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, &mut pid);
        if pid == data.pid && IsWindowVisible(h) != 0 {
            data.hwnd = h;
            return 0;
        }
        1
    }

    fn find_wallpaper_hwnd(pid: u32) -> HWND {
        unsafe {
            let progman_class = wide("Progman");
            let progman = FindWindowW(progman_class.as_ptr(), std::ptr::null());
            let mut workerw: HWND = 0 as HWND;
            EnumWindows(Some(find_workerw_cb), &mut workerw as *mut HWND as _);
            if workerw == 0 as HWND {
                let worker_class = wide("WorkerW");
                workerw = FindWindowExW(progman, 0 as HWND, worker_class.as_ptr(), std::ptr::null());
                if workerw == 0 as HWND {
                    workerw = progman;
                }
            }
            let mut child = FindWindowExW(workerw, 0 as HWND, std::ptr::null(), std::ptr::null());
            while child != 0 as HWND {
                let mut wpid = 0u32;
                GetWindowThreadProcessId(child, &mut wpid);
                if wpid == pid {
                    return child;
                }
                child = FindWindowExW(workerw, child, std::ptr::null(), std::ptr::null());
            }
            0 as HWND
        }
    }

    pub fn attach_wallpaper_when_ready(pid: u32, proxy: tao::event_loop::EventLoopProxy<UserEvent>) {
        std::thread::spawn(move || unsafe {
            let mut find = FindByPid { pid, hwnd: 0 as HWND };
            for _ in 0..240 {
                EnumWindows(Some(find_by_pid_cb), &mut find as *mut FindByPid as _);
                if find.hwnd != 0 as HWND {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            let godot = find.hwnd;
            if godot == 0 as HWND {
                let _ = proxy.send_event(UserEvent::WorldReady);
                return;
            }
            SetWindowRgn(godot as _, CreateRectRgn(0, 0, 0, 0), 1);
            ShowWindow(godot, SW_HIDE);
            let ex = GetWindowLongW(godot, GWL_EXSTYLE) as u32;
            SetWindowLongW(godot, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW) as i32);
            ShowWindow(godot, SW_SHOW);

            let started = std::time::SystemTime::now() - std::time::Duration::from_secs(5);
            let flag = std::env::temp_dir().join("bagidea_world_ready");
            for _ in 0..120 {
                let fresh = std::fs::metadata(&flag)
                    .and_then(|m| m.modified())
                    .map(|t| t >= started)
                    .unwrap_or(false);
                if fresh {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            std::thread::sleep(std::time::Duration::from_millis(400));
            SetWindowRgn(godot as _, 0 as _, 1);

            let progman_class = wide("Progman");
            let progman = FindWindowW(progman_class.as_ptr(), std::ptr::null());
            let mut result: usize = 0;
            SendMessageTimeoutW(progman, 0x052C, 0, 0, SMTO_NORMAL, 1000, &mut result);
            let mut workerw: HWND = 0 as HWND;
            EnumWindows(Some(find_workerw_cb), &mut workerw as *mut HWND as _);
            if workerw == 0 as HWND {
                let worker_class = wide("WorkerW");
                workerw = FindWindowExW(progman, 0 as HWND, worker_class.as_ptr(), std::ptr::null());
                if workerw == 0 as HWND {
                    workerw = progman;
                }
            }
            SetParent(godot, workerw);
            let _ = proxy.send_event(UserEvent::WorldReady);
        });
    }

    pub fn hide_office(pid: u32, hidden: bool) {
        let g = find_wallpaper_hwnd(pid);
        if g != 0 as HWND {
            unsafe { ShowWindow(g, if hidden { SW_HIDE } else { SW_SHOW }); }
        }
    }

    /// Focus an already-open editor by pid; returns true if one was found.
    pub fn focus_pid(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        let mut find = FindByPid { pid, hwnd: 0 as HWND };
        unsafe { EnumWindows(Some(find_by_pid_cb), &mut find as *mut FindByPid as _); }
        if find.hwnd != 0 as HWND {
            unsafe {
                use windows_sys::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, ShowWindow, SW_RESTORE};
                ShowWindow(find.hwnd, SW_RESTORE);
                SetForegroundWindow(find.hwnd);
            }
            true
        } else {
            false
        }
    }

    pub fn apply_chrome(b: WindowBuilder) -> WindowBuilder {
        b.with_undecorated_shadow(false).with_skip_taskbar(true)
    }

    pub fn set_no_activate(window: &Window) {
        unsafe {
            let hwnd = window.hwnd() as HWND;
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            SetWindowLongW(hwnd, GWL_EXSTYLE, (ex | WS_EX_NOACTIVATE) as i32);
        }
    }

    pub fn region_round(window: &Window, w: f64, h: f64, radius: f64) {
        let sf = window.scale_factor();
        unsafe {
            let rgn = CreateRoundRectRgn(
                0, 0,
                (w * sf) as i32 + 1, (h * sf) as i32 + 1,
                (radius * sf) as i32, (radius * sf) as i32,
            );
            SetWindowRgn(window.hwnd() as _, rgn, 1);
        }
    }

    pub fn region_circle(window: &Window, d: f64) {
        let sf = window.scale_factor();
        unsafe {
            let rgn = CreateEllipticRgn(0, 0, (d * sf) as i32 + 1, (d * sf) as i32 + 1);
            SetWindowRgn(window.hwnd() as _, rgn, 1);
        }
    }

    pub fn set_feed_alpha(window: &Window, feed: bool) {
        unsafe {
            let hwnd = window.hwnd() as HWND;
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            if feed {
                SetWindowLongW(hwnd, GWL_EXSTYLE, (ex | WS_EX_LAYERED) as i32);
                SetLayeredWindowAttributes(hwnd, 0, 196, LWA_ALPHA);
            } else {
                SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
                SetWindowLongW(hwnd, GWL_EXSTYLE, (ex & !WS_EX_LAYERED) as i32);
            }
        }
    }

    pub fn webview_extras<'a>(b: wry::WebViewBuilder<'a>) -> wry::WebViewBuilder<'a> {
        use wry::WebViewBuilderExtWindows;
        // Edge's "Saved info" autofill bubbles are noise on an app UI.
        b.with_general_autofill_enabled(false)
    }

    const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const RUN_NAME: &str = "BagIdeaOffice";

    pub fn is_autostart() -> bool {
        let mut c = Command::new("reg");
        c.args(["query", RUN_KEY, "/v", RUN_NAME]);
        super::hidden(&mut c).output().map(|o| o.status.success()).unwrap_or(false)
    }

    pub fn set_autostart(on: bool) {
        if on {
            if let Ok(exe) = std::env::current_exe() {
                let mut c = Command::new("reg");
                c.args(["add", RUN_KEY, "/v", RUN_NAME, "/t", "REG_SZ", "/d",
                    &exe.to_string_lossy(), "/f"]);
                let _ = super::hidden(&mut c).status();
            }
        } else {
            let mut c = Command::new("reg");
            c.args(["delete", RUN_KEY, "/v", RUN_NAME, "/f"]);
            let _ = super::hidden(&mut c).status();
        }
    }

    pub fn restore_wallpaper() {
        unsafe {
            SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, std::ptr::null_mut(), 3);
        }
    }

    pub const AUTOSTART_LABEL: &str = "Start with Windows";
}

// =====================================================================
//  macOS platform implementation
// =====================================================================
#[cfg(target_os = "macos")]
mod platform {
    use super::UserEvent;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::path::PathBuf;
    use std::process::Command;
    use tao::platform::macos::WindowExtMacOS;
    use tao::window::{Window, WindowBuilder};

    pub const AUTOSTART_LABEL: &str = "Start at login";

    pub fn godot_exe(root: &PathBuf) -> String {
        let app = root.join("godot").join("bin-mac").join("Godot.app")
            .join("Contents").join("MacOS").join("Godot");
        if app.exists() {
            return app.to_string_lossy().into_owned();
        }
        std::env::var("BAGIDEA_GODOT")
            .unwrap_or_else(|_| "/Applications/Godot.app/Contents/MacOS/Godot".into())
    }

    pub fn office_args(c: &mut Command, root: &PathBuf, _cx: i32, _cy: i32) {
        // Stage A: a normal windowed office (the desktop-level embed comes from
        // the DYLD shim in a follow-up). Still passes --wallpaper so the world
        // reports ready the same way.
        c.args(["--path"]).arg(root.join("godot")).args(["--", "--wallpaper"]);
        // If a built shim is present, inject it so Godot drops to desktop level.
        let shim = root.join("shell").join("macos").join("libwallpaper_shim.dylib");
        if shim.exists() {
            c.env("DYLD_INSERT_LIBRARIES", shim);
        }
    }

    pub fn ensure_single_instance() -> bool {
        let lock = std::env::temp_dir().join("bagidea_office_shell.lock");
        if let Ok(s) = std::fs::read_to_string(&lock) {
            if let Ok(pid) = s.trim().parse::<i32>() {
                let alive = Command::new("kill")
                    .args(["-0", &pid.to_string()])
                    .status()
                    .map(|st| st.success())
                    .unwrap_or(false);
                if alive {
                    return false;
                }
            }
        }
        let _ = std::fs::write(&lock, std::process::id().to_string());
        true
    }

    // No global hotkey yet on macOS (needs a Carbon RegisterEventHotKey or a
    // CGEventTap with Accessibility permission). The in-overlay mic button still
    // works; this is a no-op until that lands.
    pub fn spawn_hotkey_thread(_proxy: tao::event_loop::EventLoopProxy<UserEvent>) {}
    pub fn rebind_hotkey(_s: &str) {}

    // The shim handles the desktop-level embed; here we just wait for the world
    // to report ready (or a timeout) and lift the splash.
    pub fn attach_wallpaper_when_ready(_pid: u32, proxy: tao::event_loop::EventLoopProxy<UserEvent>) {
        std::thread::spawn(move || {
            let started = std::time::SystemTime::now() - std::time::Duration::from_secs(2);
            let flag = std::env::temp_dir().join("bagidea_world_ready");
            for _ in 0..30 {
                let fresh = std::fs::metadata(&flag)
                    .and_then(|m| m.modified())
                    .map(|t| t >= started)
                    .unwrap_or(false);
                if fresh {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
            let _ = proxy.send_event(UserEvent::WorldReady);
        });
    }

    fn running_app(pid: u32) -> *mut AnyObject {
        unsafe {
            let cls = class!(NSRunningApplication);
            msg_send![cls, runningApplicationWithProcessIdentifier: pid as i32]
        }
    }

    pub fn hide_office(pid: u32, hidden: bool) {
        let app = running_app(pid);
        if app.is_null() {
            return;
        }
        unsafe {
            if hidden {
                let _: bool = msg_send![app, hide];
            } else {
                let _: bool = msg_send![app, unhide];
            }
        }
    }

    pub fn focus_pid(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        let app = running_app(pid);
        if app.is_null() {
            return false;
        }
        unsafe {
            // NSApplicationActivateIgnoringOtherApps = 1 << 1
            let _: bool = msg_send![app, activateWithOptions: 2u64];
        }
        true
    }

    pub fn apply_chrome(b: WindowBuilder) -> WindowBuilder {
        b
    }

    pub fn set_no_activate(_window: &Window) {}

    fn round_corners(window: &Window, radius: f64) {
        unsafe {
            let w = window.ns_window() as *mut AnyObject;
            if w.is_null() {
                return;
            }
            let _: () = msg_send![w, setOpaque: false];
            let clear: *mut AnyObject = msg_send![class!(NSColor), clearColor];
            let _: () = msg_send![w, setBackgroundColor: clear];
            let view: *mut AnyObject = msg_send![w, contentView];
            if view.is_null() {
                return;
            }
            let _: () = msg_send![view, setWantsLayer: true];
            let layer: *mut AnyObject = msg_send![view, layer];
            if !layer.is_null() {
                let _: () = msg_send![layer, setCornerRadius: radius];
                let _: () = msg_send![layer, setMasksToBounds: true];
            }
        }
    }

    pub fn region_round(window: &Window, _w: f64, _h: f64, radius: f64) {
        round_corners(window, radius);
    }

    pub fn region_circle(window: &Window, d: f64) {
        round_corners(window, d / 2.0);
    }

    pub fn set_feed_alpha(window: &Window, feed: bool) {
        unsafe {
            let w = window.ns_window() as *mut AnyObject;
            if !w.is_null() {
                let a: f64 = if feed { 0.77 } else { 1.0 };
                let _: () = msg_send![w, setAlphaValue: a];
            }
        }
    }

    pub fn webview_extras<'a>(b: wry::WebViewBuilder<'a>) -> wry::WebViewBuilder<'a> {
        b
    }

    fn plist_path() -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        PathBuf::from(home).join("Library").join("LaunchAgents")
            .join("com.bagidea.office.plist")
    }

    pub fn is_autostart() -> bool {
        plist_path().exists()
    }

    pub fn set_autostart(on: bool) {
        let p = plist_path();
        if on {
            if let Ok(exe) = std::env::current_exe() {
                let _ = std::fs::create_dir_all(p.parent().unwrap());
                let body = format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\"><dict>\n\
  <key>Label</key><string>com.bagidea.office</string>\n\
  <key>ProgramArguments</key><array><string>{}</string></array>\n\
  <key>RunAtLoad</key><true/>\n\
</dict></plist>\n",
                    exe.to_string_lossy()
                );
                let _ = std::fs::write(&p, body);
            }
        } else {
            let _ = std::fs::remove_file(&p);
        }
    }

    pub fn restore_wallpaper() {}
}

// =====================================================================
//  Fallback platform stub (other unixes) — keeps the crate compiling.
// =====================================================================
#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::UserEvent;
    use std::path::PathBuf;
    use std::process::Command;
    use tao::window::{Window, WindowBuilder};

    pub const AUTOSTART_LABEL: &str = "Start at login";
    pub fn godot_exe(_root: &PathBuf) -> String {
        std::env::var("BAGIDEA_GODOT").unwrap_or_else(|_| "godot".into())
    }
    pub fn office_args(c: &mut Command, root: &PathBuf, _cx: i32, _cy: i32) {
        c.args(["--path"]).arg(root.join("godot")).args(["--", "--wallpaper"]);
    }
    pub fn ensure_single_instance() -> bool { true }
    pub fn spawn_hotkey_thread(_p: tao::event_loop::EventLoopProxy<UserEvent>) {}
    pub fn rebind_hotkey(_s: &str) {}
    pub fn attach_wallpaper_when_ready(_pid: u32, proxy: tao::event_loop::EventLoopProxy<UserEvent>) {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(4));
            let _ = proxy.send_event(UserEvent::WorldReady);
        });
    }
    pub fn hide_office(_pid: u32, _hidden: bool) {}
    pub fn focus_pid(_pid: u32) -> bool { false }
    pub fn apply_chrome(b: WindowBuilder) -> WindowBuilder { b }
    pub fn set_no_activate(_w: &Window) {}
    pub fn region_round(_w: &Window, _a: f64, _b: f64, _r: f64) {}
    pub fn region_circle(_w: &Window, _d: f64) {}
    pub fn set_feed_alpha(_w: &Window, _f: bool) {}
    pub fn webview_extras<'a>(b: wry::WebViewBuilder<'a>) -> wry::WebViewBuilder<'a> { b }
    pub fn is_autostart() -> bool { false }
    pub fn set_autostart(_on: bool) {}
    pub fn restore_wallpaper() {}
}

// --------------------------------------------------------------------- helpers
/// Build one of the frameless chrome windows (splash / overlay / orb).
fn chrome_window(
    el: &tao::event_loop::EventLoop<UserEvent>,
    title: &str,
    w: f64,
    h: f64,
    x: f64,
    y: f64,
    icon: Option<Icon>,
) -> Window {
    let mut b = WindowBuilder::new()
        .with_title(title)
        .with_inner_size(LogicalSize::new(w, h))
        .with_position(LogicalPosition::new(x, y))
        .with_decorations(false)
        .with_resizable(false)
        .with_always_on_top(true);
    if let Some(ic) = icon {
        b = b.with_window_icon(Some(ic));
    }
    b = platform::apply_chrome(b);
    b.build(el).expect("window")
}

// --------------------------------------------------------------------- main
fn main() {
    // Single instance: a second launch exits immediately.
    if !platform::ensure_single_instance() {
        return;
    }

    use wry::WebViewBuilder;

    // ---- boot the whole stack
    let root = project_root();
    let mut daemon_child = spawn_daemon(&root);
    if daemon_child.is_some() {
        std::thread::sleep(std::time::Duration::from_millis(800));
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let (phys_w, phys_h) = event_loop
        .primary_monitor()
        .map(|m| (m.size().width as i32, m.size().height as i32))
        .unwrap_or((1920, 1080));
    let mut office_child = spawn_office(&root, phys_w / 2, phys_h / 2 - 30);
    if let Some(child) = office_child.as_ref() {
        platform::attach_wallpaper_when_ready(child.id(), proxy.clone());
    }

    let _ = std::fs::write(std::env::temp_dir().join("bagidea_shell_alive"), "1");
    watch_editor_requests(proxy.clone());

    // ---- system tray: the only true exit
    let tray_menu = Menu::new();
    let open_item = MenuItem::new("Open Office Chat", true, None);
    let hide_item = CheckMenuItem::new("Hide office (agents keep working)", true, false, None);
    let autostart_item = CheckMenuItem::new(platform::AUTOSTART_LABEL, true, platform::is_autostart(), None);
    let exit_item = MenuItem::new("Exit BagIdea Office", true, None);
    let _ = tray_menu.append_items(&[
        &open_item,
        &hide_item,
        &autostart_item,
        &PredefinedMenuItem::separator(),
        &exit_item,
    ]);
    let _tray = TrayIconBuilder::new()
        .with_menu(Box::new(tray_menu))
        .with_tooltip("BagIdea Office")
        .with_icon(tray_app_icon().expect("tray icon"))
        .build()
        .expect("tray");
    let open_id = open_item.id().clone();
    let hide_id = hide_item.id().clone();
    let autostart_id = autostart_item.id().clone();
    let exit_id = exit_item.id().clone();

    platform::spawn_hotkey_thread(event_loop.create_proxy());

    let office_pid = office_child.as_ref().map(|c| c.id()).unwrap_or(0);

    // ---- screen-aware default positions
    let (screen_w, screen_h, sf) = event_loop
        .primary_monitor()
        .map(|m| (m.size().width as f64, m.size().height as f64, m.scale_factor()))
        .unwrap_or((1920.0, 1080.0, 1.0));
    let logical_w = screen_w / sf;
    let logical_h = screen_h / sf;
    let orb_x = logical_w - ORB_SIZE * 2.0;
    let orb_y = ORB_SIZE;
    let overlay_x = (logical_w - FULL.0 - ORB_SIZE * 2.2).max(20.0);
    let overlay_y = 90.0;
    let feed_h = (logical_h * 0.5).clamp(320.0, 560.0);
    let feed_x = logical_w - FEED_W - 8.0;
    let feed_y = logical_h - feed_h - 64.0;

    // ---- boot splash: a pulsing circular logo, centered
    let splash = chrome_window(
        &event_loop, "BagIdea", SPLASH_SIZE, SPLASH_SIZE,
        (logical_w - SPLASH_SIZE) / 2.0, (logical_h - SPLASH_SIZE) / 2.0 - 30.0, None,
    );
    platform::set_no_activate(&splash);
    let _splash_view = WebViewBuilder::new()
        .with_html(SPLASH_HTML)
        .build(&splash)
        .expect("splash webview");
    platform::region_circle(&splash, SPLASH_SIZE);
    let splash_id = splash.id();

    // ---- overlay (born visible but parked off-screen)
    let overlay = chrome_window(
        &event_loop, "BagIdea Office", FULL.0, FULL.1, PARK.0, PARK.1, app_icon(),
    );
    overlay.set_outer_position(LogicalPosition::new(PARK.0, PARK.1));
    let overlay_id = overlay.id();
    let p_overlay = proxy.clone();
    let overlay_view = platform::webview_extras(
        WebViewBuilder::new()
            .with_url("http://127.0.0.1:8787/")
            .with_devtools(true)
            .with_ipc_handler(move |req| {
                let _ = match req.body().as_str() {
                    "drag-overlay" => p_overlay.send_event(UserEvent::DragOverlay),
                    "hide" => p_overlay.send_event(UserEvent::HideOverlay),
                    "mini" => p_overlay.send_event(UserEvent::MiniToggle),
                    s if s.starts_with("hotkey:") =>
                        p_overlay.send_event(UserEvent::SetHotkey(s[7..].to_string())),
                    _ => Ok(()),
                };
            }))
        .build(&overlay)
        .expect("overlay webview");
    platform::region_round(&overlay, FULL.0, FULL.1, 18.0);

    // ---- circular chat head
    let orb = chrome_window(
        &event_loop, "BagIdea", ORB_SIZE, ORB_SIZE, orb_x, orb_y, app_icon(),
    );
    platform::set_no_activate(&orb);
    let orb_id = orb.id();
    let p_orb = proxy.clone();
    let _orb_view = WebViewBuilder::new()
        .with_html(ORB_HTML)
        .with_ipc_handler(move |req| {
            let _ = match req.body().as_str() {
                "toggle" => p_orb.send_event(UserEvent::Toggle),
                "drag-orb" => p_orb.send_event(UserEvent::DragOrb),
                "mode" => p_orb.send_event(UserEvent::FeedToggle),
                _ => Ok(()),
            };
        })
        .build(&orb)
        .expect("orb webview");
    platform::region_circle(&orb, ORB_SIZE);
    orb.set_outer_position(LogicalPosition::new(PARK.0, PARK.1 + 200.0));

    let raise_orb = |orb: &Window| {
        orb.set_always_on_top(false);
        orb.set_always_on_top(true);
    };

    let mut mini = false;
    let mut feed = false;
    let mut editor_pid: u32 = 0;
    let mut world_ready = false;
    let mut last_watch = std::time::Instant::now();
    let mut last_ptt = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_secs(10))
        .unwrap_or_else(std::time::Instant::now);
    event_loop.run(move |event, _, control_flow| {
        // A slow poll tick keeps the tray channels live without pinning a core.
        *control_flow = ControlFlow::WaitUntil(
            std::time::Instant::now() + std::time::Duration::from_millis(250));

        // Chat-head watchdog — THROTTLED. Re-asserting window state every tick
        // pins a CPU core on macOS (each level/visibility poke wakes the loop),
        // so we only check every ~2s and only touch the window when the orb has
        // genuinely drifted off-screen after the world is up.
        if world_ready && !hide_item.is_checked()
            && last_watch.elapsed().as_millis() >= 2000
        {
            last_watch = std::time::Instant::now();
            let off = orb.outer_position().map(|p| p.x < -2000).unwrap_or(false);
            if off {
                orb.set_outer_position(LogicalPosition::new(orb_x, orb_y));
                orb.set_visible(true);
                raise_orb(&orb);
            }
        }

        let mut shutdown = false;
        let mut toggle = false;

        while let Ok(ev) = MenuEvent::receiver().try_recv() {
            if ev.id == exit_id {
                shutdown = true;
            } else if ev.id == open_id {
                toggle = true;
            } else if ev.id == hide_id {
                let hidden = hide_item.is_checked();
                platform::hide_office(office_pid, hidden);
                if hidden {
                    overlay.set_outer_position(LogicalPosition::new(PARK.0, PARK.1));
                    orb.set_outer_position(LogicalPosition::new(PARK.0, PARK.1 + 200.0));
                } else {
                    orb.set_outer_position(LogicalPosition::new(orb_x, orb_y));
                    raise_orb(&orb);
                }
                post_visibility(!hidden);
            } else if ev.id == autostart_id {
                platform::set_autostart(autostart_item.is_checked());
            }
        }

        while let Ok(ev) = TrayIconEvent::receiver().try_recv() {
            if let TrayIconEvent::Click { button: tray_icon::MouseButton::Left, button_state: tray_icon::MouseButtonState::Up, .. } = ev {
                toggle = true;
            }
        }

        let do_toggle = |feed_now: bool| {
            let hidden = overlay
                .outer_position()
                .map(|p| p.x < -2000)
                .unwrap_or(true);
            if hidden {
                let (px, py) = if feed_now { (feed_x, feed_y) } else { (overlay_x, overlay_y) };
                overlay.set_outer_position(LogicalPosition::new(px, py));
                overlay.set_focus();
                raise_orb(&orb);
            } else {
                overlay.set_outer_position(LogicalPosition::new(PARK.0, PARK.1));
            }
            let _ = &overlay_view;
        };

        if toggle {
            do_toggle(feed);
        }

        match event {
            Event::WindowEvent { window_id, event: WindowEvent::CloseRequested, .. } => {
                if window_id == overlay_id {
                    overlay.set_outer_position(LogicalPosition::new(PARK.0, PARK.1));
                }
            }
            Event::WindowEvent { window_id, event: WindowEvent::Focused(true), .. } => {
                if window_id == overlay_id {
                    raise_orb(&orb);
                }
            }
            Event::WindowEvent { window_id, event: WindowEvent::Resized(_), .. } => {
                if window_id == orb_id {
                    platform::region_circle(&orb, ORB_SIZE);
                } else if window_id == overlay_id {
                    let (w, h) = if feed { (FEED_W, feed_h) } else if mini { MINI } else { FULL };
                    platform::region_round(&overlay, w, h, if feed { 14.0 } else { 18.0 });
                } else if window_id == splash_id {
                    platform::region_circle(&splash, SPLASH_SIZE);
                }
            }
            Event::UserEvent(ue) => match ue {
                UserEvent::WorldReady => {
                    world_ready = true;
                    splash.set_visible(false);
                    orb.set_outer_position(LogicalPosition::new(orb_x, orb_y));
                    raise_orb(&orb);
                }
                UserEvent::EditorOpening => {
                    if platform::focus_pid(editor_pid) {
                        let _ = std::fs::write(std::env::temp_dir().join("bagidea_editor_ready"), "focused");
                    } else {
                        editor_pid = 0;
                        splash.set_visible(true);
                        splash.set_always_on_top(true);
                        if let Some(child) = spawn_editor(&root, phys_w / 2, phys_h / 2 - 30) {
                            editor_pid = child.id();
                        }
                    }
                }
                UserEvent::EditorReady => {
                    splash.set_visible(false);
                }
                UserEvent::Toggle => do_toggle(feed),
                UserEvent::HideOverlay => {
                    overlay.set_outer_position(LogicalPosition::new(PARK.0, PARK.1));
                }
                UserEvent::MiniToggle => {
                    if !feed {
                        mini = !mini;
                        let (w, h) = if mini { MINI } else { FULL };
                        overlay.set_inner_size(LogicalSize::new(w, h));
                        platform::region_round(&overlay, w, h, 18.0);
                        raise_orb(&orb);
                    }
                }
                UserEvent::FeedToggle => {
                    feed = !feed;
                    let _ = overlay_view.evaluate_script(&format!(
                        "window.setFeedMode && setFeedMode({})", feed));
                    let _ = overlay.set_ignore_cursor_events(false);
                    platform::set_feed_alpha(&overlay, feed);
                    if feed {
                        overlay.set_inner_size(LogicalSize::new(FEED_W, feed_h));
                        overlay.set_outer_position(LogicalPosition::new(feed_x, feed_y));
                        platform::region_round(&overlay, FEED_W, feed_h, 14.0);
                    } else {
                        let (w, h) = if mini { MINI } else { FULL };
                        overlay.set_inner_size(LogicalSize::new(w, h));
                        overlay.set_outer_position(LogicalPosition::new(overlay_x, overlay_y));
                        platform::region_round(&overlay, w, h, 18.0);
                    }
                    raise_orb(&orb);
                }
                UserEvent::DragOrb => { let _ = orb.drag_window(); }
                UserEvent::DragOverlay => { let _ = overlay.drag_window(); }
                UserEvent::PttKey(pressed) => {
                    if pressed && last_ptt.elapsed().as_millis() >= 600 {
                        last_ptt = std::time::Instant::now();
                        let hidden = overlay
                            .outer_position()
                            .map(|p| p.x < -2000)
                            .unwrap_or(true);
                        if hidden {
                            let (px, py) = if feed {
                                (feed_x, feed_y)
                            } else {
                                (overlay_x, overlay_y)
                            };
                            overlay.set_outer_position(LogicalPosition::new(px, py));
                            raise_orb(&orb);
                        }
                        let _ = overlay_view
                            .evaluate_script("window.pttToggle && pttToggle()");
                        ptt_beacon("toggle");
                    }
                }
                UserEvent::SetHotkey(s) => platform::rebind_hotkey(&s),
            },
            _ => {}
        }

        if shutdown {
            if let Some(c) = office_child.as_mut() {
                let _ = c.kill();
            }
            if let Some(c) = daemon_child.as_mut() {
                let _ = c.kill();
            }
            platform::restore_wallpaper();
            *control_flow = ControlFlow::Exit;
        }
    });
}
