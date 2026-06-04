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
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    TrayIconBuilder, TrayIconEvent,
};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Gdi::{CreateEllipticRgn, CreateRoundRectRgn, SetWindowRgn};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, FindWindowW, GetWindowThreadProcessId, IsWindowVisible,
    SendMessageTimeoutW, SetParent, SystemParametersInfoW, SMTO_NORMAL, SPI_SETDESKWALLPAPER,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const ORB_SIZE: f64 = 72.0;
const FULL: (f64, f64) = (560.0, 700.0);
const MINI: (f64, f64) = (390.0, 430.0);
const PARK: (f64, f64) = (-9000.0, 100.0);

#[derive(Debug)]
enum UserEvent {
    Toggle,
    DragOrb,
    DragOverlay,
    HideOverlay,
    MiniToggle,
}

const ORB_HTML: &str = r#"<!doctype html>
<html><body style="margin:0;overflow:hidden;background:#0a111d;user-select:none;-webkit-user-select:none;cursor:pointer">
<img id="ic" src="http://127.0.0.1:8787/brand/logo_ico_cute.png" draggable="false"
     style="position:absolute;left:-3.2px;top:-2.6px;width:79.1px;height:79.1px"
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
  document.body.addEventListener('contextmenu', (e) => e.preventDefault());
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

fn spawn_office(root: &PathBuf) -> Option<Child> {
    let godot = std::env::var("BAGIDEA_GODOT")
        .unwrap_or_else(|_| r"E:\Tools\Godot\Godot_v4.6.3-stable_win64.exe".into());
    if !std::path::Path::new(&godot).exists() {
        return None; // overlay-only mode
    }
    Command::new(godot)
        .args(["--path"])
        .arg(root.join("godot"))
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
fn attach_wallpaper_when_ready(pid: u32) {
    std::thread::spawn(move || unsafe {
        let mut find = FindByPid { pid, hwnd: 0 as HWND };
        for _ in 0..60 {
            EnumWindows(Some(find_by_pid_cb), &mut find as *mut FindByPid as _);
            if find.hwnd != 0 as HWND {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        let godot = find.hwnd;
        if godot == 0 as HWND {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(1500)); // let it size up
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
    });
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
    // ---- boot the whole stack
    let root = project_root();
    let mut daemon_child = spawn_daemon(&root);
    if daemon_child.is_some() {
        std::thread::sleep(std::time::Duration::from_millis(800));
    }
    let mut office_child = spawn_office(&root);
    if let Some(child) = office_child.as_ref() {
        attach_wallpaper_when_ready(child.id());
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    // ---- system tray: the only true exit (the suite runs forever otherwise)
    let tray_menu = Menu::new();
    let open_item = MenuItem::new("Open Office Chat", true, None);
    let exit_item = MenuItem::new("Exit BagIdea Office", true, None);
    let _ = tray_menu.append_items(&[
        &open_item,
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
    let exit_id = exit_item.id().clone();

    // ---- screen-aware default positions (inset, never sunk off-screen)
    let (screen_w, _screen_h, sf) = event_loop
        .primary_monitor()
        .map(|m| (m.size().width as f64, m.size().height as f64, m.scale_factor()))
        .unwrap_or((1920.0, 1080.0, 1.0));
    let logical_w = screen_w / sf;
    let orb_x = logical_w - ORB_SIZE * 2.0;
    let orb_y = ORB_SIZE;
    let overlay_x = (logical_w - FULL.0 - ORB_SIZE * 2.2).max(20.0);
    let overlay_y = 90.0;

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
    let orb_id = orb.id();
    let p_orb = proxy.clone();
    let _orb_view = WebViewBuilder::new()
        .with_html(ORB_HTML)
        .with_ipc_handler(move |req| {
            let _ = match req.body().as_str() {
                "toggle" => p_orb.send_event(UserEvent::Toggle),
                "drag-orb" => p_orb.send_event(UserEvent::DragOrb),
                _ => Ok(()),
            };
        })
        .build(&orb)
        .expect("orb webview");
    circle_region(&orb, ORB_SIZE);

    let raise_orb = |orb: &Window| {
        orb.set_always_on_top(false);
        orb.set_always_on_top(true);
    };

    let mut mini = false;
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
            }
        }
        while let Ok(ev) = TrayIconEvent::receiver().try_recv() {
            if let TrayIconEvent::Click { button: tray_icon::MouseButton::Left, button_state: tray_icon::MouseButtonState::Up, .. } = ev {
                toggle = true;
            }
        }

        // State is derived from reality (window position), so the button can
        // never get out of sync with what's on screen.
        let do_toggle = || {
            let hidden = overlay
                .outer_position()
                .map(|p| p.x < -2000)
                .unwrap_or(true);
            if hidden {
                overlay.set_outer_position(LogicalPosition::new(overlay_x, overlay_y));
                overlay.set_focus();
                raise_orb(&orb);
            } else {
                overlay.set_outer_position(LogicalPosition::new(PARK.0, PARK.1));
            }
            let _ = &overlay_view;
        };

        if toggle {
            do_toggle();
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
                    let (w, h) = if mini { MINI } else { FULL };
                    round_region(&overlay, w, h, 18.0);
                }
            }
            Event::UserEvent(ue) => match ue {
                UserEvent::Toggle => do_toggle(),
                UserEvent::HideOverlay => {
                    overlay.set_outer_position(LogicalPosition::new(PARK.0, PARK.1));
                }
                UserEvent::MiniToggle => {
                    mini = !mini;
                    let (w, h) = if mini { MINI } else { FULL };
                    overlay.set_inner_size(LogicalSize::new(w, h));
                    round_region(&overlay, w, h, 18.0);
                    raise_orb(&orb);
                }
                UserEvent::DragOrb => { let _ = orb.drag_window(); }
                UserEvent::DragOverlay => { let _ = overlay.drag_window(); }
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
