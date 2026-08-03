use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::PathBuf, process::Command};
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
    let node = std::env::var("MOTION_NODE_BINARY").unwrap_or_else(|_| "node".into());
    let output = tauri::async_runtime::spawn_blocking(move || {
        Command::new(node)
            .arg(runner)
            .arg(data_root)
            .arg(encoded)
            .output()
    })
    .await
    .map_err(|e| reject("INTERNAL_ERROR", e.to_string()))?
    .map_err(|e| {
        reject(
            "INTERNAL_ERROR",
            format!("Could not start local service: {e}"),
        )
    })?;
    let reply: RunnerReply = serde_json::from_slice(&output.stdout)
        .map_err(|_| reject("INTERNAL_ERROR", String::from_utf8_lossy(&output.stderr)))?;
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
        .invoke_handler(tauri::generate_handler![
            app_dispatch,
            motion_ui_load,
            motion_ui_save
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Motion desktop");
}
