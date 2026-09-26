use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);
const EVENT: &str = "app-update-state";

/// 渲染层看到的版本与更新状态。`version` 是当前安装版本。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppReleaseSnapshot {
    version: String,
    enabled: bool,
    phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    available_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

struct Tracked {
    phase: String,
    available_version: Option<String>,
    percent: Option<u8>,
    message: Option<String>,
}

impl Tracked {
    fn idle() -> Self {
        Self {
            phase: "idle".into(),
            available_version: None,
            percent: None,
            message: None,
        }
    }
}

struct PendingUpdate {
    update: Update,
    bytes: Vec<u8>,
}

pub struct UpdateState {
    pending: Mutex<Option<PendingUpdate>>,
    tracked: Mutex<Tracked>,
    gate: tokio::sync::Mutex<()>,
}

impl Default for UpdateState {
    fn default() -> Self {
        Self {
            pending: Mutex::new(None),
            tracked: Mutex::new(Tracked::idle()),
            gate: tokio::sync::Mutex::new(()),
        }
    }
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

/// 开发构建只检查、不下载、不替换正在跑的程序。
/// `DEEPPATH_APP_UPDATE=1` 强制打开安装；`=0` 连检查也关掉。
fn updates_enabled() -> bool {
    std::env::var("DEEPPATH_APP_UPDATE").as_deref() != Ok("0")
}

fn install_allowed() -> bool {
    match std::env::var("DEEPPATH_APP_UPDATE").as_deref() {
        Ok("0") => false,
        Ok("1") => true,
        _ => !cfg!(debug_assertions),
    }
}

fn clip_message(message: String) -> String {
    const MAX: usize = 180;
    let mut chars = message.chars();
    let clipped: String = chars.by_ref().take(MAX).collect();
    if chars.next().is_some() {
        format!("{clipped}…")
    } else {
        clipped
    }
}

fn next_download_percent(downloaded: u64, total: u64, previous: u8) -> Option<u8> {
    if total == 0 {
        return None;
    }
    let percent = ((downloaded.saturating_mul(100)) / total).min(100) as u8;
    if percent != previous && (percent == 100 || percent >= previous.saturating_add(5)) {
        Some(percent)
    } else {
        None
    }
}

fn snapshot(app: &AppHandle) -> AppReleaseSnapshot {
    let enabled = updates_enabled();
    let state = app.state::<UpdateState>();
    let tracked = state.tracked.lock().ok();
    let (phase, available_version, percent, message) = if let Some(tracked) = tracked.as_ref() {
        (
            if enabled {
                tracked.phase.clone()
            } else {
                "disabled".into()
            },
            if enabled {
                tracked.available_version.clone()
            } else {
                None
            },
            if enabled { tracked.percent } else { None },
            if enabled {
                tracked.message.clone()
            } else {
                None
            },
        )
    } else if enabled {
        ("idle".into(), None, None, None)
    } else {
        ("disabled".into(), None, None, None)
    };
    AppReleaseSnapshot {
        version: app.package_info().version.to_string(),
        enabled,
        phase,
        available_version,
        percent,
        message,
    }
}

fn publish(
    app: &AppHandle,
    phase: &str,
    available_version: Option<String>,
    percent: Option<u8>,
    message: Option<String>,
) {
    if let Ok(mut tracked) = app.state::<UpdateState>().tracked.lock() {
        tracked.phase = phase.to_string();
        tracked.available_version = available_version;
        tracked.percent = percent;
        tracked.message = message;
    }
    let _ = app.emit(EVENT, snapshot(app));
}

fn has_pending(app: &AppHandle) -> bool {
    app.state::<UpdateState>()
        .pending
        .lock()
        .map(|pending| pending.is_some())
        .unwrap_or(true)
}

pub fn start(app: &AppHandle) {
    if !install_allowed() {
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

pub async fn check_once(app: &AppHandle) {
    let state = app.state::<UpdateState>();
    let _gate = state.gate.lock().await;
    if !updates_enabled() {
        publish(app, "disabled", None, None, None);
        return;
    }
    if has_pending(app) {
        return;
    }
    publish(app, "checking", None, None, None);
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            eprintln!("[updater] initialization failed: {error}");
            publish(
                app,
                "error",
                None,
                None,
                Some(clip_message(error.to_string())),
            );
            return;
        }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            publish(app, "idle", None, None, Some("已是最新".into()));
            return;
        }
        Err(error) => {
            eprintln!("[updater] check failed: {error}");
            publish(
                app,
                "error",
                None,
                None,
                Some(clip_message(error.to_string())),
            );
            return;
        }
    };
    let version = update.version.clone();
    if !install_allowed() {
        publish(
            app,
            "idle",
            Some(version.clone()),
            None,
            Some("开发构建不安装更新".into()),
        );
        return;
    }
    publish(app, "downloading", Some(version.clone()), Some(0), None);
    let mut downloaded: u64 = 0;
    let mut last_percent: u8 = 0;
    let bytes = match update
        .download(
            |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                let Some(total) = total else {
                    return;
                };
                let Some(percent) = next_download_percent(downloaded, total, last_percent) else {
                    return;
                };
                last_percent = percent;
                publish(
                    app,
                    "downloading",
                    Some(version.clone()),
                    Some(percent),
                    None,
                );
            },
            || {},
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("[updater] download failed: {error}");
            publish(
                app,
                "error",
                Some(version),
                None,
                Some(clip_message(error.to_string())),
            );
            return;
        }
    };
    if let Ok(mut pending) = app.state::<UpdateState>().pending.lock() {
        *pending = Some(PendingUpdate { update, bytes });
    }
    publish(app, "ready", Some(version), None, None);
}

