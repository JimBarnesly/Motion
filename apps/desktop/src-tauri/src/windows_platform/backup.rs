use super::{
    acquire_private_file_lease, create_private_file, open_private_file, open_replacement_target,
    pin_directory, publish_no_replace, replace_private_file, verify_published_file,
    PinnedDirectory, PinnedFile,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_BACKUP_BYTES: usize = 16 * 1024 * 1024;
static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Inspection {
    protocol: u8,
    operation: String,
    path: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    protocol: u8,
    operation: String,
    path: PathBuf,
    contents: String,
    expected_identity: Option<String>,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn destination_parent(path: &Path) -> io::Result<PinnedDirectory> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(invalid("Backup destination must name an absolute regular file"));
    }
    pin_directory(path.parent().ok_or_else(|| invalid("Backup directory is unavailable"))?)
}

fn open_existing(path: &Path) -> io::Result<Option<PinnedFile>> {
    match open_private_file(path, false) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn read_contents(file: &mut PinnedFile) -> io::Result<Vec<u8>> {
    let before = file.identity()?;
    if before.links != 1 || file.file().metadata()?.len() > MAX_BACKUP_BYTES as u64 {
        return Err(invalid("Backup is not a bounded single-link regular file"));
    }
    file.file_mut().seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.file_mut().take((MAX_BACKUP_BYTES + 1) as u64).read_to_end(&mut bytes)?;
    let after = file.identity()?;
    if bytes.len() > MAX_BACKUP_BYTES || !before.same_file(&after) || after.links != 1 {
        return Err(invalid("Backup changed while being authenticated"));
    }
    Ok(bytes)
}

fn identity(file: &PinnedFile, bytes: &[u8]) -> io::Result<String> {
    let metadata = file.identity()?;
    let mut digest = Sha256::new();
    digest.update(b"Motion Windows backup identity v1\0");
    digest.update(metadata.key().as_bytes());
    digest.update((bytes.len() as u64).to_le_bytes());
    digest.update(bytes);
    Ok(format!("{:x}", digest.finalize()))
}

fn inspect(path: &Path) -> io::Result<Value> {
    let parent = destination_parent(path)?;
    let anchored = parent.path().join(path.file_name().ok_or_else(|| invalid("Backup filename is unavailable"))?);
    let Some(mut file) = open_existing(&anchored)? else { return Ok(json!({ "exists": false })); };
    let bytes = read_contents(&mut file)?;
    let identity = identity(&file, &bytes)?;
    let contents = String::from_utf8(bytes).map_err(|_| invalid("Backup is not UTF-8"))?;
    Ok(json!({ "exists": true, "contents": contents, "identity": identity }))
}

struct Temporary(Option<PinnedFile>);

impl Temporary {
    fn file(&self) -> &PinnedFile { self.0.as_ref().expect("temporary exists until publication") }
    fn file_mut(&mut self) -> &mut PinnedFile { self.0.as_mut().expect("temporary exists until publication") }
}

impl Drop for Temporary {
    fn drop(&mut self) {
        // Remove only the file authenticated and still held by this transaction.
        // Interrupted processes leave private evidence; subsequent writers never
        // guess ownership from a timestamp or delete an unowned temporary name.
        if let Some(file) = self.0.take() { let _ = file.remove(); }
    }
}

fn create_temporary(parent: &PinnedDirectory, destination: &Path) -> io::Result<Temporary> {
    let name = destination.file_name().ok_or_else(|| invalid("Backup filename is unavailable"))?;
    let clock = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|_| invalid("Backup clock is unavailable"))?.as_nanos();
    for _ in 0..16 {
        let mut temporary_name = OsString::from(".");
        temporary_name.push(name);
        temporary_name.push(format!(".motion-backup-{}-{}-{}.tmp", std::process::id(), clock,
            TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed)));
        match create_private_file(&parent.path().join(temporary_name)) {
            Ok(file) => return Ok(Temporary(Some(file))),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "Backup temporary names are occupied"))
}

