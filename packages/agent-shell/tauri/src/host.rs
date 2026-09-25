use crate::DesktopConfig;
use command_group::{CommandGroup, GroupChild};
#[cfg(unix)]
use command_group::{Signal, UnixChildExt};
use serde::Deserialize;
use std::env;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use url::Url;

const READY_PREFIX: &str = "STEERABLE_HOST_READY ";
const START_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
struct ReadyRecord {
    host: String,
    port: u16,
}

pub struct HostProcess {
    child: Mutex<Option<GroupChild>>,
}

impl HostProcess {
    pub fn spawn(app: &AppHandle, config: &DesktopConfig) -> Result<(Self, Url), String> {
        let paths = HostPaths::resolve(app, config)?;
        let user_data = match env::var_os("DEEPPATH_USER_DATA_DIR") {
            Some(path) => PathBuf::from(path),
            None => app
                .path()
                .home_dir()
                .map_err(|error| error.to_string())?
                .join(&config.data_dir_name),
        };
        std::fs::create_dir_all(&user_data).map_err(|error| error.to_string())?;

        let mut command = Command::new(&paths.node);
        command
            .arg(&paths.server_entry)
            .current_dir(&paths.app_root)
            .env("APP_FLAVOR", &config.product_id)
            .env("VITE_APP_FLAVOR", &config.product_id)
            .env("DEEPPATH_BS_HOST", "127.0.0.1")
            .env("DEEPPATH_BS_PORT", "0")
            .env("DEEPPATH_WEB_DIST", &paths.web_dist)
            .env("DEEPPATH_USER_DATA_DIR", user_data)
            .env("STEERABLE_HOST_PARENT_PID", std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        paths.apply_runtime_env(&mut command);

        let mut child = spawn_group(&mut command).map_err(|error| {
            format!(
                "failed to start Node host with {}: {error}",
                paths.node.display()
            )
        })?;
        let stdout = child
            .inner()
            .stdout
            .take()
            .ok_or_else(|| "Node host stdout was not piped".to_string())?;
        let stderr = child
            .inner()
            .stderr
            .take()
            .ok_or_else(|| "Node host stderr was not piped".to_string())?;

        let (ready_tx, ready_rx) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        println!("[node-host] {line}");
                        if let Some(record) = line.strip_prefix(READY_PREFIX) {
                            let parsed = serde_json::from_str::<ReadyRecord>(record)
                                .map_err(|error| error.to_string());
                            let _ = ready_tx.send(parsed);
                        }
                    }
                    Err(error) => {
                        let _ = ready_tx.send(Err(error.to_string()));
                        break;
                    }
                }
            }
        });
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[node-host] {line}");
            }
        });

        let started = Instant::now();
        let ready = loop {
            match ready_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(result) => break result?,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = child.kill();
                    return Err("Node host exited before reporting readiness".to_string());
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                return Err(format!(
                    "Node host exited before reporting readiness: {status}"
                ));
            }
            if started.elapsed() >= START_TIMEOUT {
                let _ = child.kill();
                return Err("Node host did not become ready within 30 seconds".to_string());
            }
        };
        let url = Url::parse(&format!("http://{}:{}/", ready.host, ready.port))
            .map_err(|error| error.to_string())?;
        Ok((
            Self {
                child: Mutex::new(Some(child)),
            },
            url,
        ))
    }

    pub fn stop(&self) {
        let Ok(mut child) = self.child.lock() else {
            return;
        };
        if let Some(mut child) = child.take() {
            #[cfg(unix)]
            {
                let _ = child.signal(Signal::SIGTERM);
                let deadline = Instant::now() + Duration::from_secs(5);
                while Instant::now() < deadline {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

struct HostPaths {
    node: PathBuf,
    server_entry: PathBuf,
    app_root: PathBuf,
    web_dist: PathBuf,
    engine_dir: Option<PathBuf>,
}

impl HostPaths {
    fn apply_runtime_env(&self, command: &mut Command) {
        let Some(engine_dir) = &self.engine_dir else {
            return;
        };
        let rust_sidecar = engine_dir.join(platform_binary("steerable-sidecar"));
        if rust_sidecar.exists() {
            command
                .env("STEERABLE_RUST_SIDECAR", "1")
                .env("STEERABLE_RUST_SIDECAR_BIN", rust_sidecar);
        }
        let egress_proxy = engine_dir.join(platform_binary("steerable-egress-proxy"));
        if egress_proxy.exists() {
            command.env("STEERABLE_EGRESS_PROXY_BIN", egress_proxy);
        }
        let python =
            engine_dir
                .join("python-runtime")
                .join(platform_tag())
                .join(if cfg!(windows) {
                    "python/python.exe"
                } else {
                    "python/bin/python3"
                });
        if python.exists() {
            command.env("STEERABLE_SIDECAR_PYTHON", python);
        }
        let win_spawn_helper = engine_dir.join("win-spawn-helper/win-spawn-helper.exe");
        if win_spawn_helper.exists() {
            command.env("DEEPPATH_WIN_SPAWN_HELPER", win_spawn_helper);
        }
    }

    fn resolve(app: &AppHandle, config: &DesktopConfig) -> Result<Self, String> {
        if cfg!(debug_assertions) {
            let app_root = config.development_root.clone();
            return Ok(Self {
                node: env::var_os("DEEPPATH_TAURI_NODE")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("node")),
                server_entry: env::var_os("DEEPPATH_TAURI_SERVER_ENTRY")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| app_root.join("dist/devtools/dev-server.js")),
                web_dist: env::var_os("DEEPPATH_WEB_DIST")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        app_root
                            .join("products")
                            .join(&config.product_id)
                            .join("web/dist")
                    }),
                app_root,
                engine_dir: None,
            });
        }

        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?;
        let resource_dir = node_compatible_path(&resource_dir);
        let host_root = resource_dir.join("node-host");
        let app_root = host_root.join("app-dist");
        let engine_node = resource_dir.join("engine").join(platform_binary("node"));
        Ok(Self {
            node: env::var_os("DEEPPATH_TAURI_NODE")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    if engine_node.exists() {
                        engine_node
                    } else {
                        resource_dir.join(node_resource_name())
                    }
                }),
            server_entry: app_root
                .join("products")
                .join(&config.product_id)
                .join("server.js"),
            web_dist: host_root.join("web-dist"),
            app_root,
            engine_dir: Some(resource_dir.join("engine")),
        })
    }
}

fn platform_binary(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn platform_tag() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-x64"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "win32-x64"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-x64"
    } else {
        "unsupported"
    }
}

fn node_resource_name() -> &'static str {
    if cfg!(windows) {
        "node/node.exe"
    } else {
        "node/node"
    }
}

fn node_compatible_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        let wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
        let verbatim_unc = r"\\?\UNC\".encode_utf16().collect::<Vec<_>>();
        if let Some(rest) = wide.strip_prefix(verbatim_unc.as_slice()) {
            let mut normalized = r"\\".encode_utf16().collect::<Vec<_>>();
            normalized.extend_from_slice(rest);
            return PathBuf::from(OsString::from_wide(&normalized));
        }
        let verbatim = r"\\?\".encode_utf16().collect::<Vec<_>>();
        if let Some(rest) = wide.strip_prefix(verbatim.as_slice()) {
            return PathBuf::from(OsString::from_wide(rest));
        }
    }
    path.to_path_buf()
}

fn spawn_group(command: &mut Command) -> std::io::Result<GroupChild> {
    #[cfg(windows)]
    {
        return command.group().kill_on_drop(true).spawn();
    }
    #[cfg(not(windows))]
    {
        command.group_spawn()
    }
}

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;
