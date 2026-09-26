mod commands;
mod host;
mod update;

use commands::{host_capture_screenshot, host_save_text_file, host_select_directory};
use host::HostProcess;
use std::path::PathBuf;
use std::thread;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// Product values required by the reusable desktop host.
pub struct DesktopConfig {
    pub product_id: String,
    pub product_name: String,
    pub data_dir_name: String,
    pub development_root: PathBuf,
}

impl DesktopConfig {
    pub fn new(
        product_id: impl Into<String>,
        product_name: impl Into<String>,
        data_dir_name: impl Into<String>,
        development_root: impl Into<PathBuf>,
    ) -> Self {
        Self {
            product_id: product_id.into(),
            product_name: product_name.into(),
            data_dir_name: data_dir_name.into(),
            development_root: development_root.into(),
        }
    }
}

fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    let new_chat = MenuItemBuilder::with_id("new-chat", "新建对话")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let open_terminal = MenuItemBuilder::with_id("open-terminal", "打开终端")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let quit = MenuItemBuilder::with_id("app-quit", "退出")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let file = SubmenuBuilder::new(app, "文件")
        .item(&new_chat)
        .separator()
        .close_window()
        .separator()
        .item(&quit)
        .build()?;
    let edit = SubmenuBuilder::new(app, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "视图")
        .item(&open_terminal)
        .separator()
        .fullscreen()
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&file, &edit, &view])
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| match event.id().0.as_str() {
        "new-chat" => {
            let _ = app.emit("menu:new-chat", ());
        }
        "open-terminal" => {
            let _ = app.emit("menu:open-terminal", ());
        }
        "app-quit" => app.exit(0),
        _ => {}
    });
    Ok(())
}

/// Runs a Tauri desktop shell around the shared Node HostRuntime.
pub fn run(context: tauri::Context<tauri::Wry>, config: DesktopConfig) {
    let product_name = config.product_name.clone();
    let builder = tauri::Builder::default()
        .manage(update::UpdateState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            host_select_directory,
            host_save_text_file,
            host_capture_screenshot
        ])
        .setup(move |app| {
            install_menu(app)?;
            let handle = app.handle().clone();
            thread::spawn(move || {
                let (host, url) = match HostProcess::spawn(&handle, &config) {
                    Ok(started) => started,
                    Err(error) => {
                        let exit_handle = handle.clone();
                        handle
                            .dialog()
                            .message(error)
                            .title(format!("{} 无法启动", config.product_name))
                            .kind(MessageDialogKind::Error)
                            .show(move |_| exit_handle.exit(1));
                        return;
                    }
                };
                handle.manage(host);
                let allowed_origin = url.origin().ascii_serialization();
                if let Err(error) =
                    WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                        .title(&config.product_name)
                        .inner_size(1200.0, 800.0)
                        .min_inner_size(900.0, 650.0)
                        .on_navigation(move |url| {
                            url.origin().ascii_serialization() == allowed_origin
                        })
                        .build()
                {
                    let exit_handle = handle.clone();
                    handle
                        .dialog()
                        .message(error.to_string())
                        .title(format!("{} 无法启动", config.product_name))
                        .kind(MessageDialogKind::Error)
                        .show(move |_| exit_handle.exit(1));
                    return;
                }
                update::start(&handle);
            });
            Ok(())
        });

    let app = builder
        .build(context)
        .unwrap_or_else(|error| panic!("failed to build {product_name} desktop host: {error}"));
    app.run(|app, event| match event {
        RunEvent::ExitRequested { .. } => {
            if let Some(host) = app.try_state::<HostProcess>() {
                host.stop();
            }
            app.state::<update::UpdateState>().install_pending();
        }
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" && cfg!(target_os = "macos") => {
            api.prevent_close();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Destroyed,
            ..
        } if label == "main" && !cfg!(target_os = "macos") => {
            app.exit(0);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}
