#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// BagIdea AI Agents Office — THE program. One exe runs the whole stack:
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
    MicDown,
    MicUp,
    SetHotkey(String),
    WorldReady,
}

/// "ctrl+space" → a registered global push-to-talk chord.
fn parse_hotkey(s: &str) -> Option<global_hotkey::hotkey::HotKey> {
    use global_hotkey::hotkey::{Code, HotKey, Modifiers};
    let mut mods = Modifiers::empty();
    let mut code = None;
    for part in s.to_lowercase().split('+') {
        match part.trim() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "shift" => mods |= Modifiers::SHIFT,
            "alt" => mods |= Modifiers::ALT,
            "space" => code = Some(Code::Space),
            "f5" => code = Some(Code::F5),
            "f6" => code = Some(Code::F6),
            "f7" => code = Some(Code::F7),
            "f8" => code = Some(Code::F8),
            "f9" => code = Some(Code::F9),
            "f10" => code = Some(Code::F10),
            "none" | "" => return None,
            _ => {}
        }
    }
    code.map(|c| HotKey::new(if mods.is_empty() { None } else { Some(mods) }, c))
}

/// Synthetic key chords. Voice input = push-to-talk over Windows Voice
/// Typing: press opens Win+H over the focused input (built-in, offline-
/// capable, speaks Thai — WebView2 has no Web Speech backend and we have
/// no STT API keys); release sends Esc to close the panel.
fn send_keys(keys: &[(u16, bool)]) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_KEYBOARD, KEYEVENTF_KEYUP,
    };
    unsafe {
        let mut inputs: Vec<INPUT> = Vec::with_capacity(keys.len());
        for (vk, up) in keys {
            let mut inp: INPUT = std::mem::zeroed();
            inp.r#type = INPUT_KEYBOARD;
            inp.Anonymous.ki.wVk = *vk;
            inp.Anonymous.ki.dwFlags = if *up { KEYEVENTF_KEYUP } else { 0 };
            inputs.push(inp);
        }
        SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
    }
}

fn send_win_h() {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_LWIN;
    send_keys(&[(VK_LWIN, false), (0x48, false), (0x48, true), (VK_LWIN, true)]);
}

/// Voice typing lands wherever the FOREGROUND focus is — and plain
/// set_focus loses to the Windows foreground lock when we're a background
/// process. A synthetic ALT tap counts as "recent user input" and unlocks
/// SetForegroundWindow (the classic, documented escape hatch).
fn force_foreground(hwnd: HWND) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_MENU;
    use windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    send_keys(&[(VK_MENU, false), (VK_MENU, true)]);
    unsafe {
        SetForegroundWindow(hwnd);
    }
}

fn send_esc() {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
    send_keys(&[(VK_ESCAPE, false), (VK_ESCAPE, true)]);
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
<img src="http://127.0.0.1:8787/brand/logo_ico_cute.png" draggable="false"
     style="position:absolute;left:0.9px;top:1.4px;width:70.8px;height:70.8px"
     onerror="document.body.style.background='radial-gradient(circle at 32% 28%,#2a78d8,#0b1422)'">
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

fn spawn_office(root: &PathBuf, cx: i32, cy: i32) -> Option<Child> {
    let godot = std::env::var("BAGIDEA_GODOT")
        .unwrap_or_else(|_| r"E:\Tools\Godot\Godot_v4.6.3-stable_win64.exe".into());
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
        .with_tooltip("BagIdea AI Agents Office")
        .with_icon(tray_app_icon().expect("tray icon"))
        .build()
        .expect("tray");
    let open_id = open_item.id().clone();
    let hide_id = hide_item.id().clone();
    let autostart_id = autostart_item.id().clone();
    let exit_id = exit_item.id().clone();

    // ---- global push-to-talk hotkey (default Ctrl+Space, overlay-config)
    let hk_mgr = global_hotkey::GlobalHotKeyManager::new().ok();
    let mut cur_hotkey = parse_hotkey("f6");
    if let (Some(m), Some(hk)) = (hk_mgr.as_ref(), cur_hotkey) {
        let _ = m.register(hk);
    }

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
        .with_ipc_handler(move |req| {
            let _ = match req.body().as_str() {
                "drag-overlay" => p_overlay.send_event(UserEvent::DragOverlay),
                "hide" => p_overlay.send_event(UserEvent::HideOverlay),
                "mini" => p_overlay.send_event(UserEvent::MiniToggle),
                "micdown" => p_overlay.send_event(UserEvent::MicDown),
                "micup" => p_overlay.send_event(UserEvent::MicUp),
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
    let mut ptt_held = false;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

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

        // Global push-to-talk: hold the chord, dictate, release to stop.
        while let Ok(e) = global_hotkey::GlobalHotKeyEvent::receiver().try_recv() {
            if let Some(hk) = cur_hotkey {
                if e.id == hk.id() {
                    match e.state {
                        global_hotkey::HotKeyState::Pressed => {
                            // Keyboard auto-repeat fires Pressed again and
                            // again while held — only the first one counts.
                            if ptt_held {
                                continue;
                            }
                            ptt_held = true;
                            // Summon the overlay if it's parked off-screen —
                            // dictation needs a real, visible, FOREGROUND box.
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
                            overlay.set_focus();
                            force_foreground(overlay.hwnd() as HWND);
                            let _ = overlay_view
                                .evaluate_script("window.pttStart && pttStart()");
                            // Let focus actually land before Win+H opens the
                            // panel, or it attaches to the wrong window.
                            std::thread::sleep(std::time::Duration::from_millis(230));
                            send_win_h();
                        }
                        global_hotkey::HotKeyState::Released => {
                            ptt_held = false;
                            send_esc();
                            let _ = overlay_view
                                .evaluate_script("window.pttEnd && pttEnd()");
                        }
                    }
                }
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
                UserEvent::MicDown => {
                    overlay.set_focus();  // voice typing lands in the focused box
                    force_foreground(overlay.hwnd() as HWND);
                    std::thread::sleep(std::time::Duration::from_millis(160));
                    send_win_h();
                }
                UserEvent::MicUp => send_esc(),
                UserEvent::SetHotkey(s) => {
                    if let Some(m) = hk_mgr.as_ref() {
                        if let Some(old) = cur_hotkey {
                            let _ = m.unregister(old);
                        }
                        cur_hotkey = parse_hotkey(&s);
                        if let Some(hk) = cur_hotkey {
                            let _ = m.register(hk);
                        }
                    }
                }
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
