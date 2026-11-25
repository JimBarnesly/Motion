//! Actual Windows replacement behavior. No mocked handles or platform skips.

use super::{create_private_file, open_private_file, pin_private_directory, replace_private_file};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

fn directory(label: &str) -> Cleanup {
    Cleanup(std::env::temp_dir().join(format!("motion-win-replace-{label}-{}-{}",
        std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed))))
}

#[test]
fn same_directory_replacement_preserves_pins_and_old_reader_contents() {
    let cleanup = directory("held-reader");
    let root = pin_private_directory(&cleanup.0, true).expect("create private test directory");
    let target_path = root.path().join("existing.json");
    let temporary_path = root.path().join("replacement.tmp");
    let mut original = create_private_file(&target_path).expect("create original private file");
    original.file_mut().write_all(b"original committed bytes").expect("write original");
    original.file().sync_all().expect("flush original");
    drop(original);

    let mut target = open_private_file(&target_path, false).expect("pin existing replacement target");
    let mut source = create_private_file(&temporary_path).expect("create replacement source");
    source.file_mut().write_all(b"replacement committed bytes").expect("write replacement");
    source.file().sync_all().expect("flush replacement before rename");
    assert_eq!(source.identity().expect("source identity before rename").links, 1);
    assert_eq!(target.identity().expect("target identity before rename").links, 1);
    assert!(fs::rename(&target_path, root.path().join("stolen.json")).is_err(),
        "the authenticated target must remain pinned before replacement");

    replace_private_file(&source, &target).unwrap_or_else(|error| panic!(
        "same-directory FileRenameInformationEx failed with both guards retained: kind={:?}, os={:?}, detail={error}",
        error.kind(), error.raw_os_error()));

    assert_eq!(fs::read(&target_path).expect("read committed destination"), b"replacement committed bytes");
    target.file_mut().seek(SeekFrom::Start(0)).expect("rewind original held reader");
    let mut previous = Vec::new();
    target.file_mut().read_to_end(&mut previous).expect("read original held handle after replacement");
    assert_eq!(previous, b"original committed bytes");
    assert!(!temporary_path.exists(), "successful rename must remove the temporary name");
    assert!(fs::rename(&target_path, root.path().join("stolen-published.json")).is_err(),
        "the published source handle must retain the new destination pin");
}

#[test]
fn replacement_rejects_a_different_parent_without_mutating_either_file() {
    let cleanup = directory("parent-mismatch");
    let root = pin_private_directory(&cleanup.0, true).expect("create private test directory");
    let source_parent = root.child(std::ffi::OsStr::new("source"), true).expect("create source parent");
    let target_parent = root.child(std::ffi::OsStr::new("target"), true).expect("create target parent");
    let target_path = target_parent.path().join("existing.json");
    let source_path = source_parent.path().join("replacement.tmp");
    let mut original = create_private_file(&target_path).expect("create target");
    original.file_mut().write_all(b"original").unwrap();
    drop(original);
    let target = open_private_file(&target_path, false).unwrap();
    let mut source = create_private_file(&source_path).unwrap();
    source.file_mut().write_all(b"replacement").unwrap();

    assert_eq!(replace_private_file(&source, &target).unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
    assert_eq!(fs::read(target_path).unwrap(), b"original");
    assert_eq!(fs::read(source_path).unwrap(), b"replacement");
}
