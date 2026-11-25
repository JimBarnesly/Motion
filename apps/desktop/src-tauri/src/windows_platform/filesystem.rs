//! Safe, handle-owned filesystem operations for the Windows helper processes.
//! Only local drive paths are accepted. Every directory component is opened
//! without following reparse points and remains pinned against deletion/rename.

use super::{process::ParentPins, security::{denied, validate_private, PrivateDescriptor}};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::{File, OpenOptions},
    io,
    mem::{offset_of, size_of},
    os::windows::{
        ffi::OsStrExt,
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Path, PathBuf, Prefix},
    ptr::{null, null_mut},
};
use windows_sys::{Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem::{
    NtCreateFile, NtSetInformationFile, FILE_CREATE, FILE_OPEN, FILE_DIRECTORY_FILE,
    FILE_NON_DIRECTORY_FILE, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
    FILE_WRITE_THROUGH, FILE_LINK_INFORMATION, FILE_LINK_INFORMATION_0,
    FILE_RENAME_INFORMATION, FILE_RENAME_INFORMATION_0, FileLinkInformation,
    FileRenameInformationEx,
}}, Win32::{
    Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE, OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, RtlNtStatusToDosError, UNICODE_STRING},
    Storage::FileSystem::{
        GetFileInformationByHandle, GetFinalPathNameByHandleW,
        GetFileInformationByHandleEx, SetFileInformationByHandle, VOLUME_NAME_GUID,
        BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_INFO,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_ID_INFO, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        FileDispositionInfo, FileIdInfo, READ_CONTROL, SYNCHRONIZE,
    },
    System::IO::IO_STATUS_BLOCK,
    System::WindowsProgramming::{FILE_RENAME_FLAG_POSIX_SEMANTICS, FILE_RENAME_FLAG_REPLACE_IF_EXISTS},
}};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct FileIdentity {
    pub volume_serial: u64,
    pub file_id: [u8; 16],
    pub links: u32,
}

impl FileIdentity {
    pub(super) fn key(&self) -> String {
        let mut digest = Sha256::new();
        digest.update(self.volume_serial.to_le_bytes());
        digest.update(self.file_id);
        format!("{:x}", digest.finalize())
    }

    pub(super) fn same_file(&self, other: &Self) -> bool {
        self.volume_serial == other.volume_serial && self.file_id == other.file_id
    }
}

fn inspect(file: &File, directory: bool) -> io::Result<FileIdentity> {
    let mut basic = BY_HANDLE_FILE_INFORMATION::default();
    let mut identity = FILE_ID_INFO::default();
    // SAFETY: file retains the handle; each output has the exact ABI type and
    // size required by its information class. No pointer is retained by Win32.
    unsafe {
        if GetFileInformationByHandle(file.as_raw_handle(), &mut basic) == 0
            || GetFileInformationByHandleEx(file.as_raw_handle(), FileIdInfo,
                (&mut identity as *mut FILE_ID_INFO).cast(), size_of::<FILE_ID_INFO>() as u32) == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    if basic.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (basic.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
        || basic.nNumberOfLinks == 0
    {
        return Err(denied());
    }
    Ok(FileIdentity { volume_serial: identity.VolumeSerialNumber, file_id: identity.FileId.Identifier, links: basic.nNumberOfLinks })
}

fn nt_error(status: i32) -> io::Error {
    // SAFETY: conversion accepts every NTSTATUS value and returns a Win32 code.
    io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32)
}

fn checked_name(name: &OsStr) -> io::Result<()> {
    let units: Vec<u16> = name.encode_wide().collect();
    if units.is_empty() || units.len() > 255
        || units.iter().any(|unit| *unit < 32 || matches!(*unit, 34 | 42 | 47 | 58 | 60 | 62 | 63 | 92 | 124))
        || matches!(units.last(), Some(32 | 46)) || name == "." || name == ".."
    {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Unsupported Windows path component"));
    }
    let stem = name.to_string_lossy().split('.').next().unwrap_or("").to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        || ["COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"].contains(&stem.as_str())
    {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Unsupported Windows device name"));
    }
    Ok(())
}

fn components(path: &Path) -> io::Result<Vec<PathBuf>> {
    let mut parts = path.components();
    let mut current = match parts.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", char::from(drive))),
            Prefix::Verbatim(volume) => {
                let text = volume.to_str().ok_or_else(denied)?;
                let guid = text.strip_prefix("Volume{").and_then(|text| text.strip_suffix('}')).ok_or_else(denied)?;
                if guid.len() != 36 || !guid.bytes().enumerate().all(|(index, byte)|
                    if matches!(index, 8 | 13 | 18 | 23) { byte == b'-' } else { byte.is_ascii_hexdigit() }) {
                    return Err(denied());
                }
                PathBuf::from(format!("\\\\?\\{text}\\"))
            },
            _ => return Err(denied()),
        },
        _ => return Err(denied()),
    };
    if parts.next() != Some(Component::RootDir) { return Err(denied()); }
    let mut result = vec![current.clone()];
    for part in parts {
        let Component::Normal(name) = part else { return Err(denied()); };
        checked_name(name)?;
        current.push(name);
        result.push(current.clone());
    }
    Ok(result)
}

