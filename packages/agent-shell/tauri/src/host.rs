use crate::DesktopConfig;
use command_group::{CommandGroup, GroupChild};
#[cfg(unix)]
use command_group::{Signal, UnixChildExt};
use serde::{Deserialize, Serialize};
use std::env;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use url::Url;

const READY_PREFIX: &str = "STEERABLE_HOST_READY ";
const START_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Deserialize, Serialize)]
struct ReadyRecord {
    host: String,
    port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PythonRunnerLock {
    version: String,
    python_version: String,
    python_build_standalone_release: String,
    targets: std::collections::HashMap<String, PythonRunnerTarget>,
}

#[derive(Deserialize)]
struct PythonRunnerTarget {
    triple: String,
    sha256: String,
    runner: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductRuntime {
    python_runner: Option<String>,
}

fn write_diag(dir: &Path, name: &str, body: &str) {
    let _ = std::fs::write(dir.join(name), body);
}

fn append_diag(dir: &Path, name: &str, line: &str) {
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(name))
    {
        let _ = writeln!(file, "{line}");
    }
}

pub struct HostProcess {
    child: Mutex<Option<GroupChild>>,
}

impl HostProcess {
    pub fn spawn(app: &AppHandle, config: &DesktopConfig) -> Result<(Self, Url), String> {
        match Self::spawn_inner(app, config) {
            Ok(started) => Ok(started),
            Err(error) => {
                if let Some(dir) = env::var_os("DEEPPATH_USER_DATA_DIR") {
                    let dir = PathBuf::from(dir);
                    let _ = std::fs::create_dir_all(&dir);
                    write_diag(&dir, "host-error.txt", &error);
                }
                Err(error)
            }
        }
    }

