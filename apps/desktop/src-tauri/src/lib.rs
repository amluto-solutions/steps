//! Tauri application shell for Steps: window, plugins and commands.
#![forbid(unsafe_code)]

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::ShortcutState;

mod app_folder;
mod brands;
pub mod browser_link;
mod export_files;
mod hotkeys;
mod identity;
mod library;
mod locks;
mod logs;
mod ocr_cache;
mod open;
mod policy;
mod recorder;
mod settings_file;
mod startup;
mod support;
mod sync_folders;
mod updates;

use hotkeys::HotkeyAction;

fn show_main_window(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// Stops any recording first, so its journal is marked stopped and its input released, then
/// exits. Waits at most 5 seconds for the recording to finish.
fn quit(app: &AppHandle) {
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("amluto-quit".into())
        .spawn(move || {
            let service = handle.state::<recorder::RecorderService>().inner().clone();
            let _ = service.stop_if_active(&handle);
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while service.is_recording_active() && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            handle.exit(0);
        });
    if spawned.is_err() {
        app.exit(0);
    }
}

/// Starts the desktop app. Exits with status 1 if Tauri can't start.
#[allow(
    clippy::too_many_lines,
    reason = "The command and plugin registration is the app entry point."
)]
pub fn run() {
    // A portable program that has just replaced itself waits for its old copy to close.
    updates::after_replacement();
    let result = tauri::Builder::default()
        // One Steps per person (F001, 01/10/2026): a second start, whether from the setup's copy,
        // the Store's or a portable one, brings this one forward and says so, instead of running
        // twice and taking each other's keyboard shortcuts. Registered first, as the plugin asks.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
            let _ = app.emit_to("main", "steps://already-open", ());
        }))
        .device_event_filter(tauri::DeviceEventFilter::Always)
        .manage(recorder::RecorderService::default())
        .manage(hotkeys::HotkeyService::default())
        .manage(library::LibraryService::default())
        .manage(locks::LockService::default())
        .manage(updates::UpdateService::default())
        .manage(browser_link::BrowserLink::default())
        .plugin(logs::plugin())
        .plugin(tauri_plugin_dialog::init())
        // Its own commands are allowed in no window; updates.rs is the only way in.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Closing the main window hides it to the tray instead of destroying it: the hidden
        // recorder windows keep the app running, and a destroyed main window could never be
        // reopened. Quit is in the tray menu.
        .on_window_event(|window, event| {
            if window.label() == "main"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Steps")
                .args(["--minimized"])
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            policy::policy_get,
            identity::identity_names,
            identity::identity_machine,
            updates::updates_channel,
            updates::updates_check,
            updates::updates_download,
            updates::updates_pending,
            updates::updates_install,
            browser_link::browser_link_get,
            browser_link::browser_link_set,
            support::support_create_bundle,
            support::support_show_bundle,
            support::support_open_email,
            open::open_web_page,
            support::support_open_logs,
            recorder::commands::recorder_start,
            recorder::commands::recorder_get_preferences,
            recorder::commands::recorder_set_preferences,
            recorder::commands::recorder_get_state,
            recorder::commands::recorder_pause,
            recorder::commands::recorder_resume,
            recorder::commands::recorder_stop,
            recorder::commands::recorder_discard,
            recorder::commands::recorder_set_input_source,
            recorder::commands::recorder_exclude_app,
            recorder::commands::recorder_include_app,
            recorder::commands::recorder_set_capture_mode,
            recorder::commands::recorder_set_bar_hidden,
            recorder::commands::recorder_move_bar,
            recorder::commands::recorder_get_monitors,
            recorder::commands::recorder_set_target_monitor,
            recorder::commands::recorder_append_step,
            recorder::commands::recorder_finalize,
            recorder::commands::recorder_copy_media,
            recorder::commands::recorder_get_recoveries,
            recorder::commands::recorder_recover_session,
            recorder::commands::recorder_get_recovery_records,
            recorder::commands::recorder_get_session_steps,
            recorder::commands::recorder_load_image,
            recorder::commands::recorder_retake_draft_image,
            recorder::commands::recorder_close_shortcut_popup,
            recorder::commands::recorder_capture_now,
            recorder::commands::recorder_add_shortcut,
            recorder::commands::recorder_bar_heartbeat,
            recorder::commands::recorder_start_again,
            recorder::commands::recorder_undo_start_again,
            recorder::commands::recorder_get_restart_point,
            recorder::commands::recorder_get_recording_settings,
            recorder::commands::recorder_save_draft,
            recorder::commands::recorder_save_draft_guide,
            recorder::commands::recorder_save_draft_step,
            recorder::commands::recorder_delete_draft_step,
            recorder::commands::recorder_load_draft,
            brands::brands_list,
            brands::brands_save,
            brands::brands_save_managed,
            brands::brands_delete,
            brands::brands_managed_ids,
            brands::brands_read_file,
            brands::brands_write_file,
            ocr_cache::privacy_ocr,
            ocr_cache::privacy_clear_ocr_cache,
            export_files::fonts_family,
            export_files::fonts_check,
            export_files::export_write_file,
            export_files::export_default_folder,
            export_files::export_show,
            export_files::export_preview,
            settings_file::settings_read_file,
            settings_file::backup_read_file,
            settings_file::backup_write_file,
            settings_file::settings_write_file,
            hotkeys::hotkeys_get,
            hotkeys::hotkeys_set,
            hotkeys::hotkeys_reset,
            hotkeys::hotkeys_suspend,
            startup::startup_task_state,
            startup::startup_task_set,
            library::library_list_libraries,
            library::library_add_library,
            library::library_rename_library,
            library::library_remove_library,
            library::library_set_default_library,
            library::library_open_folder,
            library::library_guide_meta,
            library::library_write_guide_lock,
            library::library_write_guide_history,
            library::library_guide_stats,
            library::library_list_guides,
            library::library_retake_image,
            library::library_search_guides,
            library::library_load_guide,
            library::library_create_guide,
            library::library_open_for_editing,
            library::library_release_lock,
            library::library_save_draft,
            library::library_fingerprint,
            library::library_list_conflicts,
            library::library_resolve_conflict,
            library::library_list_comments,
            library::library_add_comment,
            library::library_resolve_comment,
            library::library_delete_comment,
            library::library_guide_fingerprint,
            library::library_list_drafts,
            library::library_discard_draft,
            library::library_draft_to_copy,
            library::library_save_guide,
            library::library_save_step,
            library::library_delete_step,
            library::library_import_image,
            library::library_load_image,
            library::library_trash_guide,
            library::library_list_trash,
            library::library_restore_guide,
            library::library_delete_trashed,
            library::library_empty_trash,
            library::library_create_from_parts,
            library::library_duplicate_guide,
            library::library_copy_guide,
            library::library_move_guide,
            library::library_save_version,
            library::library_apply_redactions,
            library::library_list_versions,
            library::library_load_version,
            library::library_restore_version,
            library::library_export_amlsteps,
            library::library_import_amlsteps,
        ])
        .setup(|app| {
            // The windows are made here, not from the config at start (`create: false`), so the
            // portable program can keep its web view's data beside itself; an installed copy's
            // get Tauri's usual folder, exactly as before.
            for config in app.config().app.windows.clone() {
                let mut window = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
                if let Some(folder) = app_folder::webview_folder() {
                    window = window.data_directory(folder);
                }
                window.build()?;
            }
            // An update downloaded last time installs now, before any window shows: its setup
            // replaces the program and opens the new version, so this copy just leaves.
            if updates::install_pending_on_start(app.handle()) {
                std::process::exit(0);
            }
            logs::prune_old_logs(app.handle());
            export_files::remove_previews(app.handle());
            #[cfg(windows)]
            startup::move_old_run_entry(app.handle());
            locks::start_heartbeat(app.handle());
            // Started with Windows: the Run key passes --minimized (backup installers); the Store
            // package's startup task can't pass arguments, so Windows is asked how it started us.
            if (std::env::args().any(|argument| argument == "--minimized")
                || capture::platform::startup::launched_by_startup_task())
                && let Some(main) = app.get_webview_window("main")
            {
                let _ = main.hide();
            }
            if let Some(icon) = app.default_window_icon() {
                let open = MenuItem::with_id(app, "open", "Open Steps", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open, &quit_item])?;
                TrayIconBuilder::with_id("main")
                    .tooltip("Steps")
                    .icon(icon.clone())
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "open" => show_main_window(app),
                        "quit" => quit(app),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if matches!(
                            event,
                            TrayIconEvent::Click {
                                button: MouseButton::Left,
                                button_state: MouseButtonState::Up,
                                ..
                            }
                        ) {
                            show_main_window(tray.app_handle());
                        }
                    })
                    .build(app)
                    .map_err(std::io::Error::other)?;
            }
            app.handle()
                .plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(|app, shortcut, event| {
                            if event.state != ShortcutState::Pressed {
                                return;
                            }
                            let hotkeys = app.state::<hotkeys::HotkeyService>();
                            let mut action = hotkeys.action_for(shortcut);
                            // One combination for Start and Stop: it stops a recording that's
                            // running and starts one otherwise.
                            if matches!(
                                action,
                                Some(HotkeyAction::StartRecording | HotkeyAction::Stop)
                            ) && hotkeys.start_stop_shared()
                            {
                                let active = app
                                    .state::<recorder::RecorderService>()
                                    .is_recording_active();
                                action = Some(if active {
                                    HotkeyAction::Stop
                                } else {
                                    HotkeyAction::StartRecording
                                });
                            }
                            // Starting needs the main window's choices (title, typed values,
                            // excluded apps), so the window starts it, exactly as its button does.
                            if action == Some(HotkeyAction::StartRecording) {
                                let _ = app.emit_to("main", "recorder:start-requested", ());
                                return;
                            }
                            if let Some(action) = action {
                                let service =
                                    app.state::<recorder::RecorderService>().inner().clone();
                                let app = app.clone();
                                if let Err(error) = std::thread::Builder::new()
                                    .name("amluto-hotkey".into())
                                    .spawn(move || {
                                        let result = match action {
                                            HotkeyAction::AddShortcut => service.add_shortcut(&app),
                                            HotkeyAction::TogglePause => {
                                                service.toggle_pause(&app).map(|_| ())
                                            }
                                            HotkeyAction::Stop => {
                                                service.stop_if_active(&app).map(|_| ())
                                            }
                                            HotkeyAction::CaptureNow
                                            | HotkeyAction::StartRecording => {
                                                service.capture_now(&app)
                                            }
                                        };
                                        if let Err(error) = result {
                                            let _ = app.emit("recorder:error", error);
                                        }
                                    })
                                {
                                    log::error!("Could not start the hotkey worker: {error}");
                                }
                            }
                        })
                        .build(),
                )
                .map_err(std::io::Error::other)?;
            // One by one, so a combination another program already owns is skipped and logged
            // rather than stopping Steps from starting.
            app.state::<hotkeys::HotkeyService>()
                .initialize(app.handle());
            // A problem here (e.g. a library on a disconnected drive) is logged; the app still
            // opens, and its commands report "not ready" instead of the app failing to launch.
            if let Err(error) = app
                .state::<recorder::RecorderService>()
                .initialize(app.handle())
            {
                log::error!("The recorder could not be set up: {error}");
            }
            Ok(())
        })
        .run(tauri::generate_context!());

    if let Err(error) = result {
        eprintln!("Steps could not start: {error}");
        std::process::exit(1);
    }
}