fn open_volume_root(path: &Path) -> io::Result<(File, PathBuf)> {
    let file = OpenOptions::new()
        // LIST_DIRECTORY is deliberate: a metadata-only handle does not provide
        // the same sharing protection. No FILE_SHARE_DELETE is ever granted.
        .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    inspect(&file, true)?;
    let mut name = vec![0u16; 32_768];
    // SAFETY: the handle is retained and the correctly-sized output array is
    // writable. A local volume GUID must be obtained from this actual handle;
    // a mapped SMB drive is not accepted merely because it has a drive letter.
    let length = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), name.as_mut_ptr(), name.len() as u32, VOLUME_NAME_GUID) };
    if length == 0 { return Err(io::Error::last_os_error()); }
    if length as usize >= name.len() { return Err(denied()); }
    let final_path = String::from_utf16(&name[..length as usize]).map_err(|_| denied())?;
    if !final_path.starts_with(r"\\?\Volume{") { return Err(denied()); }
    Ok((file, PathBuf::from(final_path)))
}

/// Resolve exactly one checked component relative to an already-owned handle.
/// No full path is reparsed after ancestry authentication. Opening reparse
/// objects, inspecting them, and rejecting them is independent of sharing flags.
fn relative_open(parent: &File, name: &OsStr, access: u32, share: u32, directory: bool, create: bool) -> io::Result<File> {
    checked_name(name)?;
    let mut name: Vec<u16> = name.encode_wide().collect();
    let string = UNICODE_STRING { Length: (name.len() * 2) as u16, MaximumLength: (name.len() * 2) as u16, Buffer: name.as_mut_ptr() };
    let descriptor = if create { Some(PrivateDescriptor::new()?) } else { None };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &string,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        SecurityDescriptor: descriptor.as_ref().map_or(null(), |value| value.as_ptr().cast()),
        SecurityQualityOfService: null(),
    };
    let mut status_block = IO_STATUS_BLOCK::default();
    let mut raw = null_mut();
    // SAFETY: OBJECT_ATTRIBUTES borrows the live parent, checked one-component
    // UTF-16 name, and optional descriptor. Synchronous I/O owns all outputs
    // before returning; the successful handle is immediately transferred to File.
    unsafe {
        let status = NtCreateFile(&mut raw, access | SYNCHRONIZE | FILE_READ_ATTRIBUTES,
            &attributes, &mut status_block, null(), FILE_ATTRIBUTE_NORMAL, share,
            if create { FILE_CREATE } else { FILE_OPEN },
            FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT
                | if directory { FILE_DIRECTORY_FILE } else { FILE_NON_DIRECTORY_FILE | if create { FILE_WRITE_THROUGH } else { 0 } },
            null(), 0);
        if status < 0 { return Err(nt_error(status)); }
        if raw.is_null() || raw == INVALID_HANDLE_VALUE { return Err(denied()); }
        let file = File::from_raw_handle(raw);
        if status != 0 { return Err(nt_error(status)); }
        inspect(&file, directory)?;
        Ok(file)
    }
}

#[derive(Debug)]
pub(crate) struct PinnedDirectory {
    path: PathBuf,
    file: File,
    identity: FileIdentity,
    _ancestors: Vec<File>,
}

