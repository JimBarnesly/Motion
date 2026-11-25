//! Attachment transactions over pinned, private Windows filesystem objects.
//! No caller-provided path is used as a staging or blob filename.

use super::{
    create_private_file, open_private_file, open_private_file_with_links,
    pin_private_directory, publish_no_replace, verify_link_target, PinnedDirectory, PinnedFile,
};
use crate::MAX_ATTACHMENT_BYTES;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    ffi::OsStr,
    fs,
    io::{self, Read, Seek, SeekFrom, Write},
    path::Path,
};

const MAX_ENTRIES: usize = 100_000;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, format!("INVALID_INPUT: {message}"))
}
fn identity_changed() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "IDENTITY_CHANGED: Attachment object identity changed")
}
fn integrity() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "INTEGRITY: Attachment integrity check failed")
}
fn oversized() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "SIZE_LIMIT: Attachment storage content exceeds 3 MiB limit")
}
fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn require_hash(value: &str) -> io::Result<()> {
    if valid_hash(value) { Ok(()) } else { Err(invalid("Attachment hash is invalid")) }
}
fn string<'a>(request: &'a Value, key: &str) -> io::Result<&'a str> {
    request.get(key).and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 32_767 && !value.contains('\0'))
        .ok_or_else(|| invalid("A required attachment field is invalid"))
}
fn exact(request: &Value, fields: &[&str]) -> io::Result<()> {
    let object = request.as_object().ok_or_else(|| invalid("Attachment request must be an object"))?;
    if object.keys().any(|key| !fields.contains(&key.as_str())) || request.get("protocol").and_then(Value::as_u64) != Some(1) {
        return Err(invalid("Attachment request shape or protocol is invalid"));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    staging_name: String,
    file_identity: String,
    sha256: String,
    byte_length: usize,
}

fn staging_hash(name: &str) -> Option<&str> {
    let hash = name.get(..64)?;
    let suffix = name.get(65..)?.strip_suffix(".staging")?;
    if !valid_hash(hash) || name.as_bytes().get(64) != Some(&b'.') || suffix.len() != 36 {
        return None;
    }
    if !suffix.bytes().enumerate().all(|(index, byte)| {
        if [8, 13, 18, 23].contains(&index) { byte == b'-' }
        else { byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) }
    }) { return None; }
    Some(hash)
}

impl Receipt {
    fn from_request(request: &Value) -> io::Result<Self> {
        let result: Self = serde_json::from_value(request.get("receipt").cloned().ok_or_else(|| invalid("Missing staging receipt"))?)
            .map_err(|_| invalid("Staging receipt is invalid"))?;
        if staging_hash(&result.staging_name) != Some(result.sha256.as_str())
            || result.file_identity.len() != 64 || !valid_hash(&result.file_identity)
            || result.byte_length > MAX_ATTACHMENT_BYTES {
            return Err(invalid("Staging receipt is invalid"));
        }
        Ok(result)
    }
}

struct Roots {
    root: PinnedDirectory,
    staging: PinnedDirectory,
}

impl Roots {
    fn initialize(path: &Path) -> io::Result<Self> {
        let root = pin_private_directory(path, true)?;
        let staging = root.child(OsStr::new(".staging"), true)?;
        Ok(Self { root, staging })
    }
    fn from_request(request: &Value) -> io::Result<Self> {
        let root = pin_private_directory(Path::new(string(request, "root")?), false)?;
        if root.identity().key() != string(request, "expectedRootIdentity")? { return Err(identity_changed()); }
        let staging = root.child(OsStr::new(".staging"), false)?;
        if staging.identity().key() != string(request, "expectedStagingIdentity")? { return Err(identity_changed()); }
        Ok(Self { root, staging })
    }
    fn bucket(&self, sha256: &str, create: bool) -> io::Result<PinnedDirectory> {
        require_hash(sha256)?;
        self.root.child(OsStr::new(&sha256[..2]), create)
    }
    fn open_stage(&self, receipt: &Receipt) -> io::Result<PinnedFile> {
        // Promotion/discard consume the opened staging name and flush it. The
        // writable pin includes DELETE access for handle-based removal.
        let source = open_private_file(&self.staging.path().join(&receipt.staging_name), true)?;
        if source.identity()?.key() != receipt.file_identity { return Err(identity_changed()); }
        Ok(source)
    }
}

