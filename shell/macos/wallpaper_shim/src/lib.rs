//! BagIdea Office — macOS wallpaper shim.
//!
//! Injected into the Godot process via `DYLD_INSERT_LIBRARIES`. macOS does not
//! let one process reparent another's window into the desktop (the Windows
//! `SetParent(..WorkerW)` trick), so the embedding has to happen from *inside*
//! Godot. This shim runs there: once Godot's NSWindow exists it is dropped to
//! the desktop window level (behind the desktop icons), set to ride every
//! Space, and made click-through — a living wallpaper.
//!
//! Godot's official build already ships the `allow-dyld-environment-variables`
//! and `disable-library-validation` entitlements, so no re-signing is needed.

use std::ffi::c_void;
use std::os::raw::c_long;

use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::NSRect;

// CoreGraphics: turn the desktop-window-level *key* into a concrete level.
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowLevelForKey(key: i32) -> i32;
}
const K_CG_DESKTOP_WINDOW_LEVEL_KEY: i32 = 2;

// Grand Central Dispatch: hop onto the main thread (AppKit is main-thread only).
extern "C" {
    static _dispatch_main_q: u8;
    fn dispatch_async_f(
        queue: *const u8,
        context: *mut c_void,
        work: extern "C" fn(*mut c_void),
    );
}

// NSWindowCollectionBehavior bits.
const CAN_JOIN_ALL_SPACES: u64 = 1 << 0;
const STATIONARY: u64 = 1 << 4;
const IGNORES_CYCLE: u64 = 1 << 6;

/// Set every NSApp window to the desktop level. Idempotent — safe to repeat as
/// Godot finishes its `--wallpaper` fullscreen handoff.
extern "C" fn apply_on_main(_ctx: *mut c_void) {
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        if app.is_null() {
            return;
        }
        let windows: *mut AnyObject = msg_send![app, windows];
        if windows.is_null() {
            return;
        }
        let count: usize = msg_send![windows, count];
        // ONE above the system desktop-picture window (which lives exactly at
        // the desktop level): clicking the desktop re-stacks that picture to the
        // top of its level and would otherwise bury us. +1 keeps us above the
        // wallpaper but still well below the desktop icons (icon level is +20).
        let level = (CGWindowLevelForKey(K_CG_DESKTOP_WINDOW_LEVEL_KEY) + 1) as c_long;
        let behavior: u64 = CAN_JOIN_ALL_SPACES | STATIONARY | IGNORES_CYCLE;
        for i in 0..count {
            let w: *mut AnyObject = msg_send![windows, objectAtIndex: i];
            if w.is_null() {
                continue;
            }
            // Only adopt the real office window — the big borderless one Godot
            // sized to the whole screen. Leaving the tiny helper windows alone
            // avoids yanking them onto the desktop too.
            let frame: NSRect = msg_send![w, frame];
            if frame.size.width < 600.0 || frame.size.height < 400.0 {
                continue;
            }
            let _: () = msg_send![w, setLevel: level];
            let _: () = msg_send![w, setCollectionBehavior: behavior];
            let _: () = msg_send![w, setIgnoresMouseEvents: true];
            // THE fix for "office vanishes when another app is focused": a
            // window with hidesOnDeactivate=YES is pulled off-screen the instant
            // its app stops being active (clicking the chat orb, the other
            // monitor, any app switch). Force it off so the wallpaper stays.
            let _: () = msg_send![w, setHidesOnDeactivate: false];
            let _: () = msg_send![w, setCanHide: false];
            // Deactivating Godot (clicking the chat orb, switching Spaces, using
            // the other monitor) orders this window OUT — setLevel alone can't
            // bring a hidden window back, so re-show it at its level WITHOUT
            // activating the app. orderFrontRegardless keeps it below the icons.
            let _: () = msg_send![w, orderFrontRegardless];
        }
    }
}

#[ctor::ctor]
fn init() {
    // The constructor runs during dyld init, before NSApp exists. Poll from a
    // background thread and keep nudging the main queue: the first hops are
    // no-ops, then Godot's window appears, goes fullscreen, and sticks at the
    // desktop level. The early ticks are fast (catch the first-frame build);
    // after that we re-assert slowly FOREVER — clicking the desktop, switching
    // Spaces, or sleep/wake can re-stack the window, and a setLevel to the same
    // value is idempotent (no flicker), so the wallpaper self-heals in ~1.5s.
    std::thread::spawn(|| {
        for _ in 0..30 {
            unsafe {
                dispatch_async_f(&_dispatch_main_q, std::ptr::null_mut(), apply_on_main);
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
        loop {
            unsafe {
                dispatch_async_f(&_dispatch_main_q, std::ptr::null_mut(), apply_on_main);
            }
            std::thread::sleep(std::time::Duration::from_millis(1500));
        }
    });
}