impl PinnedDirectory {
    pub(crate) fn path(&self) -> &Path { &self.path }
    pub(super) fn identity(&self) -> FileIdentity { self.identity }
    pub(super) fn duplicate_into(&self, parent: &mut ParentPins) -> io::Result<()> {
        for file in &self._ancestors { parent.duplicate(file)?; }
        parent.duplicate(&self.file)
    }
    pub(super) fn child(&self, name: &OsStr, create: bool) -> io::Result<Self> {
        checked_name(name)?;
        let file = private_child(&self.file, name, create)?;
        let mut ancestors = self._ancestors.iter().map(File::try_clone).collect::<io::Result<Vec<_>>>()?;
        ancestors.push(self.file.try_clone()?);
        Ok(Self { path: self.path.join(name), identity: inspect(&file, true)?, file, _ancestors: ancestors })
    }
}

pub(super) fn pin_directory(path: &Path) -> io::Result<PinnedDirectory> {
    let paths = components(path)?;
    let mut handles = Vec::with_capacity(paths.len());
    let mut canonical = PathBuf::new();
    for (index, component) in paths.iter().enumerate() {
        let file = if index == 0 {
            let (file, path) = open_volume_root(component)?;
            canonical = path;
            file
        } else {
            let name = component.file_name().ok_or_else(denied)?;
            canonical.push(name);
            relative_open(handles.last().ok_or_else(denied)?, name,
                FILE_LIST_DIRECTORY | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE, true, false)?
        };
        inspect(&file, true)?;
        handles.push(file);
    }
    let file = handles.pop().ok_or_else(denied)?;
    Ok(PinnedDirectory { path: canonical, identity: inspect(&file, true)?, file, _ancestors: handles })
}

fn private_child(parent: &File, name: &OsStr, create: bool) -> io::Result<File> {
    let open = || relative_open(parent, name, FILE_LIST_DIRECTORY | READ_CONTROL,
        FILE_SHARE_READ | FILE_SHARE_WRITE, true, false);
    let file = match open() {
        Ok(file) => file,
        Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
            match relative_open(parent, name, FILE_LIST_DIRECTORY | READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE, true, true) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => open()?,
                Err(error) => return Err(error),
            }
        },
        Err(error) => return Err(error),
    };
    validate_private(&file)?;
    Ok(file)
}

pub(crate) fn pin_private_directory(path: &Path, create: bool) -> io::Result<PinnedDirectory> {
    let root = match pin_directory(path) {
        Ok(root) => root,
        Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
            let parent = pin_directory(path.parent().ok_or_else(denied)?)?;
            let name = path.file_name().ok_or_else(denied)?;
            checked_name(name)?;
            // Retain the exact created/opened child rather than closing it and
            // resolving a mutable pathname again between creation and use.
            parent.child(name, true)?
        },
        Err(error) => return Err(error),
    };
    // Existing accepted ACLs are preserved byte-for-byte. SetSecurityInfo would
    // propagate inheritable changes into children before they are authenticated.
    // New objects already received their protected owner-only descriptor at create.
    validate_private(&root.file)?;
    if !inspect(&root.file, true)?.same_file(&root.identity) { return Err(denied()); }
    Ok(root)
}

#[derive(Debug)]
pub(super) struct PinnedFile {
    path: PathBuf,
    file: File,
    original: FileIdentity,
    _parent: PinnedDirectory,
}

