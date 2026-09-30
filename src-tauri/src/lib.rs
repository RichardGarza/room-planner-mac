use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

/// Set once the page has saved everything (or given up): from then on quitting goes ahead.
static SAVED: AtomicBool = AtomicBool::new(false);
/// Set when the page has been asked to save, so closing and quitting together only ask once.
static ASKED: AtomicBool = AtomicBool::new(false);

/// Called by the page after it has written any pending edits to disk.
#[tauri::command]
fn quit_after_save(app: tauri::AppHandle) {
  eprintln!("room-planner: saved, quitting");
  SAVED.store(true, Ordering::SeqCst);
  app.exit(0);
}

/// Ask the page to save before the app goes away, and quit anyway after a few seconds if it never answers.
fn save_then_quit(app: &tauri::AppHandle) {
  if ASKED.swap(true, Ordering::SeqCst) {
    return;
  }
  eprintln!("room-planner: asking the page to save before quitting");
  let _ = app.emit("save-before-quit", ());
  let handle = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(Duration::from_secs(4));
    eprintln!("room-planner: the page did not answer, quitting anyway");
    SAVED.store(true, Ordering::SeqCst);
    handle.exit(0);
  });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![quit_after_save])
    // our own Quit (⌘Q): the standard one ends the app on the spot, before the page can save
    .on_menu_event(|app, event| {
      if event.id() == "quit" {
        save_then_quit(app);
      }
    })
    .setup(|app| {
      let handle = app.handle();
      let menu = Menu::default(handle)?;
      if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        for item in app_menu.items()? {
          if let MenuItemKind::Predefined(p) = &item {
            if p.text()?.starts_with("Quit") {
              app_menu.remove(p)?;
            }
          }
        }
        let label = format!("Quit {}", handle.package_info().name);
        app_menu.append(&MenuItem::with_id(handle, "quit", label, true, Some("CmdOrCtrl+Q"))?)?;
      }
      app.set_menu(menu)?;

      // a terminate signal (`kill`, or a rebuild restarting the app) saves first too
      #[cfg(unix)]
      {
        use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM, SIGUSR1};
        let mut signals = signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP, SIGUSR1])?;
        let handle = app.handle().clone();
        std::thread::spawn(move || {
          for _ in signals.forever() {
            save_then_quit(&handle);
          }
        });
      }

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    // Closing the window: keep it until the page has saved (edits are written ~0.4 s after they happen).
    .on_window_event(|window, event| {
      if let WindowEvent::CloseRequested { api, .. } = event {
        if !SAVED.load(Ordering::SeqCst) {
          api.prevent_close();
          save_then_quit(window.app_handle());
        }
      }
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    // Quitting (⌘Q, the Dock, `osascript -e 'quit app'`): same, the page saves first.
    .run(|app, event| {
      if std::env::var("ROOM_PLANNER_TRACE").is_ok() {
        match &event {
          RunEvent::ExitRequested { code, .. } => eprintln!("trace: ExitRequested {:?}", code),
          RunEvent::Exit => eprintln!("trace: Exit"),
          RunEvent::WindowEvent { event: WindowEvent::CloseRequested { .. }, .. } => eprintln!("trace: CloseRequested"),
          _ => {}
        }
      }
      if let RunEvent::ExitRequested { api, code, .. } = event {
        if code.is_none() && !SAVED.load(Ordering::SeqCst) {
          api.prevent_exit();
          save_then_quit(app);
        }
      }
    });
}
