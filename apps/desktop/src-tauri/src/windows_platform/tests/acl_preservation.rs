use super::fixtures::{security_snapshot, set_fixture_dacl, TestTree};
use super::super::{create_private_file, open_private_file, pin_private_directory};
use super::super::super::security::current_user_sid;
use std::{fs, io::{self, Write}, path::Path};
use windows_sys::Win32::Security::SE_DACL_PROTECTED;

const CONTENTS: &[u8] = b"existing evidence must not be repaired or overwritten";

fn rejected_child(root: &Path) -> io::Result<std::path::PathBuf> {
    let sid = current_user_sid()?;
    // The accepted parent starts with a non-inheriting owner-only DACL. The
    // child is unprotected and grants ordinary Builtin Users read access, so it
    // is deliberately unacceptable and sensitive to parent ACE propagation.
    set_fixture_dacl(root, true, &format!("D:P(A;;FA;;;{sid})"), true)?;
    let path = root.join("unreviewed-child");
    let mut child = create_private_file(&path)?;
    child.file_mut().write_all(CONTENTS)?;
    child.file().sync_all()?;
    drop(child);
    set_fixture_dacl(&path, false, &format!("D:(A;;FA;;;{sid})(A;;FR;;;BU)"), false)?;
    assert_eq!(security_snapshot(&path, false)?.control & SE_DACL_PROTECTED, 0,
        "fixture child must remain open to inheritance propagation");
    Ok(path)
}

#[test]
fn reopening_a_private_root_preserves_rejected_child_owner_dacl_and_bytes() -> io::Result<()> {
    let tree = TestTree::new("acl-preserve")?;
    let child = rejected_child(tree.path())?;
    let parent_before = security_snapshot(tree.path(), true)?;
    let child_before = security_snapshot(&child, false)?;
    let root = pin_private_directory(tree.path(), true)?;
    assert_eq!(security_snapshot(tree.path(), true)?, parent_before, "root authentication must not rewrite its DACL");
    assert_eq!(security_snapshot(&child, false)?, child_before, "root authentication must not change an unreviewed child");
    assert_eq!(fs::read(&child)?, CONTENTS);
    assert!(open_private_file(&child, false).is_err(), "the ordinary-user grant must be rejected");
    assert_eq!(security_snapshot(&child, false)?, child_before, "rejection must preserve owner and exact DACL bytes");
    assert_eq!(fs::read(&child)?, CONTENTS);
    drop(root);
    tree.finish()
}

#[test]
fn acl_fixture_detects_actual_parent_inheritance_propagation() -> io::Result<()> {
    let tree = TestTree::new("acl-positive-control")?;
    let child = rejected_child(tree.path())?;
    let before = security_snapshot(&child, false)?;
    let sid = current_user_sid()?;
    // This explicit test-only mutation reproduces the removed repair behavior.
    // If the fixture cannot observe its propagation, the test must fail.
    set_fixture_dacl(tree.path(), true, &format!("D:P(A;OICI;FA;;;{sid})"), true)?;
    let after = security_snapshot(&child, false)?;
    assert_ne!(after.dacl, before.dacl, "positive control must detect a real inherited ACL change");
    assert_eq!(after.owner, before.owner);
    assert_eq!(fs::read(&child)?, CONTENTS);
    tree.finish()
}
