use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

struct PendingUpdate {
    update: Update,
    bytes: Vec<u8>,
}

#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<PendingUpdate>>,
}

impl UpdateState {
    pub fn install_pending(&self) {
        let Ok(mut pending) = self.pending.lock() else {
            return;
        };
        let Some(pending) = pending.take() else {
            return;
        };
        if let Err(error) = pending.update.install(pending.bytes) {
            eprintln!("[updater] install failed: {error}");
        }
    }
}

pub fn start(app: &AppHandle) {
    if cfg!(debug_assertions) || std::env::var("DEEPPATH_APP_UPDATE").as_deref() == Ok("0") {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            check_once(&app).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

async fn check_once(app: &AppHandle) {
    if app
        .state::<UpdateState>()
        .pending
        .lock()
        .map(|pending| pending.is_some())
        .unwrap_or(true)
    {
        return;
    }
    let _ = app.emit(
        "app-update-state",
        serde_json::json!({ "phase": "checking" }),
    );
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            eprintln!("[updater] initialization failed: {error}");
            return;
        }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            let _ = app.emit("app-update-state", serde_json::json!({ "phase": "idle" }));
            return;
        }
        Err(error) => {
            eprintln!("[updater] check failed: {error}");
            let _ = app.emit(
                "app-update-state",
                serde_json::json!({ "phase": "error", "message": error.to_string() }),
            );
            return;
        }
    };
    let version = update.version.clone();
    let _ = app.emit(
        "app-update-state",
        serde_json::json!({ "phase": "downloading", "version": version }),
    );
    let bytes = match update.download(|_chunk, _total| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("[updater] download failed: {error}");
            let _ = app.emit(
                "app-update-state",
                serde_json::json!({
                    "phase": "error",
                    "version": version,
                    "message": error.to_string()
                }),
            );
            return;
        }
    };
    if let Ok(mut pending) = app.state::<UpdateState>().pending.lock() {
        *pending = Some(PendingUpdate { update, bytes });
    }
    let _ = app.emit(
        "app-update-state",
        serde_json::json!({ "phase": "ready", "version": version }),
    );
}