#[tauri::command]
pub fn app_release_snapshot(app: AppHandle) -> AppReleaseSnapshot {
    snapshot(&app)
}

#[tauri::command]
pub async fn app_release_check(app: AppHandle) -> AppReleaseSnapshot {
    check_once(&app).await;
    snapshot(&app)
}

#[tauri::command]
pub async fn app_release_install(app: AppHandle) -> AppReleaseSnapshot {
    if !install_allowed() {
        publish(&app, "error", None, None, Some("开发构建不安装更新".into()));
        return snapshot(&app);
    }
    let pending = app
        .state::<UpdateState>()
        .pending
        .lock()
        .ok()
        .and_then(|mut pending| pending.take());
    let Some(pending) = pending else {
        return snapshot(&app);
    };
    let version = pending.update.version.clone();
    publish(&app, "installing", Some(version.clone()), None, None);
    let joined =
        tauri::async_runtime::spawn_blocking(move || pending.update.install(pending.bytes)).await;
    match joined {
        Ok(Ok(())) => {
            app.request_restart();
        }
        Ok(Err(error)) => {
            eprintln!("[updater] install failed: {error}");
            publish(
                &app,
                "error",
                Some(version),
                None,
                Some(clip_message(error.to_string())),
            );
        }
        Err(error) => {
            publish(
                &app,
                "error",
                Some(version),
                None,
                Some(clip_message(error.to_string())),
            );
        }
    }
    snapshot(&app)
}

#[cfg(test)]
mod tests {
    use super::{clip_message, next_download_percent};

    #[test]
    fn reports_download_percent_in_steps() {
        assert_eq!(next_download_percent(0, 0, 0), None);
        assert_eq!(next_download_percent(4, 100, 0), None);
        assert_eq!(next_download_percent(5, 100, 0), Some(5));
        assert_eq!(next_download_percent(9, 100, 5), None);
        assert_eq!(next_download_percent(96, 100, 90), Some(96));
        assert_eq!(next_download_percent(100, 100, 96), Some(100));
        assert_eq!(next_download_percent(100, 100, 100), None);
    }

    #[test]
    fn clips_long_updater_errors() {
        assert_eq!(clip_message("短".into()), "短");
        let long = "错".repeat(200);
        let clipped = clip_message(long);
        assert!(clipped.ends_with('…'));
        assert_eq!(clipped.chars().count(), 181);
    }
}