impl PinnedFile {
    pub(super) fn path(&self) -> &Path { &self.path }
    pub(super) fn file(&self) -> &File { &self.file }
    pub(super) fn file_mut(&mut self) -> &mut File { &mut self.file }
    pub(super) fn identity(&self) -> io::Result<FileIdentity> {
        let current = inspect(&self.file, false)?;
        if !current.same_file(&self.original) { return Err(denied()); }
        Ok(current)
    }
    pub(super) fn duplicate_into(&self, parent: &mut ParentPins) -> io::Result<()> {
        self._parent.duplicate_into(parent)?;
        parent.duplicate(&self.file)
    }
    pub(super) fn remove(self) -> io::Result<()> {
        self.identity()?;
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: the live handle identifies the exact opened name; the fixed
        // structure has the ABI size for FileDispositionInfo. No path is reopened.
        unsafe {
            if SetFileInformationByHandle(self.file.as_raw_handle(), FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(), size_of::<FILE_DISPOSITION_INFO>() as u32) == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }
}

fn parent_for_file(path: &Path) -> io::Result<PinnedDirectory> {
    let name = path.file_name().ok_or_else(denied)?;
    checked_name(name)?;
    let parent = pin_directory(path.parent().ok_or_else(denied)?)?;
    // Publication directories must not be writable by another ordinary user.
    // Requiring a private owner-controlled parent is deliberately stricter.
    validate_private(&parent.file)?;
    Ok(parent)
}

fn checked_file(path: &Path, file: File, parent: PinnedDirectory, max_links: u32) -> io::Result<PinnedFile> {
    let identity = inspect(&file, false)?;
    if identity.links > max_links { return Err(denied()); }
    validate_private(&file)?;
    let anchored = parent.path.join(path.file_name().ok_or_else(denied)?);
    Ok(PinnedFile { path: anchored, file, original: identity, _parent: parent })
}

pub(super) fn create_private_file(path: &Path) -> io::Result<PinnedFile> {
    let parent = parent_for_file(path)?;
    let file = relative_open(&parent.file, path.file_name().ok_or_else(denied)?,
        GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL, FILE_SHARE_READ, false, true)?;
    checked_file(path, file, parent, 1)
}

pub(super) fn open_private_file(path: &Path, writable: bool) -> io::Result<PinnedFile> {
    open_private_file_with_links(path, writable, 1)
}

pub(super) fn open_private_file_with_links(path: &Path, writable: bool, max_links: u32) -> io::Result<PinnedFile> {
    if !matches!(max_links, 1 | 2) { return Err(denied()); }
    let parent = parent_for_file(path)?;
    let file = relative_open(&parent.file, path.file_name().ok_or_else(denied)?,
        GENERIC_READ | READ_CONTROL | if writable { GENERIC_WRITE | DELETE } else { 0 }, FILE_SHARE_READ, false, false)?;
    checked_file(path, file, parent, max_links)
}

pub(super) fn pin_mutable_file(path: &Path, create: bool) -> io::Result<PinnedFile> {
    let parent = parent_for_file(path)?;
    let name = path.file_name().ok_or_else(denied)?;
    let open = || relative_open(&parent.file, name, GENERIC_READ | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE, false, false);
    let file = match open() {
        Ok(file) => file,
        Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
            match relative_open(&parent.file, name, GENERIC_READ | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE, false, true) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => open()?,
                Err(error) => return Err(error),
            }
        },
        Err(error) => return Err(error),
    };
    checked_file(path, file, parent, 1)
}

pub(super) fn acquire_private_file_lease(path: &Path) -> io::Result<PinnedFile> {
    let parent = parent_for_file(path)?;
    let access = GENERIC_READ | GENERIC_WRITE | READ_CONTROL;
    let name = path.file_name().ok_or_else(denied)?;
    let file = match relative_open(&parent.file, name, access, 0, false, true) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => relative_open(&parent.file, name, access, 0, false, false)?,
        Err(error) => return Err(error),
    };
    let pinned = checked_file(path, file, parent, 1)?;
    if pinned.file.metadata()?.len() != 0 { return Err(denied()); }
    Ok(pinned)
}

pub(super) fn acquire_root_writer(root: &PinnedDirectory) -> io::Result<PinnedFile> {
    acquire_private_file_lease(&root.path.join(".motion-service.owner-v2"))
}

pub(super) fn verify_link_target(source: &PinnedFile, destination: &PinnedDirectory, name: &OsStr) -> io::Result<bool> {
    checked_name(name)?;
    validate_private(&destination.file)?;
    let observer = match relative_open(&destination.file, name, FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, false, false) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
    let target = inspect(&observer, false)?;
    validate_private(&observer)?;
    let current = source.identity()?;
    Ok(current.links == 2 && target.links == 2 && current.same_file(&target))
}

