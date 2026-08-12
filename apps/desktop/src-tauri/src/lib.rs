use rfd::{FileDialog, MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
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
include!(concat!(env!("OUT_DIR"), "/attachment_policy.rs"));

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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupSaveRequest {
    schema_version: u8,
    bundle: Value,
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

fn valid_ui_state_id(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(id) => {
            !id.is_empty()
                && id.len() <= 160
                && id.as_bytes()[0].is_ascii_alphanumeric()
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
        }
        _ => false,
    }
}

fn validate_ui_state_document(document: &Value) -> Result<(), IpcError> {
    let state = document
        .as_object()
        .ok_or_else(|| reject("INVALID_INPUT", "Invalid UI state request"))?;
    if state
        .keys()
        .any(|key| !matches!(key.as_str(), "workspaceId" | "activePageId" | "expandedPageIds"))
        || !state.get("workspaceId").map_or(true, valid_ui_state_id)
        || !state.get("activePageId").map_or(true, valid_ui_state_id)
    {
        return Err(reject("INVALID_INPUT", "Invalid UI state request"));
    }
    if let Some(expanded) = state.get("expandedPageIds") {
        let ids = expanded
            .as_array()
            .filter(|ids| ids.len() <= 256)
            .ok_or_else(|| reject("INVALID_INPUT", "Invalid UI state request"))?;
        let mut unique = std::collections::HashSet::new();
        if ids.iter().any(|id| {
            let Some(id_text) = id.as_str() else { return true; };
            !valid_ui_state_id(id) || !unique.insert(id_text)
        }) {
            return Err(reject("INVALID_INPUT", "Invalid UI state request"));
        }
    }
    Ok(())
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
    if matches!(operation, "attachment.ingest-block" | "attachment.put") {
        let byte_count = payload.get("bytes").and_then(|value| value.get("$motionBytes")).and_then(Value::as_array)
            .ok_or_else(|| reject("INVALID_INPUT", "Attachment bytes require an explicit byte envelope"))?.len();
        if byte_count > MAX_ATTACHMENT_BYTES { return Err(reject("INVALID_INPUT", "Attachments must not exceed 3 MiB")); }
    }
    // Keep this list aligned with production callers in apps/web/app-adapter.js.
    let allowed: &[&str] = match (request.lane.as_str(), operation) {
        ("query", "workspace.list") => &["type"],
        ("query", "workspace.get") => &["type", "workspaceId"],
        ("query", "workspace.export") => &["type", "workspaceId"],
        ("query", "workspace.search") => &["type", "workspaceId", "query", "limit"],
        ("command", "workspace.create") => &["type", "name"],
        ("web-v1-import", "workspace.import-web-v1") => &["type", "document"],
        ("command", "page.create") => &["type", "workspaceId", "expectedRevision", "title", "parentId"],
        ("command", "page.rename") => &["type", "workspaceId", "expectedRevision", "pageId", "title"],
        ("command", "page.move") => &["type", "workspaceId", "expectedRevision", "pageId", "parentId"],
        ("command", "page.reorder") => &["type", "workspaceId", "expectedRevision", "pageId", "beforePageId"],
        ("command", "page.set-favourite") => &["type", "workspaceId", "expectedRevision", "pageId", "favourite"],
        ("command", "page.trash" | "page.restore") => &["type", "workspaceId", "expectedRevision", "pageId"],
        ("command", "page.replace-blocks") => &["type", "workspaceId", "expectedRevision", "pageId", "blocks"],
        ("command", "block.create") => &["type", "workspaceId", "expectedRevision", "pageId", "position", "block"],
        ("command", "block.update-content") => &["type", "workspaceId", "expectedRevision", "pageId", "blockId", "content"],
        ("command", "block.transform") => &["type", "workspaceId", "expectedRevision", "pageId", "blockId", "transform"],
        ("command", "block.move") => &["type", "workspaceId", "expectedRevision", "pageId", "blockId", "target"],
        ("command", "block.indent") => &["type", "workspaceId", "expectedRevision", "pageId", "blockId"],
        ("command", "block.outdent") => &["type", "workspaceId", "expectedRevision", "pageId", "blockId"],
        ("command", "block.duplicate") => &["type", "workspaceId", "expectedRevision", "pageId", "blockId", "newBlockId"],
        ("command", "block.delete") => &["type", "workspaceId", "expectedRevision", "pageId", "blockId"],
        ("command", "block.batch") => &["type", "workspaceId", "expectedRevision", "commands"],
        ("command", "database.create") => &["type", "workspaceId", "expectedRevision", "title", "parentId"],
        ("command", "database.property-add") => &["type", "workspaceId", "expectedRevision", "databaseId", "property"],
        ("command", "database.property-update") => &["type", "workspaceId", "expectedRevision", "databaseId", "propertyId", "patch"],
        ("command", "database.property-delete") => &["type", "workspaceId", "expectedRevision", "databaseId", "propertyId"],
        ("command", "database.record-create") => &["type", "workspaceId", "expectedRevision", "databaseId", "title", "values"],
        ("command", "database.record-update") => &["type", "workspaceId", "expectedRevision", "pageId", "title", "values"],
        ("command", "database.view-update") => &["type", "workspaceId", "expectedRevision", "databaseId", "viewId", "patch"],
        ("async-command", "attachment.ingest-block") => &[
            "type",
            "workspaceId",
            "expectedRevision",
            "pageId",
            "position",
            "attachmentId",
            "blockId",
            "fileName",
            "mediaType",
            "sha256",
            "bytes",
        ],
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
        ("async-query", "attachment.read") => &["type", "workspaceId", "attachmentId"],
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
    if request.schema_version != 1 && request.schema_version != 2 {
        return Err(reject("INVALID_INPUT", "Unsupported UI schema version"));
    }
    run_service(
        app,
        serde_json::json!({ "lane": "ui-load", "payload": { "schemaVersion": request.schema_version } }),
    )
    .await
}

#[tauri::command]
async fn motion_ui_save(app: tauri::AppHandle, request: UiSaveRequest) -> Result<Value, IpcError> {
    if request.schema_version != 2 {
        return Err(reject("INVALID_INPUT", "Whole-workspace UI save is not supported"));
    }
    validate_ui_state_document(&request.document)?;
    run_service(app, serde_json::json!({ "lane": "ui-save", "payload": { "schemaVersion": request.schema_version, "document": request.document } })).await
}

#[tauri::command]
async fn motion_backup_save(
    app: tauri::AppHandle,
    request: BackupSaveRequest,
) -> Result<Value, IpcError> {
    if request.schema_version != 1 {
        return Err(reject(
            "INVALID_INPUT",
            "Unsupported backup command version",
        ));
    }
    let destination = tauri::async_runtime::spawn_blocking(|| {
        FileDialog::new()
            .set_title("Save verified Motion backup")
            .set_file_name("motion-verified-backup.json")
            .add_filter("Motion backup", &["json"])
            .save_file()
    })
    .await
    .map_err(|_| reject("INTERNAL_ERROR", "Backup dialog failed"))?;
    let Some(destination) = destination else {
        return Ok(serde_json::json!({ "saved": false, "cancelled": true }));
    };
    let destination_text = destination
        .to_str()
        .ok_or_else(|| reject("INVALID_INPUT", "Selected backup path is not supported"))?
        .to_owned();
    let inspected = run_service(
        app.clone(),
        serde_json::json!({
            "lane": "native-backup-inspect", "payload": { "destination": destination_text }
        }),
    )
    .await?;
    let replacement = inspected
        .get("replacement")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if replacement {
        let confirmed = tauri::async_runtime::spawn_blocking(|| {
            MessageDialog::new()
                .set_level(MessageLevel::Warning)
                .set_title("Replace verified Motion backup?")
                .set_description("The selected file is a valid private Motion backup. Replace it only after the new backup has been completely written and verified?")
                .set_buttons(MessageButtons::YesNo)
                .show()
        }).await.map_err(|_| reject("INTERNAL_ERROR", "Backup confirmation failed"))?;
        if confirmed != MessageDialogResult::Yes {
            return Ok(serde_json::json!({ "saved": false, "cancelled": true }));
        }
    }
    let saved = run_service(app, serde_json::json!({
        "lane": "native-backup-save",
        "payload": { "destination": destination_text, "replaceConfirmed": replacement, "bundle": request.bundle }
    })).await?;
    Ok(serde_json::json!({
        "saved": true,
        "cancelled": false,
        "replaced": replacement,
        "byteLength": saved.get("byteLength").and_then(Value::as_u64)
    }))
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
            motion_backup_save,
            motion_ui_load,
            motion_ui_save
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Motion desktop");
}

#[cfg(test)]
mod tests {
    use super::{
        select_node_binary, validate_dispatch_request, validate_ui_state_document,
        BackupSaveRequest, IpcRequest,
    };
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
        let attachment_block = IpcRequest {
            protocol_version: 1,
            lane: "async-command".into(),
            payload: json!({
                "type": "attachment.ingest-block", "workspaceId": "w", "expectedRevision": 1, "pageId": "page-1",
                "position": { "parentBlockId": null, "beforeBlockId": null }, "fileName": "x", "mediaType": "text/plain",
                "sha256": "0".repeat(64), "bytes": { "$motionBytes": [] }
            }),
        };
        assert!(validate_dispatch_request(&attachment_block).is_ok());
        let extra_attachment_field = IpcRequest {
            protocol_version: 1,
            lane: "async-command".into(),
            payload: json!({
                "type": "attachment.ingest-block", "workspaceId": "w", "expectedRevision": 1, "pageId": "page-1",
                "position": { "parentBlockId": null, "beforeBlockId": null }, "fileName": "x", "mediaType": "text/plain",
                "sha256": "0".repeat(64), "bytes": { "$motionBytes": [] }, "unsupported": true
            }),
        };
        assert_eq!(validate_dispatch_request(&extra_attachment_field).unwrap_err().code, "INVALID_INPUT");
        let wrong_attachment_lane = IpcRequest { protocol_version: 1, lane: "command".into(), payload: attachment_block.payload.clone() };
        assert_eq!(validate_dispatch_request(&wrong_attachment_lane).unwrap_err().code, "INVALID_INPUT");
        let oversized_attachment = IpcRequest { protocol_version: 1, lane: "async-command".into(), payload: json!({
            "type": "attachment.ingest-block", "workspaceId": "w", "expectedRevision": 1, "pageId": "page-1",
            "position": { "parentBlockId": null, "beforeBlockId": null }, "fileName": "x", "mediaType": "text/plain",
            "sha256": "0".repeat(64), "bytes": { "$motionBytes": vec![0; MAX_ATTACHMENT_BYTES + 1] }
        }) };
        assert_eq!(validate_dispatch_request(&oversized_attachment).unwrap_err().code, "INVALID_INPUT");
        let oversized_put = IpcRequest { protocol_version: 1, lane: "async-command".into(), payload: json!({
            "type": "attachment.put", "workspaceId": "w", "expectedRevision": 1, "fileName": "x", "mediaType": "text/plain",
            "sha256": "0".repeat(64), "bytes": { "$motionBytes": vec![0; MAX_ATTACHMENT_BYTES + 1] }
        }) };
        assert_eq!(validate_dispatch_request(&oversized_put).unwrap_err().code, "INVALID_INPUT");
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
    fn dispatch_accepts_block_commands_with_exact_top_level_fields() {
        let payloads = [
            json!({
                "type": "block.create", "workspaceId": "workspace", "expectedRevision": 1,
                "pageId": "page", "position": {}, "block": {}
            }),
            json!({
                "type": "block.update-content", "workspaceId": "workspace", "expectedRevision": 1,
                "pageId": "page", "blockId": "block", "content": {}
            }),
            json!({
                "type": "block.transform", "workspaceId": "workspace", "expectedRevision": 1,
                "pageId": "page", "blockId": "block", "transform": {}
            }),
            json!({
                "type": "block.move", "workspaceId": "workspace", "expectedRevision": 1,
                "pageId": "page", "blockId": "block", "target": {}
            }),
            json!({
                "type": "block.indent", "workspaceId": "workspace", "expectedRevision": 1,
                "pageId": "page", "blockId": "block"
            }),
            json!({
                "type": "block.outdent", "workspaceId": "workspace", "expectedRevision": 1,
                "pageId": "page", "blockId": "block"
            }),
            json!({
                "type": "block.duplicate", "workspaceId": "workspace", "expectedRevision": 1,
                "pageId": "page", "blockId": "block", "newBlockId": "copy"
            }),
            json!({
                "type": "block.delete", "workspaceId": "workspace", "expectedRevision": 1,
                "pageId": "page", "blockId": "block"
            }),
            json!({
                "type": "block.batch", "workspaceId": "workspace", "expectedRevision": 1,
                "commands": []
            }),
        ];

        for payload in payloads {
            let operation = payload["type"].as_str().unwrap().to_owned();
            let request = IpcRequest {
                protocol_version: 1,
                lane: "command".into(),
                payload: payload.clone(),
            };
            assert!(
                validate_dispatch_request(&request).is_ok(),
                "{operation} must be accepted on the command lane"
            );

            let wrong_lane = IpcRequest {
                protocol_version: 1,
                lane: "query".into(),
                payload: payload.clone(),
            };
            assert_eq!(
                validate_dispatch_request(&wrong_lane).unwrap_err().code,
                "INVALID_INPUT",
                "{operation} must be rejected on the wrong lane"
            );

            let mut injected = payload;
            injected
                .as_object_mut()
                .unwrap()
                .insert("unsupported".into(), json!(true));
            let injected_request = IpcRequest {
                protocol_version: 1,
                lane: "command".into(),
                payload: injected,
            };
            assert_eq!(
                validate_dispatch_request(&injected_request)
                    .unwrap_err()
                    .code,
                "INVALID_INPUT",
                "{operation} must reject unsupported top-level fields"
            );
        }
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

    #[test]
    fn ui_state_boundary_accepts_only_bounded_ephemeral_fields() {
        assert!(validate_ui_state_document(&json!({
            "workspaceId": "workspace-1", "activePageId": null, "expandedPageIds": ["page-1"]
        }))
        .is_ok());
        for invalid in [
            json!({ "workspace": { "pages": [] }, "workspaceId": "workspace-1" }),
            json!({ "pages": [] }),
            json!({ "workspaceId": "workspace-1", "expandedPageIds": ["page-1", "page-1"] }),
            json!({ "workspaceId": "workspace-1", "activePageId": "bad/id" }),
        ] {
            assert_eq!(
                validate_ui_state_document(&invalid).unwrap_err().code,
                "INVALID_INPUT"
            );
        }
    }

    #[test]
    fn backup_save_request_cannot_supply_a_path_or_confirmation() {
        let injected = json!({
            "schemaVersion": 1,
            "bundle": {},
            "destination": "/tmp/browser-chosen",
            "replaceConfirmed": true
        });
        assert!(serde_json::from_value::<BackupSaveRequest>(injected).is_err());
    }
}
