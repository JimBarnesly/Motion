use super::fixtures::{InPlaceJunction, TestTree};
use super::super::{create_private_file, inspect, open_private_file, pin_private_directory,
    publish_no_replace, relative_open, verify_link_target};
use std::{ffi::OsStr, fs, io::{self, Read, Write}};
use windows_sys::Win32::{Foundation::{GENERIC_READ, GENERIC_WRITE},
    Storage::FileSystem::{DELETE, FILE_SHARE_READ, READ_CONTROL}};

const SENTINEL: &[u8] = b"outside data must remain unchanged";

#[test]
fn create_does_not_follow_a_junction_installed_after_the_directory_pin() -> io::Result<()> {
    let tree = TestTree::new("reparse-create")?;
    let root = pin_private_directory(tree.path(), false)?;
    let pinned = root.child(OsStr::new("pinned"), true)?;
    let outside = root.child(OsStr::new("outside"), true)?;
    fs::write(outside.path().join("sentinel"), SENTINEL)?;
    let mut junction = InPlaceJunction::install(&pinned, outside.path())?;
    // This read proves that path lookup really redirects while the old pin
    // remains open; a denied fixture setup cannot make this test pass.
    assert_eq!(fs::read(pinned.path().join("sentinel"))?, SENTINEL);
    let opened = relative_open(&pinned.file, OsStr::new("relative-created"),
        GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL, FILE_SHARE_READ, false, true);
    assert!(!outside.path().join("relative-created").try_exists()?, "relative creation escaped into the junction target");
    assert!(create_private_file(&pinned.path().join("path-created")).is_err(),
        "a newly resolved pathname must reject the now-visible reparse point");
    assert!(!outside.path().join("path-created").try_exists()?);
    assert_eq!(fs::read(outside.path().join("sentinel"))?, SENTINEL);
    junction.clear()?;
    // Either native rejection or creation in the original pinned directory is
    // safe. If the OS allows creation, bind its actual identity to that directory.
    if let Ok(file) = opened {
        let identity = inspect(&file, false)?;
        drop(file);
        let retained = open_private_file(&pinned.path().join("relative-created"), false)?;
        assert!(identity.same_file(&retained.identity()?));
    }
    drop(junction);
    drop(outside);
    drop(pinned);
    drop(root);
    tree.finish()
}

#[test]
fn publication_does_not_follow_a_junction_installed_after_the_destination_pin() -> io::Result<()> {
    let tree = TestTree::new("reparse-publish")?;
    let root = pin_private_directory(tree.path(), false)?;
    let mut source = create_private_file(&root.path().join("staged"))?;
    source.file_mut().write_all(b"verified attachment")?;
    source.file().sync_all()?;
    let pinned = root.child(OsStr::new("pinned"), true)?;
    let outside = root.child(OsStr::new("outside"), true)?;
    fs::write(outside.path().join("sentinel"), SENTINEL)?;
    let mut junction = InPlaceJunction::install(&pinned, outside.path())?;
    assert_eq!(fs::read(pinned.path().join("sentinel"))?, SENTINEL);
    let published = publish_no_replace(&source, &pinned, OsStr::new("published"));
    assert!(!outside.path().join("published").try_exists()?, "publication escaped into the junction target");
    assert_eq!(fs::read(outside.path().join("sentinel"))?, SENTINEL);
    junction.clear()?;
    let original_target = pinned.path().join("published");
    if original_target.try_exists()? {
        assert!(verify_link_target(&source, &pinned, OsStr::new("published"))?,
            "any resulting link must authenticate to the original staging object");
        source.remove()?;
        let mut final_file = open_private_file(&original_target, false)?;
        let mut bytes = Vec::new();
        final_file.file_mut().read_to_end(&mut bytes)?;
        assert_eq!(bytes, b"verified attachment");
        assert_eq!(final_file.identity()?.links, 1);
    } else {
        assert!(published.is_err(), "successful publication must leave an authenticated link");
        assert_eq!(source.identity()?.links, 1);
        source.remove()?;
    }
    drop(junction);
    drop(outside);
    drop(pinned);
    drop(root);
    tree.finish()
}
