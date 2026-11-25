use super::super::{pin_private_directory, PinnedDirectory};
use std::{
    ffi::c_void,
    fs::{self, File, OpenOptions},
    io,
    mem::{offset_of, size_of},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    path::{Path, PathBuf},
    ptr::{null_mut, copy_nonoverlapping, addr_of_mut},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use windows_sys::{
    Wdk::Storage::FileSystem::{REPARSE_DATA_BUFFER, REPARSE_DATA_BUFFER_0_1},
    Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
                SetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT},
            GetLengthSid, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
            IsValidAcl, IsValidSecurityDescriptor, IsValidSid, ACL,
            DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION, UNPROTECTED_DACL_SECURITY_INFORMATION,
        },
        Storage::FileSystem::{
            GetFileInformationByHandle, GetFileInformationByHandleEx,
            BY_HANDLE_FILE_INFORMATION, FILE_ID_INFO, FileIdInfo,
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_WRITE_ATTRIBUTES,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, READ_CONTROL, WRITE_DAC,
        },
        System::{IO::DeviceIoControl, Ioctl::{FSCTL_DELETE_REPARSE_POINT, FSCTL_SET_REPARSE_POINT},
            SystemServices::IO_REPARSE_TAG_MOUNT_POINT},
    },
};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

pub(super) struct TestTree {
    path: PathBuf,
}

impl TestTree {
    pub(super) fn new(label: &str) -> io::Result<Self> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("motion-regression-{label}-{}-{nonce}-{}",
            std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        // Native creation supplies an explicit current-user owner, including
        // when the test process runs with an elevated token's default owner.
        let root = pin_private_directory(&path, true)?;
        Ok(Self { path: root.path().to_owned() })
    }

    pub(super) fn path(&self) -> &Path { &self.path }

    pub(super) fn finish(self) -> io::Result<()> { fs::remove_dir_all(&self.path) }
}

