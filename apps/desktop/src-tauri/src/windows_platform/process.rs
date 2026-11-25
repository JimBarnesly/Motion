use super::security::{current_user_sid, denied, process_user_sid};
use std::{fs::File, io, mem::size_of, os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle}, process::Child, ptr::{null, null_mut}};
use windows_sys::Win32::{
    Foundation::{DuplicateHandle, DUPLICATE_CLOSE_SOURCE, DUPLICATE_SAME_ACCESS, FILETIME, HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
        Threading::{GetCurrentProcess, GetCurrentProcessId, GetProcessTimes, OpenProcess, PROCESS_DUP_HANDLE, PROCESS_QUERY_LIMITED_INFORMATION},
    },
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// Non-inheritable, unnamed job. Its final handle closes on orderly shutdown or
/// process death, terminating the Node runner and its Windows helper descendants.
pub(crate) struct ServiceJob(OwnedHandle);

impl ServiceJob {
    pub(crate) fn new() -> io::Result<Self> {
        // SAFETY: null security attributes create a non-inheritable handle; a
        // null name creates an unnamed job. Ownership transfers exactly once.
        let handle = unsafe {
            let raw = CreateJobObjectW(null(), null());
            if raw.is_null() { return Err(io::Error::last_os_error()); }
            OwnedHandle::from_raw_handle(raw)
        };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the job remains owned and limits has the exact documented
        // information-class type/size. The API does not retain its pointer.
        unsafe {
            if SetInformationJobObject(handle.as_raw_handle(), JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(Self(handle))
    }

    pub(crate) fn attach(&self, child: &Child) -> io::Result<()> {
        // SAFETY: both arguments are live owned handles. The service is waiting
        // at its stdin startup gate and cannot spawn helpers before assignment.
        unsafe {
            if AssignProcessToJobObject(self.0.as_raw_handle(), child.as_raw_handle()) == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }
}

/// Copies ownership handles into the authenticated Node parent. If this helper
/// dies while Node is blocked in synchronous work, the kernel still retains the
/// lease and pins in Node. Remote handle values never cross the JSON protocol.
pub(super) struct ParentPins {
    process: OwnedHandle,
    remote: Vec<HANDLE>,
}

impl ParentPins {
    pub(super) fn for_current_parent() -> io::Result<Self> {
        // SAFETY: the snapshot/parent handles are immediately RAII-owned. The
        // process-entry structure is correctly sized for the Toolhelp API. Parent
        // PID comes from the OS, not the caller, and creation/token checks bind it
        // before it receives any capability. Retaining its handle defeats reuse.
        unsafe {
            let raw = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if raw == INVALID_HANDLE_VALUE { return Err(io::Error::last_os_error()); }
            let snapshot = OwnedHandle::from_raw_handle(raw);
            let mut entry = PROCESSENTRY32W::default();
            entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
            let current_id = GetCurrentProcessId();
            let mut found = Process32FirstW(snapshot.as_raw_handle(), &mut entry) != 0;
            let mut parent_id = None;
            while found {
                if entry.th32ProcessID == current_id { parent_id = Some(entry.th32ParentProcessID); break; }
                found = Process32NextW(snapshot.as_raw_handle(), &mut entry) != 0;
            }
            let parent_id = parent_id.filter(|id| *id != 0 && *id != current_id).ok_or_else(denied)?;
            let raw = OpenProcess(PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION, 0, parent_id);
            if raw.is_null() { return Err(io::Error::last_os_error()); }
            let process = OwnedHandle::from_raw_handle(raw);
            let created = |handle| -> io::Result<u64> {
                let mut creation = FILETIME::default();
                let mut exit = FILETIME::default();
                let mut kernel = FILETIME::default();
                let mut user = FILETIME::default();
                if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
            };
            if created(process.as_raw_handle())? > created(GetCurrentProcess())?
                || process_user_sid(process.as_handle())? != current_user_sid()?
            {
                return Err(denied());
            }
            Ok(Self { process, remote: Vec::new() })
        }
    }

    pub(super) fn duplicate(&mut self, file: &File) -> io::Result<()> {
        let mut remote = null_mut();
        // SAFETY: source and target processes/handle remain alive. The remote
        // copy is non-inheritable and owned exclusively by this protocol; Node
        // never receives its value, so it cannot be reused by a JS close call.
        unsafe {
            if DuplicateHandle(GetCurrentProcess(), file.as_raw_handle(), self.process.as_raw_handle(),
                &mut remote, 0, 0, DUPLICATE_SAME_ACCESS) == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        self.remote.push(remote);
        Ok(())
    }

    /// Only the normal EOF release path closes remote copies. Dropping this
    /// object on an abnormal guardian error intentionally leaves them in Node
    /// until Node exits, preserving single-writer exclusion during blocked I/O.
    pub(super) fn release(mut self) -> io::Result<()> {
        let mut error = None;
        for remote in self.remote.drain(..) {
            let mut recovered = null_mut();
            // SAFETY: retained process identity and private remote IDs identify
            // the exact copies created above. CLOSE_SOURCE closes each remote
            // handle even on failure, so none is retried or treated as reusable.
            unsafe {
                if DuplicateHandle(self.process.as_raw_handle(), remote, GetCurrentProcess(),
                    &mut recovered, 0, 0, DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS) != 0
                {
                    drop(OwnedHandle::from_raw_handle(recovered));
                } else if error.is_none() {
                    error = Some(io::Error::last_os_error());
                }
            }
        }
        error.map_or(Ok(()), Err)
    }
}