fn save(request: Save) -> io::Result<Value> {
    if request.protocol != 1 || request.operation != "backup.save"
        || request.contents.is_empty() || request.contents.len() > MAX_BACKUP_BYTES
        || request.expected_identity.as_ref().is_some_and(|value| {
            value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }) {
        return Err(invalid("Invalid native backup request"));
    }
    let parent = destination_parent(&request.path)?;
    let destination = parent.path().join(request.path.file_name().ok_or_else(|| invalid("Backup filename is unavailable"))?);
    // The old PID-file scheme is never reinterpreted as a kernel lease. Preserve
    // unfamiliar evidence instead of treating it as proof that a writer died.
    let mut legacy_lock = destination.as_os_str().to_os_string();
    legacy_lock.push(".motion-backup.lock");
    match fs::symlink_metadata(Path::new(&legacy_lock)) {
        Ok(_) => return Err(invalid("Unverifiable backup ownership evidence was preserved")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
        Err(error) => return Err(error),
    }
    let mut lease_name = OsString::from(".");
    lease_name.push(request.path.file_name().ok_or_else(|| invalid("Backup filename is unavailable"))?);
    lease_name.push(".motion-backup.owner-v3");
    let _lease = acquire_private_file_lease(&parent.path().join(lease_name))?;
    let mut existing = if request.expected_identity.is_some() {
        // Replacement retains the authenticated file and denies concurrent data
        // writes, but permits the delete sharing required by Windows rename.
        // The private parent and exclusive Motion lease remain held throughout.
        match open_replacement_target(&destination) {
            Ok(file) => Some(file),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        }
    } else {
        open_existing(&destination)?
    };
    match (&mut existing, &request.expected_identity) {
        (Some(target), Some(expected)) => {
            let bytes = read_contents(target)?;
            if identity(target, &bytes)? != *expected {
                return Err(invalid("Existing backup changed before replacement"));
            }
        }
        (None, None) => (),
        (Some(_), None) => return Err(io::Error::new(io::ErrorKind::AlreadyExists, "Backup destination already exists")),
        (None, Some(_)) => return Err(invalid("Existing backup disappeared before replacement")),
    }
    let bytes = request.contents.as_bytes();
    let mut temporary = create_temporary(&parent, &destination)?;
    temporary.file_mut().file_mut().write_all(bytes)?;
    temporary.file().file().sync_all()?;
    if read_contents(temporary.file_mut())? != bytes {
        return Err(invalid("Backup write did not persist the complete canonical payload"));
    }
    if let Some(target) = &mut existing {
        // Reauthenticate after staging, as close to the swap as possible. The
        // common primitive then checks the final name relative to its retained
        // parent immediately before renaming. Together with the Motion lease,
        // this protects cooperating writers; it is not a kernel compare-and-swap
        // against arbitrary namespace mutation by another same-user process.
        let expected = request.expected_identity.as_deref()
            .ok_or_else(|| invalid("Existing backup requires replacement identity"))?;
        let current = read_contents(target)?;
        if identity(target, &current)? != expected {
            return Err(invalid("Existing backup changed while preparing replacement"));
        }
        replace_private_file(temporary.file(), target)?;
        // Disarm cleanup before any fallible postcondition or durability check:
        // the source handle now identifies the published destination.
        let mut published = temporary.0.take().ok_or_else(|| invalid("Published backup is unavailable"))?;
        verify_published_file(&published, &parent,
            request.path.file_name().ok_or_else(|| invalid("Backup filename is unavailable"))?)?;
        if read_contents(&mut published)? != bytes {
            return Err(invalid("Published backup differs from the verified payload"));
        }
        published.file().sync_all()?;
    } else {
        publish_no_replace(temporary.file(), &parent,
            request.path.file_name().ok_or_else(|| invalid("Backup filename is unavailable"))?)?;
        temporary.file().file().sync_all()?;
        let source = temporary.0.take().ok_or_else(|| invalid("Backup temporary is unavailable"))?;
        source.remove()?;
    }
    Ok(json!({ "byteLength": bytes.len() }))
}

pub(super) fn dispatch(request: Value) -> io::Result<Value> {
    match request.get("operation").and_then(Value::as_str) {
        Some("backup.inspect") => {
            let request: Inspection = serde_json::from_value(request).map_err(|_| invalid("Invalid backup inspection"))?;
            if request.protocol != 1 || request.operation != "backup.inspect" {
                return Err(invalid("Invalid backup inspection"));
            }
            inspect(&request.path)
        }
        Some("backup.save") => save(serde_json::from_value(request).map_err(|_| invalid("Invalid backup save"))?),
        _ => Err(invalid("Unsupported native backup operation")),
    }
}