    fn spawn_inner(app: &AppHandle, config: &DesktopConfig) -> Result<(Self, Url), String> {
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
        let sidecar_tmp = user_data.join("sidecar/tmp");
        std::fs::create_dir_all(&sidecar_tmp).map_err(|error| error.to_string())?;
        let python_runner = paths.resolve_python_runner(app, config, &user_data);
        if let Err(error) = &python_runner {
            eprintln!("[python-runner] {error}; run_code will be unavailable");
            app.dialog()
                .message(format!(
                    "Python 运行器安装失败，run_code 本次不可用。\n\n{error}"
                ))
                .title("Python 运行器")
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
        write_diag(
            &user_data,
            "host-spawn.txt",
            &format!(
                "node={}\nserver={}\napp_root={}\nweb_dist={}\n",
                paths.node.display(),
                paths.server_entry.display(),
                paths.app_root.display(),
                paths.web_dist.display()
            ),
        );

        let mut command = Command::new(&paths.node);
        command
            .arg(&paths.server_entry)
            .current_dir(&paths.app_root)
            .env("APP_FLAVOR", &config.product_id)
            .env("VITE_APP_FLAVOR", &config.product_id)
            .env("DEEPPATH_BS_HOST", "127.0.0.1")
            .env("DEEPPATH_BS_PORT", "0")
            .env("DEEPPATH_WEB_DIST", &paths.web_dist)
            .env("DEEPPATH_USER_DATA_DIR", &user_data)
            .env("TMPDIR", &sidecar_tmp)
            .env("TMP", &sidecar_tmp)
            .env("TEMP", &sidecar_tmp)
            .env("STEERABLE_HOST_PARENT_PID", std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        paths.apply_runtime_env(&mut command, python_runner.ok().flatten());

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
        let stdout_dir = user_data.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        println!("[node-host] {line}");
                        append_diag(&stdout_dir, "host-node.log", &line);
                        if let Some(record) = line.strip_prefix(READY_PREFIX) {
                            let parsed = serde_json::from_str::<ReadyRecord>(record)
                                .map_err(|error| error.to_string());
                            let _ = ready_tx.send(parsed);
                        }
                    }
                    Err(error) => {
                        append_diag(
                            &stdout_dir,
                            "host-node.log",
                            &format!("stdout error: {error}"),
                        );
                        let _ = ready_tx.send(Err(error.to_string()));
                        break;
                    }
                }
            }
        });
        let stderr_dir = user_data.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[node-host] {line}");
                append_diag(&stderr_dir, "host-node.log", &line);
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
        write_diag(
            &user_data,
            "host-ready.json",
            &serde_json::to_string(&ready).map_err(|error| error.to_string())?,
        );
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
    fn apply_runtime_env(&self, command: &mut Command, python_runner: Option<PathBuf>) {
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
        let win_spawn_helper = engine_dir.join("win-spawn-helper/win-spawn-helper.exe");
        if win_spawn_helper.exists() {
            command.env("DEEPPATH_WIN_SPAWN_HELPER", win_spawn_helper);
        }
        if let Some(python_runner) = python_runner {
            command.env("STEERABLE_PYTHON", python_runner);
        }
    }

    fn resolve_python_runner(
        &self,
        app: &AppHandle,
        config: &DesktopConfig,
        user_data: &Path,
    ) -> Result<Option<PathBuf>, String> {
        if let Some(explicit) = env::var_os("STEERABLE_PYTHON") {
            let explicit = PathBuf::from(explicit);
            if explicit.is_absolute() && explicit.is_file() {
                return Ok(Some(explicit));
            }
            return Err("STEERABLE_PYTHON must name an existing absolute file".into());
        }
        let Some(engine_dir) = &self.engine_dir else {
            return Ok(None);
        };
        let product: ProductRuntime = serde_json::from_str(
            &std::fs::read_to_string(
                self.app_root
                    .join("products")
                    .join(&config.product_id)
                    .join("product.json"),
            )
            .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let Some(python_runner_mode) = product.python_runner.as_deref() else {
            return Ok(None);
        };
        let lock: PythonRunnerLock = serde_json::from_str(
            &std::fs::read_to_string(engine_dir.join("python-runner-lock.json"))
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let target_name = platform_tag();
        let target = lock
            .targets
            .get(target_name)
            .ok_or_else(|| format!("Python runner does not support {target_name}"))?;

        if python_runner_mode == "bundle" {
            let runner = engine_dir.join("python-runner").join(&target.runner);
            return runner
                .is_file()
                .then_some(Some(runner))
                .ok_or_else(|| "bundled Python runner is missing".to_string());
        }
        if python_runner_mode != "download" {
            return Err(format!(
                "unsupported pythonRunner mode {python_runner_mode:?}"
            ));
        }
        let destination = user_data
            .join("python-runner")
            .join(&lock.version)
            .join(target_name);
        let runner = destination.join(&target.runner);
        if runner.exists() {
            return Ok(Some(runner));
        }
        let confirmed = app
            .dialog()
            .message(
                "Aroli 需要下载独立的 Python 运行器才能使用 run_code。\n\n\
                 不安装不会影响聊天和其他工具。下载内容会经过 SHA-256 校验。",
            )
            .title("安装 Python 代码运行器")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "下载并安装".to_string(),
                "暂不安装".to_string(),
            ))
            .blocking_show();
        if !confirmed {
            return Ok(None);
        }

        let filename = format!(
            "cpython-{}+{}-{}-install_only_stripped.tar.gz",
            lock.python_version, lock.python_build_standalone_release, target.triple
        );
        let url = format!(
            "https://github.com/astral-sh/python-build-standalone/releases/download/{}/{}",
            lock.python_build_standalone_release, filename
        );
        let installer = engine_dir.join("install-python-runner.mjs");
        let status = Command::new(&self.node)
            .arg(installer)
            .args(["--url", &url, "--sha256", &target.sha256, "--destination"])
            .arg(&destination)
            .args(["--runner", &target.runner])
            .status()
            .map_err(|error| format!("failed to start Python runner installer: {error}"))?;
        if !status.success() || !runner.exists() {
            return Err(format!("Python runner installer exited with {status}"));
        }
        Ok(Some(runner))
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
        let host_root = resource_dir.join("node-host");
        let app_root = host_root.join("app-dist");
        Ok(Self {
            node: env::var_os("DEEPPATH_TAURI_NODE")
                .map(PathBuf::from)
                .unwrap_or_else(|| resource_dir.join(node_resource_name())),
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
        "engine/node.exe"
    } else {
        "node/node"
    }
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
