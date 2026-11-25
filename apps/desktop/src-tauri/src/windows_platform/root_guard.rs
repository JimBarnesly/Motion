use super::{acquire_root_writer, pin_mutable_file, pin_private_directory};
use super::process::ParentPins;
use serde_json::json;
use std::{
    ffi::OsString,
    io::{self, Read, Write},
    path::Path,
};

pub(super) fn run(args: &[OsString]) -> io::Result<()> {
    if args.len() != 1 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Expected one data root"));
    }
    let mut parent_pins = ParentPins::for_current_parent()?;
    let root = pin_private_directory(Path::new(&args[0]), true)?;
    let _writer = acquire_root_writer(&root)?;
    // SQLite's Win32 VFS uses ordinary paths. Retain authenticated no-delete
    // handles before opening it, closing the preflight-to-open substitution gap.
    // The VFS may write/truncate these objects but cannot redirect their names.
    let _database = pin_mutable_file(&root.path().join("motion.sqlite3"), true)?;
    let _wal = pin_mutable_file(&root.path().join("motion.sqlite3-wal"), true)?;
    let _shm = pin_mutable_file(&root.path().join("motion.sqlite3-shm"), true)?;
    // An exit-event callback cannot interrupt synchronous SQLite/Node work.
    // Duplicate the exact handles into the authenticated owner process before
    // announcing readiness, so killing this guardian cannot release ownership
    // while the owner still has mutable work in progress.
    root.duplicate_into(&mut parent_pins)?;
    _writer.duplicate_into(&mut parent_pins)?;
    _database.duplicate_into(&mut parent_pins)?;
    _wal.duplicate_into(&mut parent_pins)?;
    _shm.duplicate_into(&mut parent_pins)?;
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &json!({
        "protocol": 1,
        "ok": true,
        "result": { "root": root.path(), "guardianPid": std::process::id() }
    }))?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    drop(stdout);
    let mut stdin = io::stdin().lock();
    let mut byte = [0u8; 1];
    loop {
        match stdin.read(&mut byte) {
            Ok(0) => return parent_pins.release(),
            Ok(_) => return Err(io::Error::new(io::ErrorKind::InvalidInput, "Ownership channel accepts only EOF")),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}
