//! Handle-based Windows ownership and DACL boundary.
//!
//! Win32 allocations and handles never escape as unowned pointers. Every unsafe
//! block below only calls the pinned windows-sys ABI or reads its checked output.
//! No privilege is enabled and ownership is never taken from another account.

use std::{
    ffi::c_void,
    fs::File,
    io,
    mem::{offset_of, size_of},
    os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
    ptr::null_mut,
};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT,
        },
        GetAce, GetTokenInformation, IsValidAcl, IsValidSid,
        TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, TOKEN_QUERY, TOKEN_USER,
    },
    System::{
        SystemServices::ACCESS_ALLOWED_ACE_TYPE,
        Threading::{GetCurrentProcess, OpenProcessToken},
    },
};

pub(super) fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "Private Windows storage validation failed")
}

/// Owns exactly one LocalAlloc-compatible result returned by a Win32 security API.
struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: this pointer is a successful LocalAlloc-backed API result; the
        // wrapper is not Clone and releases it exactly once after all borrows.
        unsafe { LocalFree(self.0); }
    }
}

fn sid_text(sid: PSID) -> io::Result<String> {
    let mut text = null_mut();
    // SAFETY: callers supply a valid SID from a live token/descriptor whose
    // allocation remains owned for the entire call. The output is LocalAlloc.
    unsafe {
        if sid.is_null() || IsValidSid(sid) == 0 || ConvertSidToStringSidW(sid, &mut text) == 0 {
            return Err(denied());
        }
        let _allocation = LocalAllocation(text.cast());
        // A Windows SID has at most 15 subauthorities; its textual form is
        // bounded well below 256 UTF-16 units. Never scan an unbounded buffer.
        let mut length = 0;
        while length < 256 && *text.add(length) != 0 { length += 1; }
        if length == 256 { return Err(denied()); }
        String::from_utf16(std::slice::from_raw_parts(text, length)).map_err(|_| denied())
    }
}

pub(super) fn current_user_sid() -> io::Result<String> {
    // SAFETY: GetCurrentProcess returns a process pseudo-handle valid for this
    // process; it is borrowed only during the following synchronous query.
    process_user_sid(unsafe { BorrowedHandle::borrow_raw(GetCurrentProcess()) })
}

pub(super) fn process_user_sid(process: BorrowedHandle<'_>) -> io::Result<String> {
    let mut raw = null_mut();
    // SAFETY: the process pseudo-handle needs no ownership; OpenProcessToken
    // produces one real handle immediately transferred to OwnedHandle. The
    // TOKEN_USER buffer is correctly aligned and sized from the first call.
    unsafe {
        if OpenProcessToken(process.as_raw_handle(), TOKEN_QUERY, &mut raw) == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = OwnedHandle::from_raw_handle(raw);
        let mut required = 0;
        GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut required);
        if required < size_of::<TOKEN_USER>() as u32 || required > 65_536 {
            return Err(denied());
        }
        let mut storage = vec![0usize; (required as usize).div_ceil(size_of::<usize>())];
        if GetTokenInformation(token.as_raw_handle(), TokenUser, storage.as_mut_ptr().cast(), required, &mut required) == 0 {
            return Err(io::Error::last_os_error());
        }
        let user = &*storage.as_ptr().cast::<TOKEN_USER>();
        sid_text(user.User.Sid)
    }
}

pub(super) struct PrivateDescriptor(LocalAllocation);

impl PrivateDescriptor {
    pub(super) fn new() -> io::Result<Self> {
        let sid = current_user_sid()?;
        // The SID comes from the OS, not from a path or caller-supplied string.
        // P protects the DACL; OI/CI gives new children only the owner's grant.
        let sddl: Vec<u16> = format!("O:{sid}D:P(A;OICI;FA;;;{sid})").encode_utf16().chain([0]).collect();
        let mut descriptor = null_mut();
        // SAFETY: sddl is NUL-terminated and remains live; the documented API
        // initializes descriptor or reports failure. The result is owned once.
        unsafe {
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, null_mut()) == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        if descriptor.is_null() { return Err(denied()); }
        Ok(Self(LocalAllocation(descriptor)))
    }

    pub(super) fn as_ptr(&self) -> PSECURITY_DESCRIPTOR { self.0.0 }
}

/// Accept the current owner plus Windows' privileged SYSTEM/Administrators
/// principals. A newly created/hardened object uses the stricter owner-only DACL.
/// Unknown/callback/object/deny ACE formats fail closed rather than being guessed.
pub(super) fn validate_private(file: &File) -> io::Result<()> {
    let expected = current_user_sid()?;
    let mut owner: PSID = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: GetSecurityInfo returns one descriptor allocation; owner/DACL/ACE
    // pointers borrow from it. All reads remain in that allocation and occur
    // before its RAII owner is dropped. ACE SID lengths are bounded explicitly.
    unsafe {
        let status = GetSecurityInfo(file.as_raw_handle(), SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner, null_mut(), &mut dacl, null_mut(), &mut descriptor);
        if status != 0 { return Err(io::Error::from_raw_os_error(status as i32)); }
        let _allocation = LocalAllocation(descriptor);
        if descriptor.is_null() || owner.is_null() || dacl.is_null()
            || sid_text(owner)? != expected || IsValidAcl(dacl) == 0 || (*dacl).AceCount == 0
        {
            return Err(denied());
        }
        for index in 0..u32::from((*dacl).AceCount) {
            let mut raw_ace = null_mut();
            if GetAce(dacl, index, &mut raw_ace) == 0 || raw_ace.is_null() { return Err(denied()); }
            let header = &*raw_ace.cast::<ACE_HEADER>();
            let sid_offset = offset_of!(ACCESS_ALLOWED_ACE, SidStart);
            if u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE
                || usize::from(header.AceSize) < sid_offset + 8
            {
                return Err(denied());
            }
            let sid = raw_ace.cast::<u8>().add(sid_offset);
            let sid_bytes = 8usize + 4 * usize::from(*sid.add(1));
            if sid_bytes > usize::from(header.AceSize) - sid_offset { return Err(denied()); }
            let trustee = sid_text(sid.cast())?;
            if trustee != expected && trustee != "S-1-5-18" && trustee != "S-1-5-32-544" {
                return Err(denied());
            }
        }
    }
    Ok(())
}