impl Drop for TestTree {
    fn drop(&mut self) {
        // Fixture junctions are removed by their own earlier-dropped guard.
        // All targets are inside this disposable tree, never user data.
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct RawIdentity {
    volume: u64,
    id: [u8; 16],
}

fn raw_identity_and_attributes(file: &File) -> io::Result<(RawIdentity, u32)> {
    let mut basic = BY_HANDLE_FILE_INFORMATION::default();
    let mut id = FILE_ID_INFO::default();
    // SAFETY: the fixture retains the handle; both output structures and sizes
    // match their SDK information classes. No output pointer is retained.
    unsafe {
        if GetFileInformationByHandle(file.as_raw_handle(), &mut basic) == 0
            || GetFileInformationByHandleEx(file.as_raw_handle(), FileIdInfo,
                (&mut id as *mut FILE_ID_INFO).cast(), size_of::<FILE_ID_INFO>() as u32) == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok((RawIdentity { volume: id.VolumeSerialNumber, id: id.FileId.Identifier }, basic.dwFileAttributes))
}

/// Installs a real junction without dropping the original directory pin. Setup
/// failure is a failing test, never evidence that the mutation was defended.
pub(super) struct InPlaceJunction {
    attributes: File,
    active: bool,
}

impl InPlaceJunction {
    pub(super) fn install(pinned: &PinnedDirectory, target: &Path) -> io::Result<Self> {
        let attributes = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(pinned.path())?;
        let (before, old_attributes) = raw_identity_and_attributes(&attributes)?;
        assert_eq!(old_attributes & FILE_ATTRIBUTE_REPARSE_POINT, 0, "fixture must begin as a directory");
        assert_eq!(before.volume, pinned.identity().volume_serial);
        assert_eq!(before.id, pinned.identity().file_id);
        let target_text = target.to_str().ok_or_else(|| invalid("Fixture path is not UTF-8"))?;
        let volume_path = target_text.strip_prefix(r"\\?\Volume{")
            .ok_or_else(|| invalid("Fixture target must use its authenticated local volume"))?;
        let substitute: Vec<u16> = format!(r"\??\Volume{{{volume_path}").encode_utf16().collect();
        let print: Vec<u16> = target.as_os_str().encode_wide().collect();
        let header = offset_of!(REPARSE_DATA_BUFFER, Anonymous);
        let name_offset = header + offset_of!(REPARSE_DATA_BUFFER_0_1, PathBuffer);
        let total = name_offset + (substitute.len() + print.len() + 2) * size_of::<u16>();
        if total > 16_384 { return Err(invalid("Fixture reparse buffer exceeds the Windows bound")); }
        let mut buffer = vec![0usize; total.max(size_of::<REPARSE_DATA_BUFFER>()).div_ceil(size_of::<usize>())];
        let mut returned = 0;
        // SAFETY: usize storage aligns the SDK reparse structure and covers the
        // full names. All byte lengths are below 16 KiB. Names are terminated,
        // offsets are relative to PathBuffer, and the synchronous call borrows
        // the allocation and live attribute handle only until it returns.
        unsafe {
            let data = buffer.as_mut_ptr().cast::<REPARSE_DATA_BUFFER>();
            (*data).ReparseTag = IO_REPARSE_TAG_MOUNT_POINT;
            (*data).ReparseDataLength = (total - header) as u16;
            let mount = addr_of_mut!((*data).Anonymous.MountPointReparseBuffer);
            (*mount).SubstituteNameOffset = 0;
            (*mount).SubstituteNameLength = (substitute.len() * 2) as u16;
            (*mount).PrintNameOffset = ((substitute.len() + 1) * 2) as u16;
            (*mount).PrintNameLength = (print.len() * 2) as u16;
            let names = addr_of_mut!((*mount).PathBuffer).cast::<u16>();
            copy_nonoverlapping(substitute.as_ptr(), names, substitute.len());
            copy_nonoverlapping(print.as_ptr(), names.add(substitute.len() + 1), print.len());
            if DeviceIoControl(attributes.as_raw_handle(), FSCTL_SET_REPARSE_POINT,
                data.cast(), total as u32, null_mut(), 0, &mut returned, null_mut()) == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        let junction = Self { attributes, active: true };
        let (after, new_attributes) = raw_identity_and_attributes(&junction.attributes)?;
        assert_eq!(before, after, "fixture must mutate the same directory object in place");
        assert_ne!(new_attributes & FILE_ATTRIBUTE_REPARSE_POINT, 0, "fixture must install an actual reparse point");
        Ok(junction)
    }

    pub(super) fn clear(&mut self) -> io::Result<()> {
        if !self.active { return Ok(()); }
        let mut data = REPARSE_DATA_BUFFER::default();
        data.ReparseTag = IO_REPARSE_TAG_MOUNT_POINT;
        let mut returned = 0;
        // SAFETY: deletion takes the SDK's header with matching tag and zero
        // data length. It targets the still-open original attribute handle.
        unsafe {
            if DeviceIoControl(self.attributes.as_raw_handle(), FSCTL_DELETE_REPARSE_POINT,
                (&data as *const REPARSE_DATA_BUFFER).cast(), offset_of!(REPARSE_DATA_BUFFER, Anonymous) as u32,
                null_mut(), 0, &mut returned, null_mut()) == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        self.active = false;
        Ok(())
    }
}

impl Drop for InPlaceJunction {
    fn drop(&mut self) { let _ = self.clear(); }
}

struct SecurityAllocation(*mut c_void);

impl Drop for SecurityAllocation {
    fn drop(&mut self) {
        // SAFETY: successful security conversion/query results have one owner
        // and are documented LocalFree allocations. No borrowed data survives.
        unsafe { LocalFree(self.0); }
    }
}

fn security_handle(path: &Path, directory: bool, write: bool) -> io::Result<File> {
    OpenOptions::new().access_mode(READ_CONTROL | if write { WRITE_DAC } else { 0 })
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | if directory { FILE_FLAG_BACKUP_SEMANTICS } else { 0 })
        .open(path)
}

pub(super) fn set_fixture_dacl(path: &Path, directory: bool, sddl: &str, protected: bool) -> io::Result<()> {
    let file = security_handle(path, directory, true)?;
    let text: Vec<u16> = sddl.encode_utf16().chain([0]).collect();
    let mut raw = null_mut();
    // SAFETY: fixture-only caller supplies a complete terminated SDDL string;
    // the returned descriptor is owned through the synchronous Get/Set calls.
    // Only the DACL changes; this fixture never sets an owner or enables privileges.
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(), SDDL_REVISION_1,
            &mut raw, null_mut()) == 0 { return Err(io::Error::last_os_error()); }
        let descriptor = SecurityAllocation(raw);
        if descriptor.0.is_null() { return Err(invalid("Fixture descriptor missing")); }
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = null_mut();
        if GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted) == 0
            || present == 0 || dacl.is_null() || IsValidAcl(dacl) == 0
        { return Err(invalid("Fixture DACL missing or invalid")); }
        let status = SetSecurityInfo(file.as_raw_handle(), SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | if protected { PROTECTED_DACL_SECURITY_INFORMATION } else { UNPROTECTED_DACL_SECURITY_INFORMATION },
            null_mut(), null_mut(), dacl, null_mut());
        if status != 0 { return Err(io::Error::from_raw_os_error(status as i32)); }
    }
    Ok(())
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct SecuritySnapshot {
    pub(super) owner: Vec<u8>,
    pub(super) dacl: Vec<u8>,
    pub(super) control: u16,
}

pub(super) fn security_snapshot(path: &Path, directory: bool) -> io::Result<SecuritySnapshot> {
    let file = security_handle(path, directory, false)?;
    let mut owner = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut raw = null_mut();
    // SAFETY: GetSecurityInfo owns all subordinate pointers in one allocation.
    // The OS descriptor/SID/ACL are validated before reading their documented
    // lengths; copied owner and ACL bytes outlive the allocation, pointers do not.
    unsafe {
        let status = GetSecurityInfo(file.as_raw_handle(), SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner, null_mut(), &mut dacl, null_mut(), &mut raw);
        if status != 0 { return Err(io::Error::from_raw_os_error(status as i32)); }
        let descriptor = SecurityAllocation(raw);
        if descriptor.0.is_null() || owner.is_null() || dacl.is_null()
            || IsValidSecurityDescriptor(descriptor.0) == 0 || IsValidSid(owner) == 0 || IsValidAcl(dacl) == 0
        { return Err(invalid("Fixture security descriptor invalid")); }
        let owner_length = GetLengthSid(owner) as usize;
        let acl_length = usize::from((*dacl).AclSize);
        if !(8..=68).contains(&owner_length) || acl_length < size_of::<ACL>() {
            return Err(invalid("Fixture security lengths invalid"));
        }
        let mut control = 0;
        let mut revision = 0;
        if GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(SecuritySnapshot {
            owner: std::slice::from_raw_parts(owner.cast::<u8>(), owner_length).to_vec(),
            dacl: std::slice::from_raw_parts(dacl.cast::<u8>(), acl_length).to_vec(),
            control,
        })
    }
}