pub(super) fn publish_no_replace(source: &PinnedFile, destination: &PinnedDirectory, name: &OsStr) -> io::Result<()> {
    checked_name(name)?;
    validate_private(&destination.file)?;
    if source.identity()?.links != 1 { return Err(denied()); }
    let encoded_name: Vec<u16> = name.encode_wide().collect();
    let total = (offset_of!(FILE_LINK_INFORMATION, FileName) + encoded_name.len() * 2).max(size_of::<FILE_LINK_INFORMATION>());
    let mut storage = vec![0usize; total.div_ceil(size_of::<usize>())];
    let mut status_block = IO_STATUS_BLOCK::default();
    // SAFETY: correctly aligned buffer contains the full documented structure
    // and trailing name. Both source and destination are owned handles; the
    // destination is one relative component. No source/ancestor pathname is
    // reparsed, even if an empty pinned directory becomes a junction in place.
    unsafe {
        let information = storage.as_mut_ptr().cast::<FILE_LINK_INFORMATION>();
        (*information).Anonymous = FILE_LINK_INFORMATION_0 { ReplaceIfExists: false };
        (*information).RootDirectory = destination.file.as_raw_handle();
        (*information).FileNameLength = (encoded_name.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(encoded_name.as_ptr(), std::ptr::addr_of_mut!((*information).FileName).cast(), encoded_name.len());
        let status = NtSetInformationFile(source.file.as_raw_handle(), &mut status_block, information.cast(), total as u32, FileLinkInformation);
        if status != 0 { return Err(nt_error(status)); }
    }
    if !verify_link_target(source, destination, name)? { return Err(denied()); }
    source.file.sync_all()
}

pub(super) fn replace_private_file(source: &PinnedFile, target: &PinnedFile) -> io::Result<()> {
    if source.identity()?.links != 1 || target.identity()?.links != 1
        || source.original.same_file(&target.original)
        || source.original.volume_serial != target.original.volume_serial
        || !source._parent.identity.same_file(&target._parent.identity)
    {
        return Err(denied());
    }
    validate_private(&target._parent.file)?;
    source.file.sync_all()?;
    let name: Vec<u16> = target.path.file_name().ok_or_else(denied)?.encode_wide().collect();
    let byte_length = name.len().checked_mul(2).ok_or_else(denied)?;
    let total = offset_of!(FILE_RENAME_INFORMATION, FileName).checked_add(byte_length).ok_or_else(denied)?.max(size_of::<FILE_RENAME_INFORMATION>());
    let mut storage = vec![0usize; total.div_ceil(size_of::<usize>())];
    let mut status_block = IO_STATUS_BLOCK::default();
    // SAFETY: usize storage aligns FILE_RENAME_INFORMATION; the allocation includes the
    // complete UTF-16 trailing array. NULL root anchors the single target name to
    // the source's verified same parent. The backup target permits delete sharing;
    // its writer lease and final identity check coordinate Motion writers, not CAS.
    confirm_replacement_target(target)?;
    unsafe {
        let information = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
        (*information).Anonymous = FILE_RENAME_INFORMATION_0 { Flags: FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS };
        (*information).RootDirectory = null_mut();
        (*information).FileNameLength = byte_length as u32;
        std::ptr::copy_nonoverlapping(name.as_ptr(), std::ptr::addr_of_mut!((*information).FileName).cast(), name.len());
        let status = NtSetInformationFile(source.file.as_raw_handle(), &mut status_block, information.cast(), total as u32, FileRenameInformationEx);
        if status != 0 { return Err(nt_error(status)); }
    }
    // source.path() refers to its former name after success: callers must only
    // drop it, never call remove(). The handle still authenticates published bytes.
    // No fallible work follows the rename: the caller can disarm its temporary
    // cleanup guard before requesting any further durability check.
    Ok(())
}

/// Only backup/UI-state replacement uses this sharing mode. The retained handle
/// denies content writes while permitting the OS's atomic namespace replacement.
/// Ordinary attachment readers and mutable database pins keep denying deletion.
pub(super) fn open_replacement_target(path: &Path) -> io::Result<PinnedFile> {
    let parent = parent_for_file(path)?;
    let file = relative_open(&parent.file, path.file_name().ok_or_else(denied)?,
        GENERIC_READ | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_DELETE, false, false)?;
    checked_file(path, file, parent, 1)
}

/// Recheck the destination through the retained parent immediately before the
/// native rename. This detects earlier substitutions; it does not implement an
/// atomic compare-and-swap against another process in the trusted user session.
pub(super) fn confirm_replacement_target(target: &PinnedFile) -> io::Result<()> {
    validate_private(&target._parent.file)?;
    let current = relative_open(&target._parent.file, target.path.file_name().ok_or_else(denied)?,
        FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, false, false)?;
    validate_private(&current)?;
    let named = inspect(&current, false)?;
    let retained = target.identity()?;
    if named.links != 1 || retained.links != 1 || !named.same_file(&retained) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "IDENTITY_CHANGED: Replacement target changed before publication"));
    }
    Ok(())
}

