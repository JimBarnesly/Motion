# Windows native regression fixtures

These tests run inside `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml`
on Windows. The enclosing production module is Windows-only. There are no
runtime skips or fallback fixtures: failure to install a junction or set the
controlled DACL is a failed setup, not a passed defense test.

`reparse_after_pin.rs` retains an authenticated empty directory handle, installs
a real mount-point reparse buffer through a separate attribute handle, checks
that the same volume/file ID now has reparse metadata, and proves ordinary
path access reaches a controlled sentinel. It then exercises relative creation
and native hard-link publication. Rejection and operation within the original
pinned directory are accepted; any new entry in the redirected target fails.
The junction is removed through its retained handle before fixture cleanup.

`acl_preservation.rs` creates a private parent and an unprotected child granting
Builtin Users read access. It compares exact owner and DACL bytes, descriptor
control flags, and file contents before root reopening and after child rejection.
A separate positive control deliberately applies the old inheritable parent
DACL and requires an actual child ACL change. All owner assignments come from
native private creation; the fixture does not take ownership or enable privileges.

The new tests have been written for actual Windows execution. Cross-compiling
them checks bindings and types only; it does not establish their OS behavior.

## Mapped network drive coverage

A drive-letter alias backed by SMB remains a separate required runtime fixture.
It needs a real reachable SMB share, an authenticated mapping in the test user's
logon session, and permission to create and remove only its controlled test
directory. A loopback setup additionally needs the Windows SMB server/client
services and administrator authority to provision and remove the share. The
test must first prove the mapping is usable through ordinary filesystem APIs,
then require Motion's opened-volume authentication to reject it without creating
data. Neither a local `SUBST` drive nor a rejected UNC string demonstrates this
property. No unavailable-share case is counted as passing coverage here.

## API references

- [Reparse buffer layout](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_reparse_data_buffer)
- [Set reparse point](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_set_reparse_point)
- [Delete reparse point](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_delete_reparse_point)
- [Sharing and attribute access](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
- [DACL propagation](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo)
