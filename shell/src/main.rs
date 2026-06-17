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
use std::sync::atomic::{AtomicBool, Ordering};

// Flipped true the moment the user quits from the tray, so the daemon watchdog
// stops resurrecting the daemon we're deliberately tearing down.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

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
    OpenWindow(String), // pop a custom-chrome window onto a daemon URL (plugin / viewer)
    PopupDrag(tao::window::WindowId),  // a pop-out's title bar is being dragged
    PopupClose(tao::window::WindowId), // a pop-out asked to close itself
    PopupMin(tao::window::WindowId),   // minimize (พัก)
    PopupMax(tao::window::WindowId),   // toggle maximize / restore
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
<html><body style="margin:0;overflow:hidden;background:transparent">
<img src="__LOGO__" draggable="false"
     style="position:absolute;left:0;top:0;width:100%;height:100%;animation:p 1.5s ease-in-out infinite">
<style>@keyframes p{0%,100%{transform:scale(1)}50%{transform:scale(0.92)}}</style>
</body></html>"#;

const ORB_HTML: &str = r#"<!doctype html>
<html><body style="margin:0;overflow:hidden;background:transparent;user-select:none;-webkit-user-select:none;cursor:pointer">
<div id="ring"></div>
<img id="logo" src="__LOGO__" draggable="false">
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

// The orb's logo is EMBEDDED in the binary as a data: URI rather than fetched from the
// daemon over HTTP. On a cold boot the shell paints the orb before the daemon's web
// server is up, so an HTTP <img> would 404 and the orb would sit dark until a manual
// restart. Baking the bytes in removes that dependency entirely — the orb always shows.
fn logo_data_uri() -> String {
    const LOGO: &[u8] = include_bytes!("../../logo_ico_cute.png");
    format!("data:image/png;base64,{}", base64_encode(LOGO))
}
fn orb_html() -> String { ORB_HTML.replace("__LOGO__", &logo_data_uri()) }
fn splash_html() -> String { SPLASH_HTML.replace("__LOGO__", &logo_data_uri()) }

fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let n = ((chunk[0] as u32) << 16)
            | ((*chunk.get(1).unwrap_or(&0) as u32) << 8)
            | (*chunk.get(2).unwrap_or(&0) as u32);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

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
    // A release GUI shell has NO console (windows_subsystem="windows"), so an
    // INHERITED stdout/stderr is an invalid handle and node can crash on its
    // first write — taking the daemon down seconds after launch. Send the
    // daemon's output to daemon/daemon.log instead: keeps it alive AND gives a
    // log to read. Fall back to /dev/null-equivalent if the file can't open.
    use std::process::Stdio;
    match std::fs::File::create(root.join("daemon").join("daemon.log")) {
        Ok(f) => {
            match f.try_clone() {
                Ok(f2) => { c.stdout(Stdio::from(f)).stderr(Stdio::from(f2)); }
                Err(_) => { c.stdout(Stdio::from(f)).stderr(Stdio::null()); }
            }
        }
        Err(_) => { c.stdout(Stdio::null()).stderr(Stdio::null()); }
    }
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

/// Tell the daemon how many monitors we detected, so the overlay shows a display
/// picker only on multi-monitor (and with the right count). Fire-and-forget.
fn post_monitor_count(count: usize) {
    let mut c = Command::new("curl");
    c.args(["-s", "-X", "POST", "http://127.0.0.1:8787/ui/monitors",
        "-H", "content-type: application/json",
        "-d", &format!("{{\"count\":{}}}", count)]);
    let _ = hidden(&mut c).spawn();
}