fn read_bounded(file: &mut PinnedFile) -> io::Result<Vec<u8>> {
    let identity = file.identity()?;
    let length = file.file().metadata()?.len();
    if length > MAX_ATTACHMENT_BYTES as u64 { return Err(oversized()); }
    file.file_mut().seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::with_capacity(length as usize + 1);
    file.file_mut().take(MAX_ATTACHMENT_BYTES as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_ATTACHMENT_BYTES { return Err(oversized()); }
    if bytes.len() as u64 != length || file.file().metadata()?.len() != length
        || !identity.same_file(&file.identity()?) { return Err(identity_changed()); }
    Ok(bytes)
}

fn verify_bytes(file: &mut PinnedFile, sha256: &str, length: Option<usize>) -> io::Result<Vec<u8>> {
    let bytes = read_bounded(file)?;
    if length.is_some_and(|expected| expected != bytes.len()) || hash(&bytes) != sha256 { return Err(integrity()); }
    Ok(bytes)
}

fn stage(roots: &Roots, request: &Value) -> io::Result<Value> {
    let sha256 = string(request, "sha256")?;
    let staging_name = string(request, "stagingName")?;
    if staging_hash(staging_name) != Some(sha256) { return Err(invalid("Staging filename is invalid")); }
    let values = request.get("bytes").and_then(Value::as_array).ok_or_else(|| invalid("Attachment bytes are invalid"))?;
    if values.len() > MAX_ATTACHMENT_BYTES { return Err(oversized()); }
    let bytes: Vec<u8> = values.iter().map(|value| value.as_u64().filter(|value| *value <= 255).map(|value| value as u8)
        .ok_or_else(|| invalid("Attachment bytes are invalid"))).collect::<io::Result<_>>()?;
    if hash(&bytes) != sha256 { return Err(integrity()); }
    let mut file = create_private_file(&roots.staging.path().join(staging_name))?;
    let result = (|| {
        file.file_mut().write_all(&bytes)?;
        file.file().sync_all()?;
        verify_bytes(&mut file, sha256, Some(bytes.len()))?;
        let identity = file.identity()?;
        if identity.links != 1 { return Err(identity_changed()); }
        Ok(json!({ "stagingName": staging_name, "fileIdentity": identity.key(), "sha256": sha256, "byteLength": bytes.len() }))
    })();
    if result.is_err() { let _ = file.remove(); }
    result
}

fn published(sha256: &str, byte_length: usize, newly_created: bool) -> Value {
    json!({ "sha256": sha256, "byteLength": byte_length, "newlyCreated": newly_created })
}

fn promote_open(roots: &Roots, receipt: &Receipt, mut source: PinnedFile) -> io::Result<Value> {
    let source_identity = source.identity()?;
    if source_identity.key() != receipt.file_identity || source_identity.links != 1 { return Err(identity_changed()); }
    verify_bytes(&mut source, &receipt.sha256, Some(receipt.byte_length))?;
    let bucket = roots.bucket(&receipt.sha256, true)?;
    let final_path = bucket.path().join(&receipt.sha256);
    match open_private_file(&final_path, false) {
        Ok(mut existing) => {
            verify_bytes(&mut existing, &receipt.sha256, Some(receipt.byte_length))?;
            source.remove()?;
            return Ok(published(&receipt.sha256, receipt.byte_length, false));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    if let Err(publication_error) = publish_no_replace(&source, &bucket, OsStr::new(&receipt.sha256)) {
        // A competing publication may have won the no-replace operation. Only
        // verified identical bytes permit deduplication; no destination is overwritten.
        match open_private_file(&final_path, false) {
            Ok(mut existing) => {
                verify_bytes(&mut existing, &receipt.sha256, Some(receipt.byte_length))?;
                source.remove()?;
                return Ok(published(&receipt.sha256, receipt.byte_length, false));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(publication_error),
            Err(error) => return Err(error),
        }
    }
    source.remove()?;
    let mut final_file = open_private_file(&final_path, false)?;
    if !source_identity.same_file(&final_file.identity()?) { return Err(identity_changed()); }
    verify_bytes(&mut final_file, &receipt.sha256, Some(receipt.byte_length))?;
    Ok(published(&receipt.sha256, receipt.byte_length, true))
}

fn entries(path: &Path) -> io::Result<Vec<fs::DirEntry>> {
    let mut result = Vec::new();
    for entry in fs::read_dir(path)? {
        if result.len() == MAX_ENTRIES { return Err(invalid("Attachment directory has too many entries")); }
        result.push(entry?);
    }
    result.sort_by_key(|entry| entry.file_name());
    Ok(result)
}

fn recover(roots: &Roots, request: &Value) -> io::Result<Value> {
    let requested = request.get("referencedHashes").and_then(Value::as_array).ok_or_else(|| invalid("Referenced hashes are invalid"))?;
    if requested.len() > MAX_ENTRIES { return Err(invalid("Too many referenced hashes")); }
    let mut referenced = BTreeSet::new();
    for value in requested {
        let sha256 = value.as_str().ok_or_else(|| invalid("Referenced hash is invalid"))?;
        require_hash(sha256)?; referenced.insert(sha256.to_owned());
    }
    let mut promoted = BTreeSet::new();
    let mut removed = Vec::new();
    for entry in entries(roots.staging.path())? {
        let name = entry.file_name().into_string().map_err(|_| invalid("Staging filename is invalid"))?;
        // Unexpected directory/reparse entries are retained and rejected. A
        // recovery audit must never recursively delete an unauthenticated tree.
        let sha256 = staging_hash(&name).ok_or_else(|| invalid("Unexpected attachment staging entry"))?.to_owned();
        let mut source = open_private_file_with_links(&entry.path(), true, 2)?;
        let identity = source.identity()?;
        let bytes = read_bounded(&mut source);
        let valid = bytes.as_ref().is_ok_and(|value| hash(value) == sha256);
        if identity.links == 2 {
            let bucket = roots.bucket(&sha256, false)?;
            if !verify_link_target(&source, &bucket, OsStr::new(&sha256))? { return Err(identity_changed()); }
            // A crash after link publication leaves two names for one private
            // object. Remove only its pinned staging name, retaining the blob.
            source.remove()?;
            if valid && referenced.contains(&sha256) { promoted.insert(sha256); }
            else { removed.push(name); }
        } else if valid && referenced.contains(&sha256) {
            let receipt = Receipt { staging_name: name, file_identity: identity.key(), sha256: sha256.clone(),
                byte_length: bytes.as_ref().map_or(0, Vec::len) };
            promote_open(roots, &receipt, source)?;
            promoted.insert(sha256);
        } else {
            source.remove()?;
            removed.push(name);
        }
    }
    let mut present = BTreeSet::new();
    let mut oversized_blobs = BTreeSet::new();
    let mut corrupt_blobs = BTreeSet::new();
    for entry in entries(roots.root.path())? {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.len() != 2 || !name.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) { continue; }
        let bucket = roots.root.child(OsStr::new(name), false)?;
        for entry in entries(bucket.path())? {
            let name = entry.file_name();
            let Some(sha256) = name.to_str() else { continue };
            if !valid_hash(sha256) { continue; }
            if !sha256.starts_with(bucket.path().file_name().and_then(OsStr::to_str).unwrap_or("")) {
                corrupt_blobs.insert(sha256.to_owned()); continue;
            }
            let result = open_private_file(&entry.path(), false)
                .and_then(|mut file| verify_bytes(&mut file, sha256, None));
            match result {
                Ok(_) => { present.insert(sha256.to_owned()); }
                Err(error) if error.to_string().starts_with("SIZE_LIMIT:") => { oversized_blobs.insert(sha256.to_owned()); }
                Err(_) => { corrupt_blobs.insert(sha256.to_owned()); }
            }
        }
    }
    Ok(json!({ "promoted": promoted, "removedStaging": removed,
        "missingReferenced": referenced.difference(&present).collect::<Vec<_>>(),
        "unreferencedBlobs": present.difference(&referenced).collect::<Vec<_>>(),
        "oversizedBlobs": oversized_blobs, "corruptBlobs": corrupt_blobs }))
}

pub(super) fn dispatch(request: Value) -> io::Result<Value> {
    let operation = string(&request, "operation")?;
    if operation == "attachment.initialize" {
        exact(&request, &["protocol", "operation", "root"])?;
        let roots = Roots::initialize(Path::new(string(&request, "root")?))?;
        return Ok(json!({ "rootIdentity": roots.root.identity().key(), "stagingIdentity": roots.staging.identity().key() }));
    }
    let mut allowed = vec!["protocol", "operation", "root", "expectedRootIdentity", "expectedStagingIdentity"];
    match operation {
        "attachment.stage" => allowed.extend(["sha256", "stagingName", "bytes"]),
        "attachment.promote" | "attachment.discard" => allowed.push("receipt"),
        "attachment.read" => allowed.push("sha256"),
        "attachment.recover" => allowed.push("referencedHashes"),
        _ => return Err(invalid("Unknown attachment operation")),
    }
    exact(&request, &allowed)?;
    let roots = Roots::from_request(&request)?;
    match operation {
        "attachment.stage" => stage(&roots, &request),
        "attachment.promote" => {
            let receipt = Receipt::from_request(&request)?;
            let source = roots.open_stage(&receipt)?;
            promote_open(&roots, &receipt, source)
        }
        "attachment.discard" => {
            let receipt = Receipt::from_request(&request)?;
            match roots.open_stage(&receipt) {
                Ok(source) => source.remove()?,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            Ok(json!({ "removed": true }))
        }
        "attachment.read" => {
            let sha256 = string(&request, "sha256")?;
            let bucket = roots.bucket(sha256, false)?;
            let mut file = open_private_file(&bucket.path().join(sha256), false)?;
            let bytes = verify_bytes(&mut file, sha256, None)?;
            Ok(json!({ "bytes": bytes }))
        }
        "attachment.recover" => recover(&roots, &request),
        _ => Err(invalid("Unknown attachment operation")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Store { path: std::path::PathBuf, identities: Value }
    impl Store {
        fn new() -> Self {
            let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("motion-native-attachments-{}-{suffix}", std::process::id()));
            let identities = dispatch(json!({ "protocol": 1, "operation": "attachment.initialize", "root": path })).unwrap();
            Self { path, identities }
        }
        fn request(&self, operation: &str, params: Value) -> Value {
            let mut request = json!({ "protocol": 1, "operation": operation, "root": self.path,
                "expectedRootIdentity": self.identities["rootIdentity"], "expectedStagingIdentity": self.identities["stagingIdentity"] });
            request.as_object_mut().unwrap().extend(params.as_object().unwrap().clone()); request
        }
        fn stage(&self, bytes: &[u8], sequence: u32) -> Value {
            let sha256 = hash(bytes);
            dispatch(self.request("attachment.stage", json!({ "sha256": sha256,
                "stagingName": format!("{sha256}.00000000-0000-4000-8000-{sequence:012x}.staging"), "bytes": bytes }))).unwrap()
        }
    }
    impl Drop for Store { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.path); } }

    #[test]
    fn attachment_transactions_publish_deduplicate_and_read_verified_bytes() {
        let store = Store::new(); let bytes = b"Native Windows attachment";
        let first = store.stage(bytes, 1);
        let result = dispatch(store.request("attachment.promote", json!({ "receipt": first }))).unwrap();
        assert_eq!(result["newlyCreated"], true);
        let second = store.stage(bytes, 2);
        let result = dispatch(store.request("attachment.promote", json!({ "receipt": second }))).unwrap();
        assert_eq!(result["newlyCreated"], false);
        let read = dispatch(store.request("attachment.read", json!({ "sha256": hash(bytes) }))).unwrap();
        assert_eq!(read["bytes"], json!(bytes));
        assert!(entries(&store.path.join(".staging")).unwrap().is_empty());
    }

    #[test]
    fn stale_receipts_and_changed_roots_cannot_publish() {
        let store = Store::new(); let mut receipt = store.stage(b"Receipt-bound bytes", 1);
        receipt["fileIdentity"] = json!("f".repeat(64));
        assert!(dispatch(store.request("attachment.promote", json!({ "receipt": receipt }))).unwrap_err().to_string().starts_with("IDENTITY_CHANGED:"));
        let mut request = store.request("attachment.recover", json!({ "referencedHashes": [] }));
        request["expectedRootIdentity"] = json!("f".repeat(64));
        assert!(dispatch(request).unwrap_err().to_string().starts_with("IDENTITY_CHANGED:"));
    }

    #[test]
    fn recovery_finishes_a_crash_between_hard_link_and_staging_removal() {
        let store = Store::new(); let bytes = b"Committed before interrupted promotion";
        let staged = store.stage(bytes, 1);
        let roots = Roots::from_request(&store.request("attachment.recover", json!({ "referencedHashes": [] }))).unwrap();
        let receipt: Receipt = serde_json::from_value(staged).unwrap();
        let source = roots.open_stage(&receipt).unwrap();
        let bucket = roots.bucket(&receipt.sha256, true).unwrap();
        publish_no_replace(&source, &bucket, OsStr::new(&receipt.sha256)).unwrap();
        drop(source); drop(bucket); drop(roots);
        let result = dispatch(store.request("attachment.recover", json!({ "referencedHashes": [receipt.sha256] }))).unwrap();
        assert_eq!(result["promoted"], json!([receipt.sha256]));
        assert_eq!(result["missingReferenced"], json!([]));
        assert!(entries(&store.path.join(".staging")).unwrap().is_empty());
    }

    #[test]
    fn recovery_discards_abandoned_staging_but_retains_unreferenced_blobs() {
        let store = Store::new(); let abandoned = store.stage(b"Never committed", 1);
        let retained = store.stage(b"Previously committed", 2);
        dispatch(store.request("attachment.promote", json!({ "receipt": retained }))).unwrap();
        let result = dispatch(store.request("attachment.recover", json!({ "referencedHashes": [] }))).unwrap();
        assert_eq!(result["removedStaging"], json!([abandoned["stagingName"]]));
        assert_eq!(result["unreferencedBlobs"], json!([retained["sha256"]]));
        assert!(store.path.join(retained["sha256"].as_str().unwrap().get(..2).unwrap()).join(retained["sha256"].as_str().unwrap()).is_file());
    }
}