/// Call only after disarming temporary-name cleanup following a successful
/// rename. The source handle now pins the published object against displacement.
pub(super) fn verify_published_file(source: &PinnedFile, destination: &PinnedDirectory, name: &OsStr) -> io::Result<()> {
    checked_name(name)?;
    validate_private(&destination.file)?;
    let published = relative_open(&destination.file, name, FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, false, false)?;
    validate_private(&published)?;
    let named = inspect(&published, false)?;
    let retained = source.identity()?;
    if named.links != 1 || retained.links != 1 || !named.same_file(&retained) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "IDENTITY_CHANGED: Published object could not be authenticated"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("motion-win-{label}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)))
    }

    #[test]
    fn rejects_ambiguous_remote_and_device_paths() {
        for value in [r"\\server\share\data", r"\\.\C:\data", r"C:relative", r"C:\data\..\other", r"C:\data\a:stream", r"C:\data\NUL", "C:\\data\\space "] {
            assert!(components(Path::new(value)).is_err(), "{value}");
        }
        assert!(components(Path::new(r"C:\Users\Name With Spaces\Motion")).is_ok());
        assert!(components(Path::new(r"\\?\Volume{12345678-1234-abcd-9876-123456789abc}\Motion")).is_ok());
        assert!(components(Path::new(r"\\?\Volume{not-a-guid}\Motion")).is_err());
    }

    #[test]
    fn root_lease_blocks_a_second_writer_and_survives_release_without_evidence_rewrite() {
        let path = test_root("lease");
        let root = pin_private_directory(&path, true).unwrap();
        let lease = acquire_root_writer(&root).unwrap();
        let identity = lease.identity().unwrap();
        assert!(acquire_root_writer(&root).is_err());
        assert!(std::fs::rename(&path, path.with_extension("moved")).is_err());
        drop(lease);
        let successor = acquire_root_writer(&root).unwrap();
        assert!(identity.same_file(&successor.identity().unwrap()));
        assert_eq!(successor.file().metadata().unwrap().len(), 0);
        drop(successor);
        drop(root);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn private_file_pins_reject_hardlinks_and_block_path_substitution() {
        let path = test_root("file");
        let root = pin_private_directory(&path, true).unwrap();
        let source_path = path.join("source");
        let mut source = create_private_file(&source_path).unwrap();
        source.file_mut().write_all(b"durable").unwrap();
        source.file().sync_all().unwrap();
        assert!(std::fs::rename(&source_path, path.join("moved")).is_err());
        drop(source);
        std::fs::hard_link(&source_path, path.join("link")).unwrap();
        assert!(open_private_file(&source_path, false).is_err());
        drop(root);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn hardlink_publication_preserves_identity_and_cannot_replace_destination() {
        let path = test_root("publish");
        let root = pin_private_directory(&path, true).unwrap();
        let mut source = create_private_file(&path.join("staged")).unwrap();
        source.file_mut().write_all(b"verified bytes").unwrap();
        source.file().sync_all().unwrap();
        let identity = source.identity().unwrap();
        publish_no_replace(&source, &root, OsStr::new("final")).unwrap();
        assert!(verify_link_target(&source, &root, OsStr::new("final")).unwrap());
        source.remove().unwrap();
        let mut published = open_private_file(&path.join("final"), false).unwrap();
        assert!(identity.same_file(&published.identity().unwrap()));
        assert_eq!(published.identity().unwrap().links, 1);
        let mut bytes = Vec::new();
        published.file_mut().read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"verified bytes");
        drop(published);
        let other = create_private_file(&path.join("other")).unwrap();
        assert!(publish_no_replace(&other, &root, OsStr::new("final")).is_err());
        other.remove().unwrap();
        drop(root);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn mutable_guard_allows_data_writes_but_blocks_file_replacement() {
        let path = test_root("sqlite-pin");
        let root = pin_private_directory(&path, true).unwrap();
        let file_path = path.join("motion.sqlite3");
        let pinned = pin_mutable_file(&file_path, true).unwrap();
        std::fs::write(&file_path, b"database bytes").unwrap();
        assert!(std::fs::rename(&file_path, path.join("moved")).is_err());
        drop(pinned);
        drop(root);
        std::fs::remove_dir_all(path).unwrap();
    }
}

#[cfg(test)]
#[path = "tests/mod.rs"]
mod filesystem_regressions;

#[cfg(test)]
#[path = "tests/replacement.rs"]
mod replacement_tests;
