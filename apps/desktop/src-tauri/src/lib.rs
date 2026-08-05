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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UiLoadRequest {
    schema_version: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UiSaveRequest {
    schema_version: u8,
    document: Value,
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

fn validate_dispatch_request(request: &IpcRequest) -> Result<(), IpcError> {
    if request.protocol_version != 1 {
        return Err(reject("INVALID_INPUT", "Unsupported IPC protocol version"));
    }
    let payload = request
        .payload
        .as_object()
        .ok_or_else(|| reject("INVALID_INPUT", "IPC payload must be an object"))?;
    let operation = payload
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| reject("INVALID_INPUT", "IPC payload requires an operation type"))?;
    // Keep this list aligned with production callers in apps/web/app-adapter.js.
    // Page/workspace mutations use the separately validated motion_ui_save command.
    let allowed: &[&str] = match (request.lane.as_str(), operation) {
        ("query", "workspace.list") => &["type"],
        ("query", "workspace.export") => &["type", "workspaceId"],
        ("query", "workspace.search") => &["type", "workspaceId", "query", "limit"],
        ("async-command", "attachment.put") => &[
            "type",
            "workspaceId",
            "expectedRevision",
            "id",
            "fileName",
            "mediaType",
            "sha256",
            "bytes",
        ],
        ("async-command", "backup.restore-new") => &["type", "bundle", "newWorkspaceId"],
        ("async-query", "backup.create") => &["type", "workspaceId", "createdAt"],
        ("async-query", "backup.verify" | "backup.preview") => &["type", "bundle"],
        _ => {
            return Err(reject(
                "INVALID_INPUT",
                "IPC operation is not allowed on this lane",
            ))
        }
    };
    if payload.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(reject(
            "INVALID_INPUT",
            "IPC payload contains an unsupported field",
        ));
    }
    Ok(())
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

fn select_node_binary(
    resource_dir: &Path,
    development_override: Option<std::ffi::OsString>,
) -> PathBuf {
    let bundled = resource_dir.join("node-runtime");
    if bundled.is_file() {
        return bundled;
    }
    development_override
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("node"))
}

fn start_service(node: &Path, runner: &Path, data_root: &Path) -> Result<ServiceProcess, IpcError> {
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
    validate_dispatch_request(&request)?;
    run_service(
        app,
        serde_json::json!({ "lane": request.lane, "payload": request.payload }),
    )
    .await
}

#[tauri::command]
async fn motion_ui_load(app: tauri::AppHandle, request: UiLoadRequest) -> Result<Value, IpcError> {
    if request.schema_version != 1 {
        return Err(reject("INVALID_INPUT", "Unsupported UI schema version"));
    }
    run_service(
        app,
        serde_json::json!({ "lane": "ui-load", "payload": { "schemaVersion": 1 } }),
    )
    .await
}

#[tauri::command]
async fn motion_ui_save(app: tauri::AppHandle, request: UiSaveRequest) -> Result<Value, IpcError> {
    if request.schema_version != 1 {
        return Err(reject("INVALID_INPUT", "Unsupported UI schema version"));
    }
    run_service(app, serde_json::json!({ "lane": "ui-save", "payload": { "schemaVersion": 1, "document": request.document } })).await
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
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| reject("INTERNAL_ERROR", e.to_string()))?;
    let packaged_runner = resource_dir.join("service-bundle.mjs");
    let runner = if packaged_runner.exists() {
        packaged_runner
    } else {
        manifest.join("..").join("dist").join("service-bundle.mjs")
    };
    let node = select_node_binary(&resource_dir, std::env::var_os("MOTION_NODE_BINARY"));
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
            *guard = Some(start_service(&node, &runner, &data_root)?);
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

#[cfg(test)]
mod tests {
    use super::{select_node_binary, validate_dispatch_request, IpcRequest};
    use serde_json::json;
    use std::{ffi::OsString, fs, path::PathBuf};

    #[test]
    fn bundled_runtime_wins_over_development_override() {
        let root =
            std::env::temp_dir().join(format!("motion-node-selection-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("node-runtime"), b"runtime").unwrap();
        assert_eq!(
            select_node_binary(&root, Some(OsString::from("/development/node"))),
            root.join("node-runtime")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn development_override_is_used_without_bundle() {
        assert_eq!(
            select_node_binary(
                &PathBuf::from("/missing-motion-resources"),
                Some(OsString::from("/development/node"))
            ),
            PathBuf::from("/development/node")
        );
    }

    #[test]
    fn dispatch_rejects_unknown_commands_and_injected_capabilities() {
        let unknown = IpcRequest {
            protocol_version: 1,
            lane: "command".into(),
            payload: json!({ "type": "shell.execute", "command": "id" }),
        };
        assert_eq!(
            validate_dispatch_request(&unknown).unwrap_err().code,
            "INVALID_INPUT"
        );
        let path_injection = IpcRequest {
            protocol_version: 1,
            lane: "async-command".into(),
            payload: json!({
                "type": "attachment.put", "workspaceId": "w", "expectedRevision": 1, "fileName": "x", "mediaType": "text/plain",
                "sha256": "0".repeat(64), "bytes": { "$motionBytes": [] }, "path": "/etc/passwd"
            }),
        };
        assert_eq!(
            validate_dispatch_request(&path_injection).unwrap_err().code,
            "INVALID_INPUT"
        );
        let wrong_lane = IpcRequest {
            protocol_version: 1,
            lane: "query".into(),
            payload: json!({ "type": "backup.restore-new", "bundle": {} }),
        };
        assert_eq!(
            validate_dispatch_request(&wrong_lane).unwrap_err().code,
            "INVALID_INPUT"
        );
    }

    #[test]
    fn dispatch_accepts_documented_attachment_boundary() {
        let request = IpcRequest {
            protocol_version: 1,
            lane: "async-command".into(),
            payload: json!({
                "type": "attachment.put", "workspaceId": "workspace", "expectedRevision": 1,
                "fileName": "attachment.txt", "mediaType": "text/plain", "sha256": "0".repeat(64),
                "bytes": { "$motionBytes": [] }
            }),
        };
        assert!(validate_dispatch_request(&request).is_ok());
    }
}
