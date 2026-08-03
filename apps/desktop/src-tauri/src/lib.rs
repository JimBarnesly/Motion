use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::Manager;

const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IpcRequest {
    protocol_version: u8,
    lane: String,
    payload: Value,
}

#[derive(Deserialize)]
struct RunnerReply {
    ok: bool,
    value: Option<Value>,
    error: Option<IpcError>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct IpcError {
    code: String,
    message: String,
}

fn reject(code: &str, message: impl Into<String>) -> IpcError {
    IpcError {
        code: code.into(),
        message: message.into(),
    }
}

struct ServiceProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Drop for ServiceProcess {
    fn drop(&mut self) {
        let _ = self.stdin.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Clone, Default)]
struct ServiceState {
    process: Arc<Mutex<Option<ServiceProcess>>>,
}

fn start_service(runner: &Path, data_root: &Path) -> Result<ServiceProcess, IpcError> {
    let node = std::env::var("MOTION_NODE_BINARY").unwrap_or_else(|_| "node".into());
    let mut child = Command::new(node)
        .arg(runner)
        .arg(data_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| {
            reject(
                "INTERNAL_ERROR",
                format!("Could not start local service: {e}"),
            )
        })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| reject("INTERNAL_ERROR", "Service stdin unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| reject("INTERNAL_ERROR", "Service stdout unavailable"))?;
    Ok(ServiceProcess {
        child,
        stdin,
        stdout: BufReader::new(stdout),
    })
}

fn exchange(process: &mut ServiceProcess, encoded: &str) -> Result<RunnerReply, IpcError> {
    process
        .stdin
        .write_all(encoded.as_bytes())
        .and_then(|_| process.stdin.write_all(b"\n"))
        .and_then(|_| process.stdin.flush())
        .map_err(|e| reject("INTERNAL_ERROR", format!("Service request failed: {e}")))?;
    let mut response = String::new();
    let read = process
        .stdout
        .read_line(&mut response)
        .map_err(|e| reject("INTERNAL_ERROR", format!("Service response failed: {e}")))?;
    if read == 0 {
        return Err(reject(
            "INTERNAL_ERROR",
            "Local service stopped unexpectedly",
        ));
    }
    serde_json::from_str(&response)
        .map_err(|e| reject("INTERNAL_ERROR", format!("Invalid service response: {e}")))
}

#[tauri::command]
async fn app_dispatch(app: tauri::AppHandle, request: IpcRequest) -> Result<Value, IpcError> {
    if request.protocol_version != 1 {
        return Err(reject("INVALID_INPUT", "Unsupported IPC protocol version"));
    }
    if !matches!(
        request.lane.as_str(),
        "command" | "query" | "async-command" | "async-query"
    ) {
        return Err(reject("INVALID_INPUT", "Unsupported IPC lane"));
    }
    run_service(
        app,
        serde_json::json!({ "lane": request.lane, "payload": request.payload }),
    )
    .await
}

#[tauri::command]
async fn motion_ui_load(app: tauri::AppHandle, schema_version: u8) -> Result<Value, IpcError> {
    if schema_version != 1 {
        return Err(reject("INVALID_INPUT", "Unsupported UI schema version"));
    }
    run_service(
        app,
        serde_json::json!({ "lane": "ui-load", "payload": { "schemaVersion": 1 } }),
    )
    .await
}

#[tauri::command]
async fn motion_ui_save(
    app: tauri::AppHandle,
    document: Value,
    schema_version: u8,
) -> Result<Value, IpcError> {
    if schema_version != 1 {
        return Err(reject("INVALID_INPUT", "Unsupported UI schema version"));
    }
    run_service(app, serde_json::json!({ "lane": "ui-save", "payload": { "schemaVersion": 1, "document": document } })).await
}

async fn run_service(app: tauri::AppHandle, envelope: Value) -> Result<Value, IpcError> {
    let encoded =
        serde_json::to_string(&envelope).map_err(|e| reject("INVALID_INPUT", e.to_string()))?;
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err(reject("INVALID_INPUT", "IPC request exceeds 16 MiB"));
    }

    let data_root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| reject("STORAGE_FAILURE", e.to_string()))?;
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let packaged_runner = app
        .path()
        .resource_dir()
        .map_err(|e| reject("INTERNAL_ERROR", e.to_string()))?
        .join("service-bundle.mjs");
    let runner = if packaged_runner.exists() {
        packaged_runner
    } else {
        manifest.join("..").join("dist").join("service-bundle.mjs")
    };
    let state = app.state::<ServiceState>().inner().clone();
    let reply = tauri::async_runtime::spawn_blocking(move || {
        let mut guard = state
            .process
            .lock()
            .map_err(|_| reject("INTERNAL_ERROR", "Service lock poisoned"))?;
        if guard
            .as_mut()
            .is_some_and(|process| process.child.try_wait().ok().flatten().is_some())
        {
            *guard = None;
        }
        if guard.is_none() {
            *guard = Some(start_service(&runner, &data_root)?);
        }
        let reply = exchange(guard.as_mut().expect("service initialized"), &encoded);
        if reply.is_err() {
            // Never replay a mutation after an ambiguous process failure. The next
            // request starts a clean runner and the caller can reload durable state.
            *guard = None;
        }
        reply
    })
    .await
    .map_err(|e| reject("INTERNAL_ERROR", e.to_string()))??;
    if reply.ok {
        reply
            .value
            .ok_or_else(|| reject("INTERNAL_ERROR", "Service returned no value"))
    } else {
        Err(reply
            .error
            .unwrap_or_else(|| reject("INTERNAL_ERROR", "Service failed without an error")))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServiceState::default())
        .invoke_handler(tauri::generate_handler![
            app_dispatch,
            motion_ui_load,
            motion_ui_save
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Motion desktop");
}
