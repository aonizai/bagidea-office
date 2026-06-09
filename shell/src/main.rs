#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// BagIdea Office — THE program. One exe runs the whole stack:
//   • spawns the event daemon (node) if not already running
//   • spawns the Godot office and embeds it behind the desktop icons (WorkerW)
//   • circular chat head (drag anywhere, click toggles the overlay)
//   • frameless rounded overlay with custom chrome
//   • system tray icon — the ONLY place to exit; quitting tears the whole
//     stack down and restores the user's wallpaper.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command};

use tao::{
    dpi::{LogicalPosition, LogicalSize},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    platform::windows::{WindowBuilderExtWindows, WindowExtWindows},
    window::{Icon, Window, WindowBuilder},
};
use tray_icon::{
    menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    TrayIconBuilder, TrayIconEvent,
};
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

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const ORB_SIZE: f64 = 72.0;
const FULL: (f64, f64) = (560.0, 700.0);
const MINI: (f64, f64) = (390.0, 430.0);
const FEED_W: f64 = 330.0;
const PARK: (f64, f64) = (-9000.0, 100.0);

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

/// "ctrl+space" / "f6" → (modifier flags, virtual key) for RegisterHotKey.
fn parse_vk(s: &str) -> Option<(u32, u32)> {
    let mut mods = 0u32; // MOD_ALT 1 | MOD_CONTROL 2 | MOD_SHIFT 4
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

/// Global voice hotkey — OUR OWN RegisterHotKey on a dedicated thread with
/// its own GetMessage pump (the canonical pattern; WM_HOTKEY is posted to
/// the REGISTERING thread's queue, so delivery cannot depend on anyone
/// else's event loop). MOD_NOREPEAT kills key auto-repeat at the OS level.
static PTT_THREAD_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

fn spawn_hotkey_thread(
    proxy: tao::event_loop::EventLoopProxy<UserEvent>,
    initial: Option<(u32, u32)>,
) {
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
                // rebind: wParam = modifier flags, lParam = vk (0 = disable)
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

fn rebind_hotkey(s: &str) {
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

/// Debug beacon: stages of the hotkey chain are reported to the daemon —
/// `ui.ptt` lines in the journal make the whole thing testable end-to-end.
fn ptt_beacon(stage: &str) {
    let body = format!(r#"{{"type":"ui.ptt","stage":"{}"}}"#, stage);
    let _ = Command::new("curl")
        .args(["-s", "-X", "POST", "http://127.0.0.1:8787/event",
            "-H", "content-type: application/json", "-d", &body])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

const SPLASH_SIZE: f64 = 210.0;

// Boot splash: a floating circular logo card (same region trick as the chat
// head — per-pixel window transparency dies under WorkerW, regions don't).
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

// ------------------------------------------------------------------ helpers

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
    Command::new("node")
        .arg(root.join("daemon").join("server.js"))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .ok()
}

// The Godot runtime to launch. Prefer the BRANDED copy (godot/bin/
// BagIdeaOffice.exe — same binary, BAG IDEA icon baked into the .exe so there's
// no Godot icon flash on the taskbar at all); fall back to the env/system Godot.
fn godot_exe(root: &PathBuf) -> String {
    let branded = root.join("godot").join("bin").join("BagIdeaOffice.exe");
    if branded.exists() {
        return branded.to_string_lossy().into_owned();
    }
    std::env::var("BAGIDEA_GODOT")
        .unwrap_or_else(|_| r"E:\Tools\Godot\Godot_v4.6.3-stable_win64.exe".into())
}

fn spawn_office(root: &PathBuf, cx: i32, cy: i32) -> Option<Child> {
    let godot = godot_exe(root);
    if !std::path::Path::new(&godot).exists() {
        return None; // overlay-only mode
    }
    // Born 64px DEAD CENTER — exactly under the shell's circular splash, so
    // the loading window hides behind the logo (user's idea: let the splash
    // cover it). office_floor.gd grows it to fullscreen after first frame.
    Command::new(godot)
        .args(["--path"])
        .arg(root.join("godot"))
        .args(["--resolution", "64x64"])
        .arg("--position")
        .arg(format!("{},{}", cx - 32, cy - 32))
        .args(["--", "--wallpaper"])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .ok()
}

// Launch the 3D Office Editor the SAME way as the wallpaper: a 64px window dead
// centre, hidden under the shell's circular splash. office_floor.gd grows it to
// a framed 1280x800 editor window after the first frame.
fn spawn_editor(root: &PathBuf, cx: i32, cy: i32) -> Option<Child> {
    let godot = godot_exe(root);
    if !std::path::Path::new(&godot).exists() {
        return None;
    }
    Command::new(godot)
        .args(["--path"])
        .arg(root.join("godot"))
        .args(["--resolution", "64x64"])
        .arg("--position")
        .arg(format!("{},{}", cx - 32, cy - 32))
        .args(["--", "--editor3d"])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .ok()
}

// Watch for the daemon's "open the editor" request, then for the editor's
// "ready" handoff — drives the splash show/hide via the event loop.
fn watch_editor_requests(proxy: tao::event_loop::EventLoopProxy<UserEvent>) {
    std::thread::spawn(move || {
        let req = std::env::temp_dir().join("bagidea_editor_open_request");
        let ready = std::env::temp_dir().join("bagidea_editor_ready");
        // drop any stale request from a previous run so we don't auto-open
        let _ = std::fs::remove_file(&req);
        loop {
            if req.exists() {
                let _ = std::fs::remove_file(&req); // consume it → exactly one open
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

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
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

/// The wallpaper window is a CHILD of WorkerW after the attach — top-level
/// enumeration can't see it. Walk WorkerW's children by pid instead.
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

/// Fire-and-forget visibility event to the daemon (curl ships with Win10+).
fn post_visibility(on: bool) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("curl")
        .args(["-s", "-X", "POST", "http://127.0.0.1:8787/event",
            "-H", "content-type: application/json",
            "-d", &format!("{{\"type\":\"ui.visibility\",\"on\":{}}}", on)])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
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

/// Embed the Godot window behind the desktop icons (Wallpaper Engine trick).
/// Found by PID — the window title varies (e.g. a "(DEBUG)" suffix).
/// The window is cloaked with an empty region for the whole scene build
/// (the shell's circular splash carries the boot look); once the renderer
/// drops its world-ready flag the region lifts and the attach happens.
fn attach_wallpaper_when_ready(pid: u32, proxy: tao::event_loop::EventLoopProxy<UserEvent>) {
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
        // Cloak: an empty window region hides every pixel until the scene
        // is actually rendering (no black loading box on screen).
        SetWindowRgn(godot as _, CreateRectRgn(0, 0, 0, 0), 1);
        // And no taskbar button either — the renderer loads as a TOOL
        // window (taskbar re-reads styles on a hide/show cycle). The
        // circular logo splash is the only thing the user sees boot.
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
        std::thread::sleep(std::time::Duration::from_millis(400)); // settle fullscreen
        SetWindowRgn(godot as _, 0 as _, 1); // lift the cloak

        let progman_class = wide("Progman");
        let progman = FindWindowW(progman_class.as_ptr(), std::ptr::null());
        let mut result: usize = 0;
        SendMessageTimeoutW(progman, 0x052C, 0, 0, SMTO_NORMAL, 1000, &mut result);
        let mut workerw: HWND = 0 as HWND;
        EnumWindows(Some(find_workerw_cb), &mut workerw as *mut HWND as _);
        if workerw == 0 as HWND {
            // Win11 24H2 layout fallback
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

// ---- auto-start with Windows (HKCU Run key, toggled from the tray menu —
// dev-friendly: nothing is forced, the checkbox controls it)

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_NAME: &str = "BagIdeaOffice";

fn is_autostart() -> bool {
    Command::new("reg")
        .args(["query", RUN_KEY, "/v", RUN_NAME])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn set_autostart(on: bool) {
    if on {
        if let Ok(exe) = std::env::current_exe() {
            let _ = Command::new("reg")
                .args(["add", RUN_KEY, "/v", RUN_NAME, "/t", "REG_SZ", "/d",
                    &exe.to_string_lossy(), "/f"])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
    } else {
        let _ = Command::new("reg")
            .args(["delete", RUN_KEY, "/v", RUN_NAME, "/f"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
}

fn restore_wallpaper() {
    unsafe {
        SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, std::ptr::null_mut(), 3);
    }
}

fn round_region(window: &Window, w: f64, h: f64, radius: f64) {
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

fn circle_region(window: &Window, d: f64) {
    let sf = window.scale_factor();
    unsafe {
        let rgn = CreateEllipticRgn(0, 0, (d * sf) as i32 + 1, (d * sf) as i32 + 1);
        SetWindowRgn(window.hwnd() as _, rgn, 1);
    }
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

// --------------------------------------------------------------------- main

fn main() {
    // ---- single instance: a second launch exits immediately (the suite is
    // a background companion — duplicates mean duplicate wallpapers/daemons)
    unsafe {
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
        use windows_sys::Win32::System::Threading::CreateMutexW;
        let name = wide("BagIdeaOfficeShellSingleton");
        CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if GetLastError() == ERROR_ALREADY_EXISTS {
            return;
        }
    }

    // ---- boot the whole stack
    let root = project_root();
    let mut daemon_child = spawn_daemon(&root);
    if daemon_child.is_some() {
        std::thread::sleep(std::time::Duration::from_millis(800));
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    // Physical screen center — the godot boot window hides here, under the
    // splash circle.
    let (phys_w, phys_h) = event_loop
        .primary_monitor()
        .map(|m| (m.size().width as i32, m.size().height as i32))
        .unwrap_or((1920, 1080));
    let mut office_child = spawn_office(&root, phys_w / 2, phys_h / 2 - 30);
    if let Some(child) = office_child.as_ref() {
        attach_wallpaper_when_ready(child.id(), proxy.clone());
    }

    // editor: the daemon drops a request flag → we show the splash + launch the
    // editor tiny under it, then drop the splash when it reports ready.
    let _ = std::fs::write(std::env::temp_dir().join("bagidea_shell_alive"), "1");
    watch_editor_requests(proxy.clone());

    // ---- system tray: the only true exit (the suite runs forever otherwise)
    let tray_menu = Menu::new();
    let open_item = MenuItem::new("Open Office Chat", true, None);
    let hide_item = CheckMenuItem::new("Hide office (agents keep working)", true, false, None);
    let autostart_item = CheckMenuItem::new("Start with Windows", true, is_autostart(), None);
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

    // ---- global voice hotkey (default F6, overlay-configurable).
    // The global-hotkey crate never delivered events on this machine
    // (proven via journal beacons) — we own a RegisterHotKey thread instead:
    // WM_HOTKEY lands on ITS queue, the proxy wakes the tao loop, done.
    spawn_hotkey_thread(event_loop.create_proxy(), parse_vk("f6"));

    // Office pid for hide/show of the wallpaper window.
    let office_pid = office_child.as_ref().map(|c| c.id()).unwrap_or(0);

    // ---- screen-aware default positions (inset, never sunk off-screen)
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
    // 📡 feed mode: a quiet half-height strip in the bottom-right corner —
    // a true overlay (click-through + translucent), not another window.
    let feed_h = (logical_h * 0.5).clamp(320.0, 560.0);
    let feed_x = logical_w - FEED_W - 8.0;
    let feed_y = logical_h - feed_h - 64.0;

    // ---- boot splash: a pulsing circular logo, centered — visible while
    // the Godot window is cloaked and the world builds.
    let splash = WindowBuilder::new()
        .with_title("BagIdea")
        .with_inner_size(LogicalSize::new(SPLASH_SIZE, SPLASH_SIZE))
        .with_position(LogicalPosition::new(
            (logical_w - SPLASH_SIZE) / 2.0,
            (logical_h - SPLASH_SIZE) / 2.0 - 30.0,
        ))
        .with_decorations(false)
        .with_undecorated_shadow(false)
        .with_resizable(false)
        .with_always_on_top(true)
        .with_skip_taskbar(true)
        .build(&event_loop)
        .expect("splash window");
    unsafe {
        let hwnd = splash.hwnd() as HWND;
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        SetWindowLongW(hwnd, GWL_EXSTYLE, (ex | WS_EX_NOACTIVATE) as i32);
    }
    let _splash_view = WebViewBuilder::new()
        .with_html(SPLASH_HTML)
        .build(&splash)
        .expect("splash webview");
    circle_region(&splash, SPLASH_SIZE);
    let splash_id = splash.id();

    // ---- overlay (born visible but parked off-screen: a WebView2 created on
    // a hidden window never wakes its scripts)
    let overlay = WindowBuilder::new()
        .with_title("BagIdea Office")
        .with_inner_size(LogicalSize::new(FULL.0, FULL.1))
        .with_position(LogicalPosition::new(PARK.0, PARK.1))
        .with_decorations(false)
        .with_undecorated_shadow(false)
        .with_resizable(false)
        .with_always_on_top(true)
        .with_skip_taskbar(true)
        .with_window_icon(app_icon())
        .build(&event_loop)
        .expect("overlay window");
    // Windows clamps off-screen positions at creation — park it again now.
    overlay.set_outer_position(LogicalPosition::new(PARK.0, PARK.1));
    let overlay_id = overlay.id();
    let p_overlay = proxy.clone();
    let overlay_view = WebViewBuilder::new()
        .with_url("http://127.0.0.1:8787/")
        .with_devtools(true)
        // Edge's "Saved info" autofill bubbles are noise on an app UI.
        .with_general_autofill_enabled(false)
        .with_ipc_handler(move |req| {
            let _ = match req.body().as_str() {
                "drag-overlay" => p_overlay.send_event(UserEvent::DragOverlay),
                "hide" => p_overlay.send_event(UserEvent::HideOverlay),
                "mini" => p_overlay.send_event(UserEvent::MiniToggle),
                s if s.starts_with("hotkey:") =>
                    p_overlay.send_event(UserEvent::SetHotkey(s[7..].to_string())),
                _ => Ok(()),
            };
        })
        .build(&overlay)
        .expect("overlay webview");
    round_region(&overlay, FULL.0, FULL.1, 18.0);

    // ---- circular chat head
    let orb = WindowBuilder::new()
        .with_title("BagIdea")
        .with_inner_size(LogicalSize::new(ORB_SIZE, ORB_SIZE))
        .with_position(LogicalPosition::new(orb_x, orb_y))
        .with_decorations(false)
        .with_undecorated_shadow(false)
        .with_resizable(false)
        .with_always_on_top(true)
        .with_skip_taskbar(true)
        .with_window_icon(app_icon())
        .build(&event_loop)
        .expect("orb window");
    // Never take focus: Windows eats the first click on inactive windows as
    // an activation handshake ("sometimes the button does nothing"). A
    // NOACTIVATE chat head receives every click immediately — and clicking
    // it no longer steals focus from whatever the user is working in.
    unsafe {
        let hwnd = orb.hwnd() as HWND;
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        SetWindowLongW(hwnd, GWL_EXSTYLE, (ex | WS_EX_NOACTIVATE) as i32);
    }
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
    circle_region(&orb, ORB_SIZE);
    // The chat head joins the desktop only after the splash bows out —
    // parked (not hidden: a hidden WebView2 never wakes) until WorldReady.
    orb.set_outer_position(LogicalPosition::new(PARK.0, PARK.1 + 200.0));

    let raise_orb = |orb: &Window| {
        orb.set_always_on_top(false);
        orb.set_always_on_top(true);
    };

    let mut mini = false;
    let mut feed = false;
    let mut editor_pid: u32 = 0; // single-instance: focus instead of re-opening
    let mut last_ptt = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_secs(10))
        .unwrap_or_else(std::time::Instant::now);
    event_loop.run(move |event, _, control_flow| {
        // WaitUntil, never Wait: the tray channels are POLLED here, and a
        // sleeping loop reads nothing. A 150 ms tick costs nothing and keeps
        // every channel live.
        *control_flow = ControlFlow::WaitUntil(
            std::time::Instant::now() + std::time::Duration::from_millis(150));

        // Chat-head watchdog: the orb is the user's ONE always-present control,
        // so it must never get lost. Unless the office is deliberately hidden,
        // if the orb has drifted off-screen (a missed WorldReady, a glitch) snap
        // it back and re-assert always-on-top so it can't sink behind anything.
        if !hide_item.is_checked() {
            let off = orb.outer_position().map(|p| p.x < -2000).unwrap_or(true);
            if off {
                orb.set_outer_position(LogicalPosition::new(orb_x, orb_y));
            }
            orb.set_visible(true);
            orb.set_always_on_top(true);
        }

        let mut shutdown = false;
        let mut toggle = false;

        // Tray interactions (left-click head icon → toggle, menu → actions)
        while let Ok(ev) = MenuEvent::receiver().try_recv() {
            if ev.id == exit_id {
                shutdown = true;
            } else if ev.id == open_id {
                toggle = true;
            } else if ev.id == hide_id {
                // Hide the whole office FACE — agents keep working underneath.
                let hidden = hide_item.is_checked();
                let g = find_wallpaper_hwnd(office_pid);
                if g != 0 as HWND {
                    unsafe { ShowWindow(g, if hidden { SW_HIDE } else { SW_SHOW }); }
                }
                if hidden {
                    overlay.set_outer_position(LogicalPosition::new(PARK.0, PARK.1));
                    orb.set_outer_position(LogicalPosition::new(PARK.0, PARK.1 + 200.0));
                } else {
                    orb.set_outer_position(LogicalPosition::new(orb_x, orb_y));
                    raise_orb(&orb);
                }
                post_visibility(!hidden);
            } else if ev.id == autostart_id {
                // CheckMenuItem already flipped its own state on click.
                set_autostart(autostart_item.is_checked());
            }
        }

        while let Ok(ev) = TrayIconEvent::receiver().try_recv() {
            if let TrayIconEvent::Click { button: tray_icon::MouseButton::Left, button_state: tray_icon::MouseButtonState::Up, .. } = ev {
                toggle = true;
            }
        }

        // State is derived from reality (window position), so the button can
        // never get out of sync with what's on screen.
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
                // chat head has no close button; exiting is tray-only
            }
            Event::WindowEvent { window_id, event: WindowEvent::Focused(true), .. } => {
                if window_id == overlay_id {
                    raise_orb(&orb);
                }
            }
            // Regions get cleared by style/size changes — always re-assert.
            Event::WindowEvent { window_id, event: WindowEvent::Resized(_), .. } => {
                if window_id == orb_id {
                    circle_region(&orb, ORB_SIZE);
                } else if window_id == overlay_id {
                    let (w, h) = if feed { (FEED_W, feed_h) } else if mini { MINI } else { FULL };
                    round_region(&overlay, w, h, if feed { 14.0 } else { 18.0 });
                } else if window_id == splash_id {
                    circle_region(&splash, SPLASH_SIZE);
                }
            }
            Event::UserEvent(ue) => match ue {
                UserEvent::WorldReady => {
                    // Wallpaper is live — the splash bows out, the chat head
                    // takes its post.
                    splash.set_visible(false);
                    orb.set_outer_position(LogicalPosition::new(orb_x, orb_y));
                    raise_orb(&orb);
                }
                UserEvent::EditorOpening => {
                    // single instance: if an editor is already open, just focus
                    // it (don't open a second one or re-show the splash).
                    let mut existing = 0 as HWND;
                    if editor_pid != 0 {
                        let mut find = FindByPid { pid: editor_pid, hwnd: 0 as HWND };
                        unsafe { EnumWindows(Some(find_by_pid_cb), &mut find as *mut FindByPid as _); }
                        existing = find.hwnd;
                    }
                    if existing != 0 as HWND {
                        unsafe {
                            use windows_sys::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, ShowWindow, SW_RESTORE};
                            ShowWindow(existing, SW_RESTORE);
                            SetForegroundWindow(existing);
                        }
                        // unblock the watcher (it's waiting for a ready flag)
                        let _ = std::fs::write(std::env::temp_dir().join("bagidea_editor_ready"), "focused");
                    } else {
                        editor_pid = 0;
                        // show the logo splash on top, launch the editor under it.
                        // The .exe already carries the brand icon, so no cloak needed.
                        splash.set_visible(true);
                        unsafe {
                            use windows_sys::Win32::UI::WindowsAndMessaging::{
                                SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
                            };
                            SetWindowPos(splash.hwnd() as HWND, HWND_TOPMOST as HWND, 0, 0, 0, 0,
                                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                        }
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
                        round_region(&overlay, w, h, 18.0);
                        raise_orb(&orb);
                    }
                }
                UserEvent::FeedToggle => {
                    // 📡 chat ↔ streamer feed: same window, new clothes.
                    feed = !feed;
                    let _ = overlay_view.evaluate_script(&format!(
                        "window.setFeedMode && setFeedMode({})", feed));
                    // The strip is translucent (uniform layered alpha — the
                    // one WebView2-safe transparency on this machine) but it
                    // STAYS interactive: scrollback, the clear button and the
                    // allow/deny cards all need real mouse events.
                    let _ = overlay.set_ignore_cursor_events(false);
                    unsafe {
                        let hwnd = overlay.hwnd() as HWND;
                        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
                        if feed {
                            SetWindowLongW(hwnd, GWL_EXSTYLE, (ex | WS_EX_LAYERED) as i32);
                            SetLayeredWindowAttributes(hwnd, 0, 196, LWA_ALPHA);
                        } else {
                            SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
                            SetWindowLongW(hwnd, GWL_EXSTYLE, (ex & !WS_EX_LAYERED) as i32);
                        }
                    }
                    if feed {
                        overlay.set_inner_size(LogicalSize::new(FEED_W, feed_h));
                        overlay.set_outer_position(LogicalPosition::new(feed_x, feed_y));
                        round_region(&overlay, FEED_W, feed_h, 14.0);
                    } else {
                        let (w, h) = if mini { MINI } else { FULL };
                        overlay.set_inner_size(LogicalSize::new(w, h));
                        overlay.set_outer_position(LogicalPosition::new(overlay_x, overlay_y));
                        round_region(&overlay, w, h, 18.0);
                    }
                    raise_orb(&orb);
                }
                UserEvent::DragOrb => { let _ = orb.drag_window(); }
                UserEvent::DragOverlay => { let _ = overlay.drag_window(); }
                UserEvent::PttKey(pressed) => {
                    // Global voice hotkey (F6). The webview owns the whole
                    // voice session now (it records the mic itself —
                    // getUserMedia needs no focus, no foreground, no system
                    // panel). The shell only makes sure the pill is on
                    // screen and forwards the toggle. Time-based debounce
                    // absorbs key auto-repeat.
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
                UserEvent::SetHotkey(s) => rebind_hotkey(&s),
            },
            _ => {}
        }

        if shutdown {
            // Tear the whole suite down and give the desktop back.
            if let Some(c) = office_child.as_mut() {
                let _ = c.kill();
            }
            if let Some(c) = daemon_child.as_mut() {
                let _ = c.kill();
            }
            restore_wallpaper();
            *control_flow = ControlFlow::Exit;
        }
    });
}

use wry::WebViewBuilder;