/// Ask the daemon to relaunch the whole stack (it does the detached restart that
/// survives killing us). Used by the tray "Restart office" item.
fn post_restart() {
    let mut c = Command::new("curl");
    c.args(["-s", "-X", "POST", "http://127.0.0.1:8787/ui/restart",
        "-H", "content-type: application/json", "-H", "x-bagidea-ui: 1"]);
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
    // Hold-to-talk via a low-level keyboard hook: the bound key, whether it's
    // currently held (to swallow auto-repeat), and a proxy the C callback can
    // reach to fire PttKey(down/up) into the event loop.
    static PTT_VK: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0x75); // VK_F6
    static PTT_DOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    // True while the user has hidden the office from the tray — the re-pin
    // watcher (issue #7) must NOT fight that by re-showing the window.
    static WALLPAPER_HIDDEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static PTT_PROXY: std::sync::Mutex<Option<tao::event_loop::EventLoopProxy<super::UserEvent>>> =
        std::sync::Mutex::new(None);

    fn ptt_send(down: bool) {
        if let Ok(g) = PTT_PROXY.lock() {
            if let Some(p) = g.as_ref() {
                let _ = p.send_event(super::UserEvent::PttKey(down));
            }
        }
    }

    // Low-level keyboard hook proc — sees every key, acts only on the bound one,
    // and ALWAYS chains so normal typing is never blocked or delayed.
    unsafe extern "system" fn ll_kbd(code: i32, wparam: usize, lparam: isize) -> isize {
        use std::sync::atomic::Ordering;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CallNextHookEx, HC_ACTION, KBDLLHOOKSTRUCT, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN,
            WM_SYSKEYUP,
        };
        if code == HC_ACTION as i32 && !lparam_is_null(lparam) {
            let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
            if kb.vkCode == PTT_VK.load(Ordering::Relaxed) {
                let w = wparam as u32;
                if w == WM_KEYDOWN || w == WM_SYSKEYDOWN {
                    if !PTT_DOWN.swap(true, Ordering::SeqCst) {
                        ptt_send(true);
                    }
                } else if w == WM_KEYUP || w == WM_SYSKEYUP {
                    if PTT_DOWN.swap(false, Ordering::SeqCst) {
                        ptt_send(false);
                    }
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }
    fn lparam_is_null(l: isize) -> bool { l == 0 }

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
                // single keys that suit hold-to-talk (the low-level hook reports
                // the distinct left/right vkCodes, so Right Ctrl matches only the
                // right key). Right Ctrl is the recommended default — rarely typed.
                "rctrl" | "rightctrl" | "right ctrl" => vk = Some(0xA3), // VK_RCONTROL
                "ralt" | "rightalt" | "right alt" => vk = Some(0xA5),   // VK_RMENU
                "rshift" | "rightshift" => vk = Some(0xA1),             // VK_RSHIFT
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
        if let Some((_m, v)) = parse_vk("rctrl") {
            PTT_VK.store(v, std::sync::atomic::Ordering::SeqCst);
        }
        // The C hook callback reaches the event loop through this static.
        if let Ok(mut g) = PTT_PROXY.lock() { *g = Some(proxy); }
        std::thread::spawn(move || unsafe {
            use std::sync::atomic::Ordering;
            use windows_sys::Win32::System::Threading::GetCurrentThreadId;
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx, MSG, WH_KEYBOARD_LL, WM_APP,
            };
            PTT_THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);
            // A low-level keyboard hook delivers BOTH key-down and key-up, which
            // RegisterHotKey never did (press-only → the old press-to-start /
            // press-to-stop toggle). The hook callback is dispatched on the
            // thread that installed it, so we must keep pumping messages here.
            let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(ll_kbd), std::ptr::null_mut(), 0);
            ptt_beacon(if hook.is_null() { "register-FAILED" } else { "registered" });
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                if msg.message == WM_APP {
                    // rebind: switch the watched key (lParam carries the new vk).
                    let vk = msg.lParam as u32;
                    if vk != 0 {
                        PTT_VK.store(vk, Ordering::SeqCst);
                        PTT_DOWN.store(false, Ordering::SeqCst);
                        ptt_beacon("rehook-ok");
                    } else {
                        ptt_beacon("rehook-none");
                    }
                }
            }
            if !hook.is_null() {
                UnhookWindowsHookEx(hook);
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

    /// Place the wallpaper window over the chosen monitor (default: primary),
    /// in WorkerW client coords. WorkerW spans the whole virtual desktop, so its
    /// origin is the virtual-screen origin. Without this the reparented window
    /// kept Godot's (0,0)+primary-size guess, which on a multi-monitor setup
    /// lands on the wrong monitor (or off-screen) — so the wallpaper never
    /// appeared. `BAGIDEA_MONITOR=<index>` (0 = primary) picks another monitor.
    /// All monitors as (left, top, w, h, is_primary), PRIMARY FIRST (so index 0
    /// is always the primary screen). The single source of truth for both the
    /// count we report to the UI and where we place the wallpaper.
    pub fn enum_monitors() -> Vec<(i32, i32, i32, i32, bool)> {
        unsafe {
            use windows_sys::Win32::Foundation::{LPARAM, RECT};
            use windows_sys::Win32::Graphics::Gdi::{
                EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
            };
            struct Mons { v: Vec<(i32, i32, i32, i32, bool)> }
            unsafe extern "system" fn cb(h: HMONITOR, _dc: HDC, _r: *mut RECT, lp: LPARAM) -> i32 {
                let m = &mut *(lp as *mut Mons);
                let mut mi: MONITORINFO = std::mem::zeroed();
                mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
                if GetMonitorInfoW(h, &mut mi) != 0 {
                    let r = mi.rcMonitor;
                    m.v.push((r.left, r.top, r.right - r.left, r.bottom - r.top, mi.dwFlags & 1 != 0));
                }
                1
            }
            let mut mons = Mons { v: Vec::new() };
            EnumDisplayMonitors(0 as HDC, std::ptr::null(), Some(cb), &mut mons as *mut Mons as LPARAM);
            mons.v.sort_by_key(|m| !m.4); // primary first → index 0 is always primary
            mons.v
        }
    }

    fn position_wallpaper(godot: HWND, root: &std::path::Path) {
        unsafe {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                GetSystemMetrics, MoveWindow, SM_CXSCREEN, SM_CYSCREEN, SM_XVIRTUALSCREEN,
                SM_YVIRTUALSCREEN,
            };
            let mons = enum_monitors();
            // Chosen monitor: daemon/monitor.txt (set from the in-app picker) wins,
            // then the BAGIDEA_MONITOR env, else 0 (primary). Plain int — no JSON dep.
            let idx = std::fs::read_to_string(root.join("daemon").join("monitor.txt"))
                .ok()
                .and_then(|s| s.trim().parse::<usize>().ok())
                .or_else(|| std::env::var("BAGIDEA_MONITOR").ok().and_then(|s| s.trim().parse::<usize>().ok()))
                .unwrap_or(0);
            let vsx = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let vsy = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let (left, top, w, h) = mons
                .get(idx)
                .or_else(|| mons.first())
                .map(|&(l, t, w, h, _)| (l, t, w, h))
                .unwrap_or((0, 0, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)));
            // WorkerW client origin = virtual-screen origin → subtract it.
            MoveWindow(godot, left - vsx, top - vsy, w, h, 1);
        }
    }

    pub fn attach_wallpaper_when_ready(pid: u32, root: PathBuf, proxy: tao::event_loop::EventLoopProxy<UserEvent>) {
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
            // Detect how many monitors there really are and tell the daemon, so the
            // UI shows a display picker ONLY on multi-monitor (and lists the right
            // count). Writing monitors.txt also lets the daemon report it on connect.
            let count = enum_monitors().len().max(1);
            let _ = std::fs::write(root.join("daemon").join("monitors.txt"), count.to_string());
            super::post_monitor_count(count);
            // Single monitor → leave the embed ALONE (the original rock-solid path
            // that survives Win+D / desktop clicks; no MoveWindow, no watcher).
            // Multi-monitor → place it on the chosen screen (default = primary), a
            // ONE-TIME position so a fresh multi-monitor setup just works on boot.
            if count > 1 {
                position_wallpaper(godot, &root);
            }
            let _ = proxy.send_event(UserEvent::WorldReady);
        });
    }

    pub fn hide_office(pid: u32, hidden: bool) {
        // Tell the re-pin watcher to stand down while the user keeps it hidden.
        WALLPAPER_HIDDEN.store(hidden, std::sync::atomic::Ordering::SeqCst);
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

    /// Register the `bagidea://` URL protocol (per-user) so the website's
    /// "Open in office" Install button launches us with the deep link. Idempotent
    /// — written on every normal startup so it self-heals after a move/reinstall.
    pub fn register_uri_scheme() {
        let exe = match std::env::current_exe() {
            Ok(e) => e.to_string_lossy().into_owned(),
            Err(_) => return,
        };
        let base = r"HKCU\Software\Classes\bagidea";
        let run = |args: &[&str]| {
            let mut c = Command::new("reg");
            c.args(args);
            let _ = super::hidden(&mut c).status();
        };
        run(&["add", base, "/ve", "/t", "REG_SZ", "/d", "URL:BagIdea Office", "/f"]);
        run(&["add", base, "/v", "URL Protocol", "/t", "REG_SZ", "/d", "", "/f"]);
        let cmd_key = format!(r"{}\shell\open\command", base);
        let cmd_val = format!("\"{}\" \"%1\"", exe);
        run(&["add", &cmd_key, "/ve", "/t", "REG_SZ", "/d", &cmd_val, "/f"]);
    }

    // Scan state for `occl_cb` — an EnumWindows pass that flips `occluded` true
    // the moment any normal window covers the primary monitor.
    struct OcclScan { own_pid: u32, occluded: bool }

    unsafe extern "system" fn occl_cb(h: HWND, lp: windows_sys::Win32::Foundation::LPARAM) -> i32 {
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONULL,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetWindowRect, IsIconic};
        let scan = &mut *(lp as *mut OcclScan);
        // Skip hidden, minimized, and our own (the wallpaper) windows.
        if IsWindowVisible(h) == 0 || IsIconic(h) != 0 {
            return 1;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, &mut pid);
        if pid == scan.own_pid {
            return 1;
        }
        // Skip the desktop shell itself (Progman / WorkerW / SHELLDLL_DefView) —
        // those ARE full-screen and would always read as "covered".
        let mut cls = [0u16; 32];
        let n = GetClassNameW(h, cls.as_mut_ptr(), cls.len() as i32);
        let name = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
        if name == "Progman" || name == "WorkerW" || name == "SHELLDLL_DefView" {
            return 1;
        }
        // Only windows on the PRIMARY monitor (where the wallpaper lives) count;
        // a full-screen app on a second monitor leaves the wallpaper visible.
        let mon = MonitorFromWindow(h, MONITOR_DEFAULTTONULL);
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(mon, &mut mi) == 0 {
            return 1;
        }
        if mi.dwFlags & 1 == 0 { // 1 = MONITORINFOF_PRIMARY
            return 1;
        }
        let mut wr: RECT = std::mem::zeroed();
        if GetWindowRect(h, &mut wr) == 0 {
            return 1;
        }
        let mw = (mi.rcMonitor.right - mi.rcMonitor.left) as f64;
        let mh = (mi.rcMonitor.bottom - mi.rcMonitor.top) as f64;
        let ww = (wr.right - wr.left) as f64;
        let hh = (wr.bottom - wr.top) as f64;
        // Maximized leaves the taskbar (~4%) uncovered: ≥98% width, ≥88% height.
        if ww >= mw * 0.98 && hh >= mh * 0.88 {
            scan.occluded = true;
            return 0; // found a coverer — stop enumerating
        }
        1
    }

    /// True when ANY normal window — not just the focused one — covers the
    /// primary monitor. Mirrors the macOS CGWindowList scan, so a maximized
    /// window that lost focus to a small floating window still throttles the
    /// wallpaper (a foreground-only check would miss that, wasting CPU).
    pub fn desktop_occluded(_lw: f64, _lh: f64, own_pid: u32) -> bool {
        let mut scan = OcclScan { own_pid, occluded: false };
        unsafe { EnumWindows(Some(occl_cb), &mut scan as *mut OcclScan as _); }
        scan.occluded
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
    use objc2_foundation::NSString;
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
    pub fn attach_wallpaper_when_ready(_pid: u32, _root: PathBuf, proxy: tao::event_loop::EventLoopProxy<UserEvent>) {
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

    // macOS deep-link registration is declared in the app bundle's Info.plist
    // (CFBundleURLTypes), not at runtime — so this is a no-op here.
    pub fn register_uri_scheme() {}

    /// True when a foreground app window (nearly) covers the whole screen, so
    /// the wallpaper is invisible and the renderer can crawl. Considers only
    /// layer-0 windows (skips the menu bar, Dock, and our desktop-level Godot
    /// embed) and ignores windows owned by `own_pid` (the wallpaper itself).
    /// `lw`/`lh` are the screen size in points — CGWindow bounds are in points.
    pub fn desktop_occluded(lw: f64, lh: f64, own_pid: u32) -> bool {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGWindowListCopyWindowInfo(option: u32, relative: u32) -> *mut AnyObject;
            static kCGWindowBounds: *const AnyObject;
            static kCGWindowLayer: *const AnyObject;
            static kCGWindowOwnerPID: *const AnyObject;
        }
        // kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
        const OPTS: u32 = (1 << 0) | (1 << 4);
        unsafe {
            let list = CGWindowListCopyWindowInfo(OPTS, 0);
            if list.is_null() {
                return false;
            }
            let x_key = NSString::from_str("X");
            let y_key = NSString::from_str("Y");
            let w_key = NSString::from_str("Width");
            let h_key = NSString::from_str("Height");
            let count: usize = msg_send![list, count];
            let mut occluded = false;
            for i in 0..count {
                let win: *mut AnyObject = msg_send![list, objectAtIndex: i];
                let layer_n: *mut AnyObject = msg_send![win, objectForKey: kCGWindowLayer];
                if layer_n.is_null() {
                    continue;
                }
                let layer: i64 = msg_send![layer_n, longLongValue];
                if layer != 0 {
                    continue; // menu bar / Dock / desktop-level embed
                }
                let pid_n: *mut AnyObject = msg_send![win, objectForKey: kCGWindowOwnerPID];
                if !pid_n.is_null() {
                    let pid: i64 = msg_send![pid_n, longLongValue];
                    if pid as u32 == own_pid {
                        continue; // the wallpaper window itself
                    }
                }
                let bounds: *mut AnyObject = msg_send![win, objectForKey: kCGWindowBounds];
                if bounds.is_null() {
                    continue;
                }
                let xn: *mut AnyObject = msg_send![bounds, objectForKey: &*x_key];
                let yn: *mut AnyObject = msg_send![bounds, objectForKey: &*y_key];
                let wn: *mut AnyObject = msg_send![bounds, objectForKey: &*w_key];
                let hn: *mut AnyObject = msg_send![bounds, objectForKey: &*h_key];
                if xn.is_null() || yn.is_null() || wn.is_null() || hn.is_null() {
                    continue;
                }
                let wx: f64 = msg_send![xn, doubleValue];
                let wy: f64 = msg_send![yn, doubleValue];
                let ww: f64 = msg_send![wn, doubleValue];
                let hh: f64 = msg_send![hn, doubleValue];
                // The primary monitor always contains the origin (0,0); a window
                // on a secondary monitor has X or Y far from it. Only occlude when
                // the coverer sits on the primary (where the wallpaper lives).
                if wx.abs() > lw * 0.5 || wy.abs() > lh * 0.5 {
                    continue;
                }
                // A maximized window leaves the menu bar (~3%) and possibly the
                // Dock uncovered, so ≥98% width and ≥88% height counts as covered.
                if ww >= lw * 0.98 && hh >= lh * 0.88 {
                    occluded = true;
                    break;
                }
            }
            let _: () = msg_send![list, release];
            occluded
        }
    }
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
    pub fn attach_wallpaper_when_ready(_pid: u32, _root: PathBuf, proxy: tao::event_loop::EventLoopProxy<UserEvent>) {
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
    pub fn register_uri_scheme() {}
    pub fn desktop_occluded(_lw: f64, _lh: f64, _own_pid: u32) -> bool { false }
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
    transparent: bool,
) -> Window {
    let mut b = WindowBuilder::new()
        .with_title(title)
        .with_inner_size(LogicalSize::new(w, h))
        .with_position(LogicalPosition::new(x, y))
        .with_decorations(false)
        .with_resizable(false)
        .with_always_on_top(true);
    // Per-pixel alpha so a rounded/circular shape comes from the page's anti-aliased
    // CSS border-radius — NOT a hard-edged SetWindowRgn clip (which looks jagged).
    if transparent {
        b = b.with_transparent(true);
    }
    if let Some(ic) = icon {
        b = b.with_window_icon(Some(ic));
    }
    b = platform::apply_chrome(b);
    b.build(el).expect("window")
}

// --------------------------------------------------------------------- main
// Hand a `bagidea://install?repo=<url>` deep link to the running office over the
// daemon's localhost port. We don't install here — the daemon broadcasts an
// intent and the office UI asks the user to confirm. Returns true if delivered.
fn forward_deep_link(url: &str) -> bool {
    use std::io::{Read, Write};
    let rest = url.trim_start_matches("bagidea://");
    // only the install intent is supported
    let repo = match rest.split_once("repo=") {
        Some((_, r)) => percent_decode(r.split('&').next().unwrap_or("")),
        None => return false,
    };
    if repo.is_empty() {
        return false;
    }
    let body = format!("{{\"repo\":{}}}", json_quote(&repo));
    let req = format!(
        "POST /plugins/intent HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n\
         x-bagidea-ui: 1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    match std::net::TcpStream::connect(("127.0.0.1", 8787)) {
        Ok(mut s) => {
            let _ = s.set_write_timeout(Some(std::time::Duration::from_secs(2)));
            if s.write_all(req.as_bytes()).is_err() {
                return false;
            }
            let _ = s.flush();
            // read a little so the daemon finishes handling before we drop
            let _ = s.set_read_timeout(Some(std::time::Duration::from_millis(700)));
            let mut buf = [0u8; 64];
            let _ = s.read(&mut buf);
            true
        }
        Err(_) => false,
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 3 <= b.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(v) => { out.push(v); i += 3; }
                Err(_) => { out.push(b'%'); i += 1; }
            },
            b'+' => { out.push(b' '); i += 1; }
            c => { out.push(c); i += 1; }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn json_quote(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => {}
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn main() {
    // bagidea:// deep link (the website's "Open in office" Install button)?
    // Hand it to the running office — which asks the user to confirm before
    // installing — then exit. If the office isn't up, the forward fails and we
    // fall through to a normal launch (the office opens; click Install again).
    if let Some(url) = std::env::args().skip(1).find(|a| a.starts_with("bagidea://")) {
        if forward_deep_link(&url) {
            return;
        }
    }

    // Single instance: a second launch exits immediately.
    if !platform::ensure_single_instance() {
        return;
    }
    // Make the website's one-click install reach us (idempotent; self-heals).
    platform::register_uri_scheme();

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
        platform::attach_wallpaper_when_ready(child.id(), root.clone(), proxy.clone());
    }

    let _ = std::fs::write(std::env::temp_dir().join("bagidea_shell_alive"), "1");
    watch_editor_requests(proxy.clone());

    // ---- daemon watchdog: the office must never sit there brainless.
    // If the daemon ever dies (a crash, an OOM, a `bagidea` kill that reached
    // the daemon but not us), bring it straight back. Cheap: a 400ms TCP probe
    // every 5s, and spawn_daemon is a no-op while it's already up. Stops the
    // moment the user quits so we don't fight a deliberate shutdown.
    {
        let root = root.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(5));
            if SHUTTING_DOWN.load(Ordering::Relaxed) {
                break;
            }
            if !daemon_running() && !SHUTTING_DOWN.load(Ordering::Relaxed) {
                let _ = spawn_daemon(&root);
            }
        });
    }

    // ---- system tray: the only true exit
    let tray_menu = Menu::new();
    let open_item = MenuItem::new("Open Office Chat", true, None);
    let hide_item = CheckMenuItem::new("Hide office (agents keep working)", true, false, None);
    let restart_item = MenuItem::new("Restart office", true, None);
    let autostart_item = CheckMenuItem::new(platform::AUTOSTART_LABEL, true, platform::is_autostart(), None);
    let exit_item = MenuItem::new("Exit BagIdea Office", true, None);
    let _ = tray_menu.append_items(&[
        &open_item,
        &hide_item,
        &restart_item,
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
    let restart_id = restart_item.id().clone();
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
        (logical_w - SPLASH_SIZE) / 2.0, (logical_h - SPLASH_SIZE) / 2.0 - 30.0, None, true,
    );
    platform::set_no_activate(&splash);
    let _splash_view = WebViewBuilder::new()
        .with_transparent(true)
        .with_html(splash_html())
        .build(&splash)
        .expect("splash webview");
    let _splash_id = splash.id();

    // ---- overlay (born visible but parked off-screen)
    let overlay = chrome_window(
        &event_loop, "BagIdea Office", FULL.0, FULL.1, PARK.0, PARK.1, app_icon(), false,
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
                    s if s.starts_with("open-window:") =>
                        p_overlay.send_event(UserEvent::OpenWindow(s[12..].to_string())),
                    _ => Ok(()),
                };
            }))
        .build(&overlay)
        .expect("overlay webview");
    platform::region_round(&overlay, FULL.0, FULL.1, 18.0);

    // ---- circular chat head
    let orb = chrome_window(
        &event_loop, "BagIdea", ORB_SIZE, ORB_SIZE, orb_x, orb_y, app_icon(), true,
    );
    platform::set_no_activate(&orb);
    let _orb_id = orb.id();
    let p_orb = proxy.clone();
    let _orb_view = WebViewBuilder::new()
        .with_transparent(true)
        .with_html(orb_html())
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
    orb.set_outer_position(LogicalPosition::new(PARK.0, PARK.1 + 200.0));

    let raise_orb = |orb: &Window| {
        orb.set_always_on_top(false);
        orb.set_always_on_top(true);
    };

    // Pop-out windows (plugin panels / media viewers) opened on demand from the
    // overlay. Held here so their Window + WebView stay alive; dropped on close.
    // Tuple: (window id, single-instance key, window, webview).
    let mut popups: Vec<(tao::window::WindowId, String, Window, wry::WebView)> = Vec::new();
    let mut mini = false;
    let mut feed = false;
    let mut editor_pid: u32 = 0;
    let mut world_ready = false;
    // Tracks whether the wallpaper is believed visible (30 fps) vs throttled
    // (2 fps). Driven by the manual "Hide office" tray item AND auto-occlusion.
    let mut vis_on = true;
    let mut last_watch = std::time::Instant::now();
    event_loop.run(move |event, target, control_flow| {
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
            // NOTE: the auto-occlusion throttle (desktop_occluded → 2 fps when a
            // window covers the wallpaper) is DISABLED. It mis-fired and pinned
            // the renderer at 2 fps (stutter + idle GPU). The detector functions
            // are kept for a future, properly-tested revisit; for now only the
            // manual tray "Hide office" toggle throttles.
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
                vis_on = !hidden;
                post_visibility(!hidden);
            } else if ev.id == restart_id {
                // The daemon does a detached relaunch that outlives us being killed.
                post_restart();
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
                } else {
                    // A pop-out window's native ✕ — drop it (frees Window + WebView).
                    popups.retain(|(id, _, _, _)| *id != window_id);
                }
            }
            Event::WindowEvent { window_id, event: WindowEvent::Focused(true), .. } => {
                if window_id == overlay_id {
                    raise_orb(&orb);
                }
            }
            Event::WindowEvent { window_id, event: WindowEvent::Resized(_), .. } => {
                // orb + splash are transparent — their round shape is CSS (anti-aliased),
                // no SetWindowRgn needed. Only the opaque overlay still gets a clip region.
                if window_id == overlay_id {
                    let (w, h) = if feed { (FEED_W, feed_h) } else if mini { MINI } else { FULL };
                    platform::region_round(&overlay, w, h, if feed { 14.0 } else { 18.0 });
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
                    // True hold-to-talk: key DOWN starts recording, key UP sends.
                    // (The low-level hook fires once per physical press/release.)
                    if pressed {
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
                        let _ = overlay_view.evaluate_script("window.pttSet && pttSet(true)");
                        ptt_beacon("down");
                    } else {
                        let _ = overlay_view.evaluate_script("window.pttSet && pttSet(false)");
                        ptt_beacon("up");
                    }
                }
                UserEvent::SetHotkey(s) => platform::rebind_hotkey(&s),
                UserEvent::OpenWindow(u) => {
                    // u: "/win?src=...&w=900&h=680&resizable=1&key=<id>". Custom
                    // chrome (frameless) so it matches the app + survives streaming.
                    let qval = |name: &str| -> Option<String> {
                        u.split('?').nth(1)?.split('&').find_map(|kv| {
                            let mut it = kv.splitn(2, '=');
                            if it.next()? == name { Some(it.next().unwrap_or("").to_string()) } else { None }
                        })
                    };
                    let key = qval("key").unwrap_or_default();
                    // Single-instance per plugin: already open → surface it, never duplicate.
                    let existing = if key.is_empty() { None }
                        else { popups.iter().position(|(_, k, _, _)| *k == key) };
                    if let Some(ix) = existing {
                        let win = &popups[ix].2;
                        win.set_minimized(false);
                        win.set_visible(true);
                        win.set_focus();
                    } else {
                        let w = qval("w").and_then(|s| s.parse::<f64>().ok()).unwrap_or(900.0);
                        let h = qval("h").and_then(|s| s.parse::<f64>().ok()).unwrap_or(680.0);
                        let resizable = qval("resizable").map(|s| s != "0").unwrap_or(true);
                        let full = if u.starts_with("http") { u.clone() }
                            else { format!("http://127.0.0.1:8787{}", u) };
                        let win = WindowBuilder::new()
                            .with_title("BagIdea Office")
                            .with_inner_size(LogicalSize::new(w, h))
                            .with_min_inner_size(LogicalSize::new(260.0, 180.0))
                            .with_decorations(false)
                            .with_resizable(resizable)
                            .with_window_icon(app_icon())
                            .build(target)
                            .expect("popup window");
                        let id = win.id();
                        // Center on the primary monitor — otherwise the OS scatters
                        // popups to inconsistent spots each time.
                        if let Some(m) = win.primary_monitor() {
                            let ms = m.size();
                            let mp = m.position();
                            let ws = win.outer_size();
                            let cx = mp.x + ((ms.width as i32 - ws.width as i32) / 2).max(0);
                            let cy = mp.y + ((ms.height as i32 - ws.height as i32) / 2).max(0);
                            win.set_outer_position(tao::dpi::PhysicalPosition::new(cx, cy));
                        }
                        let pproxy = proxy.clone();
                        match platform::webview_extras(
                            WebViewBuilder::new()
                                .with_url(&full)
                                .with_ipc_handler(move |req| {
                                    let _ = match req.body().as_str() {
                                        "win-drag" => pproxy.send_event(UserEvent::PopupDrag(id)),
                                        "win-close" => pproxy.send_event(UserEvent::PopupClose(id)),
                                        "win-min" => pproxy.send_event(UserEvent::PopupMin(id)),
                                        "win-max" => pproxy.send_event(UserEvent::PopupMax(id)),
                                        _ => Ok(()),
                                    };
                                }))
                            .build(&win)
                        {
                            Ok(view) => popups.push((id, key, win, view)),
                            Err(e) => eprintln!("[shell] popup webview: {e}"),
                        }
                    }
                }
                UserEvent::PopupDrag(id) => {
                    if let Some((_, _, win, _)) = popups.iter().find(|(i, _, _, _)| *i == id) {
                        let _ = win.drag_window();
                    }
                }
                UserEvent::PopupClose(id) => {
                    popups.retain(|(i, _, _, _)| *i != id);
                }
                UserEvent::PopupMin(id) => {
                    if let Some((_, _, win, _)) = popups.iter().find(|(i, _, _, _)| *i == id) {
                        win.set_minimized(true);
                    }
                }
                UserEvent::PopupMax(id) => {
                    if let Some((_, _, win, _)) = popups.iter().find(|(i, _, _, _)| *i == id) {
                        win.set_maximized(!win.is_maximized());
                    }
                }
            },
            _ => {}
        }

        if shutdown {
            // Tell the watchdog to stand down BEFORE we kill the daemon, or it
            // would dutifully resurrect the very process we're shutting down.
            SHUTTING_DOWN.store(true, Ordering::Relaxed);
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
