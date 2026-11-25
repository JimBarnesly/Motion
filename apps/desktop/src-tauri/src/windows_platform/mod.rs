//! Windows native boundary shared by the Tauri host and its bounded helper modes.
//! Helpers start before any Tauri/WebView initialization. They expose no shell or
//! network capability and receive requests only through their parent's pipes.

mod attachments;
mod backup;
mod filesystem;
mod process;
mod root_guard;
mod security;

pub(super) use filesystem::{pin_private_directory, PinnedDirectory};
use filesystem::{
    acquire_private_file_lease, acquire_root_writer, create_private_file,
    open_private_file, open_private_file_with_links, pin_directory, pin_mutable_file,
    publish_no_replace, replace_private_file, verify_link_target, PinnedFile,
};
pub(super) use process::ServiceJob;

use serde_json::{json, Value};
use std::{ffi::{OsStr, OsString}, io::{self, Read, Write}, path::Path};

const MAX_HELPER_BYTES: usize = 64 * 1024 * 1024;

fn helper_error(error: &io::Error) -> Value {
    let text = error.to_string();
    let prefix = text.split_once(':').map(|(code, _)| code);
    let code = match prefix {
        Some("SIZE_LIMIT") => "SIZE_LIMIT",
        Some("IDENTITY_CHANGED") => "IDENTITY_CHANGED",
        Some("INTEGRITY") => "INTEGRITY",
        Some("INVALID_INPUT") => "INVALID_INPUT",
        _ => match error.raw_os_error() {
            Some(2 | 3) => "ENOENT",
            Some(80 | 183) => "EEXIST",
            Some(32 | 33) => "EBUSY",
            Some(5 | 1314) => "EACCES",
            _ => match error.kind() {
                io::ErrorKind::NotFound => "ENOENT",
                io::ErrorKind::AlreadyExists => "EEXIST",
                io::ErrorKind::PermissionDenied => "EACCES",
                io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => "INVALID_INPUT",
                _ => "STORAGE_FAILURE",
            },
        },
    };
    let message = match code {
        "SIZE_LIMIT" => "Content exceeds the local storage limit",
        "IDENTITY_CHANGED" => "Storage identity changed; the operation was cancelled",
        "INTEGRITY" => "Stored content failed integrity validation",
        "INVALID_INPUT" => "Invalid native helper request",
        "ENOENT" => "Requested local data does not exist",
        "EEXIST" => "The destination already exists",
        "EBUSY" => "Windows storage is already in use",
        "EACCES" => "Private Windows storage validation failed",
        _ => "Native Windows storage operation failed",
    };
    json!({"protocol": 1, "ok": false, "error": {"code": code, "message": message}})
}

fn read_request() -> io::Result<Value> {
    let mut bytes = Vec::new();
    io::stdin().lock().take((MAX_HELPER_BYTES + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_HELPER_BYTES { return Err(io::Error::new(io::ErrorKind::InvalidInput, "Request is too large")); }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid helper JSON"))?;
    if value.get("protocol").and_then(Value::as_u64) != Some(1) || !value.is_object() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid helper protocol"));
    }
    Ok(value)
}

fn private_request(request: &Value) -> io::Result<Value> {
    let object = request.as_object().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Invalid request"))?;
    let operation = request.get("operation").and_then(Value::as_str).unwrap_or("");
    let allowed: &[&str] = if operation == "private.directory" { &["protocol", "operation", "path", "create"] } else { &["protocol", "operation", "path"] };
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Unsupported request field"));
    }
    let path = request.get("path").and_then(Value::as_str).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Invalid path"))?;
    if operation == "private.directory" {
        let create = request.get("create").and_then(Value::as_bool).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Invalid create flag"))?;
        let root = pin_private_directory(Path::new(path), create)?;
        Ok(json!({"identity": root.identity().key()}))
    } else {
        match pin_mutable_file(Path::new(path), false) {
            Ok(file) => Ok(json!({"exists": true, "identity": file.identity()?.key()})),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(json!({"exists": false})),
            Err(error) => Err(error),
        }
    }
}

fn one_shot(mode: &OsStr, args: &[OsString]) -> io::Result<Value> {
    if !args.is_empty() { return Err(io::Error::new(io::ErrorKind::InvalidInput, "Unexpected helper arguments")); }
    let request = read_request()?;
    let operation = request.get("operation").and_then(Value::as_str).unwrap_or("");
    if mode == "--motion-backup-helper" {
        if !matches!(operation, "backup.inspect" | "backup.save") { return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid backup operation")); }
        return backup::dispatch(request);
    }
    match operation {
        "private.directory" | "private.file" => private_request(&request),
        "attachment.initialize" | "attachment.stage" | "attachment.promote" | "attachment.read" | "attachment.discard" | "attachment.recover" => attachments::dispatch(request),
        "backup.inspect" | "backup.save" => backup::dispatch(request),
        _ => Err(io::Error::new(io::ErrorKind::InvalidInput, "Unsupported native helper operation")),
    }
}

fn write_reply(reply: Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(&reply)?;
    if bytes.len() > MAX_HELPER_BYTES { return Err(io::Error::new(io::ErrorKind::InvalidData, "Helper response is too large")); }
    let mut output = io::stdout().lock();
    output.write_all(&bytes)?;
    output.write_all(b"\n")?;
    output.flush()
}

pub(super) fn run_helper(mode: &OsStr, args: &[OsString]) -> i32 {
    let result = if mode == "--motion-root-guard" {
        root_guard::run(args).map(|()| None)
    } else if mode == "--motion-native-helper" || mode == "--motion-backup-helper" {
        one_shot(mode, args).map(Some)
    } else {
        Err(io::Error::new(io::ErrorKind::InvalidInput, "Unknown native helper mode"))
    };
    match result {
        Ok(Some(result)) => if write_reply(json!({"protocol": 1, "ok": true, "result": result})).is_ok() { 0 } else { 1 },
        Ok(None) => 0,
        Err(error) => { let _ = write_reply(helper_error(&error)); 1 },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_errors_never_reflect_paths_or_hostile_request_text() {
        let error = io::Error::new(io::ErrorKind::InvalidInput, "INVALID_INPUT: C:\\secret\\<injected>");
        let reply = helper_error(&error);
        assert_eq!(reply["error"]["code"], "INVALID_INPUT");
        assert!(!reply.to_string().contains("secret"));
        assert!(!reply.to_string().contains("injected"));
        assert_eq!(helper_error(&io::Error::from_raw_os_error(32))["error"]["code"], "EBUSY");
    }
}
