//! Windows filesystem security primitives used where Unix relies on dirfds,
//! `O_NOFOLLOW`, and mode bits. The Windows beta deliberately accepts only
//! local NTFS paths and rejects every reparse point in a protected path.

#![cfg(target_os = "windows")]

use std::ffi::{OsStr, OsString};
use std::fs::{File, Metadata, OpenOptions};
use std::io::Write;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Component, Path, PathBuf, Prefix};

use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    FileIdBothDirectoryInformation, NtCreateFile, NtQueryDirectoryFile, FILE_CREATE,
    FILE_DIRECTORY_FILE, FILE_ID_BOTH_DIR_INFORMATION, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
    FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT, FILE_WRITE_THROUGH,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, LocalFree, ERROR_SUCCESS, GENERIC_READ, GENERIC_WRITE, OBJ_CASE_INSENSITIVE,
    STATUS_NO_MORE_FILES, STATUS_NO_SUCH_FILE, STATUS_OBJECT_NAME_NOT_FOUND, UNICODE_STRING,
};
use windows_sys::Win32::Security::Authorization::{
    GetSecurityInfo, SetEntriesInAclW, SetSecurityInfo, EXPLICIT_ACCESS_W, NO_MULTIPLE_TRUSTEE,
    SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_IS_WELL_KNOWN_GROUP,
    TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    CopySid, CreateWellKnownSid, EqualSid, GetLengthSid, GetTokenInformation,
    InitializeSecurityDescriptor, SetSecurityDescriptorControl, SetSecurityDescriptorDacl,
    TokenUser, WinLocalSystemSid, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, NO_INHERITANCE,
    OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSID,
    SECURITY_DESCRIPTOR, SECURITY_MAX_SID_SIZE, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    FileDispositionInfo, FileRenameInfo, GetDriveTypeW, GetFileInformationByHandle,
    GetFinalPathNameByHandleW, GetVolumeInformationByHandleW, SetFileInformationByHandle,
    BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ALL_ACCESS, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_INFO,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_NAME_NORMALIZED,
    FILE_READ_ATTRIBUTES, FILE_RENAME_INFO, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_TRAVERSE, READ_CONTROL, SYNCHRONIZE, VOLUME_NAME_GUID, WRITE_DAC,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::System::WindowsProgramming::DRIVE_FIXED;
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
};

const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
const TRAVERSE_ACCESS: u32 = FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
const ACL_ACCESS: u32 = READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
const DIRECTORY_ACL_ACCESS: u32 = ACL_ACCESS | GENERIC_READ;
const CREATE_PARENT_ACCESS: u32 = GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE;
const ACL_MIGRATION_MARKER: &str = ".windows-acl-v2";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileIdentity {
    volume: u32,
    index: u64,
}

#[derive(Clone, Copy)]
enum ExpectedKind {
    Any,
    Directory,
    File,
}

impl ExpectedKind {
    fn create_options(self) -> u32 {
        match self {
            Self::Any => 0,
            Self::Directory => FILE_DIRECTORY_FILE,
            Self::File => FILE_NON_DIRECTORY_FILE,
        }
    }
}

struct PinnedPath {
    path: PathBuf,
    handle: File,
    identity: FileIdentity,
    directory: bool,
}

#[derive(Debug)]
struct NtOpenError(i32);

fn rejects_prefix(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component,
            Component::Prefix(prefix)
                if matches!(
                    prefix.kind(),
                    Prefix::UNC(..)
                        | Prefix::VerbatimUNC(..)
                        | Prefix::DeviceNS(..)
                        | Prefix::Verbatim(..)
                )
        )
    })
}

pub fn is_reparse(metadata: &Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

/// Produce an absolute lexical path without resolving links. Security checks
/// must inspect the path the caller supplied; canonicalizing first erases the
/// junction or symlink that needs to be rejected.
fn absolute_lexical(path: &Path) -> Result<PathBuf, String> {
    if path
        .components()
        .next()
        .is_some_and(|component| matches!(component, Component::Prefix(_)) && !path.is_absolute())
    {
        return Err("drive-relative Windows paths are not supported for protected data".into());
    }
    let source = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("resolve the current Windows directory: {error}"))?
            .join(path)
    };
    let mut normalized = PathBuf::new();
    let mut normal_depth = 0usize;
    for component in source.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if normal_depth == 0 || !normalized.pop() {
                    return Err("protected Windows path escapes its volume root".into());
                }
                normal_depth -= 1;
            }
            Component::Normal(value) => {
                normalized.push(value);
                normal_depth += 1;
            }
            Component::Prefix(_) | Component::RootDir => {
                normalized.push(component.as_os_str());
            }
        }
    }
    Ok(normalized)
}

fn protected_components(path: &Path) -> Result<(PathBuf, PathBuf, Vec<OsString>), String> {
    if rejects_prefix(path) {
        return Err("UNC, device, and network paths are not supported for Windows Runbooks".into());
    }
    let lexical = absolute_lexical(path)?;
    if rejects_prefix(&lexical) {
        return Err("UNC, device, and network paths are not supported for Windows Runbooks".into());
    }

    let mut components = lexical.components();
    let prefix = match components.next() {
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)) => prefix,
        _ => return Err("protected Windows paths must use an absolute local drive path".into()),
    };
    let root_component = match components.next() {
        Some(Component::RootDir) => Component::RootDir,
        _ => return Err("protected Windows paths must include a drive root".into()),
    };
    let mut root = PathBuf::new();
    root.push(prefix.as_os_str());
    root.push(root_component.as_os_str());

    let mut names = Vec::new();
    for component in components {
        match component {
            Component::Normal(name) => {
                checked_plain_component(name)?;
                names.push(name.to_os_string());
            }
            _ => return Err("protected Windows path is not lexically normalized".into()),
        }
    }
    Ok((lexical, root, names))
}

fn open_volume_root(root: &Path, access: u32) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options
        .access_mode(access)
        .share_mode(SHARE_ALL)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
    options.open(root).map_err(|error| {
        format!(
            "pin protected Windows volume root {}: {error}",
            root.display()
        )
    })
}

fn require_local_ntfs_handle(root: &File) -> Result<u32, String> {
    let metadata = root
        .metadata()
        .map_err(|error| format!("inspect protected Windows volume root: {error}"))?;
    if !metadata.is_dir() || is_reparse(&metadata) {
        return Err("protected Windows volume root is not a plain directory".into());
    }

    let mut final_name = vec![0u16; 32_768];
    // SAFETY: `root` owns a valid handle and `final_name` exposes its full,
    // writable allocation with the exact capacity passed to Win32.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            root.as_raw_handle(),
            final_name.as_mut_ptr(),
            final_name.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_GUID,
        )
    };
    if length == 0 || length as usize >= final_name.len() {
        return Err(format!(
            "resolve the pinned Windows volume: {}",
            std::io::Error::last_os_error()
        ));
    }
    final_name.truncate(length as usize);
    let closing_brace = final_name
        .iter()
        .position(|value| *value == b'}' as u16)
        .ok_or("the pinned Windows handle did not report a volume GUID path")?;
    let root_end = closing_brace
        .checked_add(2)
        .filter(|end| {
            *end <= final_name.len() && final_name.get(closing_brace + 1) == Some(&(b'\\' as u16))
        })
        .ok_or("the pinned Windows handle reported an invalid volume GUID path")?;
    let mut volume_root = final_name[..root_end].to_vec();
    volume_root.push(0);
    // SAFETY: `volume_root` is a NUL-terminated UTF-16 volume GUID path.
    if unsafe { GetDriveTypeW(volume_root.as_ptr()) } != DRIVE_FIXED {
        return Err("Windows Runbook paths must be on a local fixed drive".into());
    }

    let mut filesystem = vec![0u16; 64];
    let mut volume_serial = 0u32;
    // SAFETY: `root` remains open and every optional output is either null or
    // points to initialized writable storage of the advertised size.
    let ok = unsafe {
        GetVolumeInformationByHandleW(
            root.as_raw_handle(),
            std::ptr::null_mut(),
            0,
            &mut volume_serial,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    };
    if ok == 0 {
        return Err(format!(
            "inspect the pinned Windows volume: {}",
            std::io::Error::last_os_error()
        ));
    }
    let length = filesystem
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(filesystem.len());
    if !String::from_utf16_lossy(&filesystem[..length]).eq_ignore_ascii_case("NTFS") {
        return Err("Windows Runbook paths must be on a local NTFS volume".into());
    }
    Ok(volume_serial)
}

fn unicode_name(name: &OsStr) -> Result<(Vec<u16>, u16), String> {
    let name_wide: Vec<u16> = name.encode_wide().collect();
    let name_bytes = name_wide
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or("protected Windows child name is too long")?;
    Ok((name_wide, name_bytes))
}

fn nt_open_child(
    parent: &File,
    name: &OsStr,
    expected: ExpectedKind,
    access: u32,
    disposition: u32,
    write_through: bool,
    security_descriptor: *const SECURITY_DESCRIPTOR,
) -> Result<File, NtOpenError> {
    let (mut name_wide, name_bytes) = unicode_name(name).map_err(|_| NtOpenError(i32::MIN))?;
    let object_name = UNICODE_STRING {
        Length: name_bytes,
        MaximumLength: name_bytes,
        Buffer: name_wide.as_mut_ptr(),
    };
    let object_attributes = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &object_name,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: security_descriptor,
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut io_status = IO_STATUS_BLOCK::default();
    let mut raw_file = std::ptr::null_mut();
    // SAFETY: all pointer-backed NT structures borrow live local buffers for
    // this call, the parent handle is valid, and the returned handle is checked.
    let status = unsafe {
        NtCreateFile(
            &mut raw_file,
            access,
            &object_attributes,
            &mut io_status,
            std::ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            SHARE_ALL,
            disposition,
            expected.create_options()
                | FILE_OPEN_REPARSE_POINT
                | FILE_SYNCHRONOUS_IO_NONALERT
                | if write_through { FILE_WRITE_THROUGH } else { 0 },
            std::ptr::null(),
            0,
        )
    };
    if status < 0 {
        return Err(NtOpenError(status));
    }
    // SAFETY: successful `NtCreateFile` returns one owned, non-null handle;
    // transferring it to `File` gives that handle exactly one closer.
    Ok(unsafe { File::from_raw_handle(raw_file) })
}

fn nt_error(action: &str, path: &Path, error: NtOpenError) -> String {
    if error.0 == i32::MIN {
        format!("{action} {}: child name is too long", path.display())
    } else {
        format!(
            "{action} {}: NTSTATUS {:#010x}",
            path.display(),
            error.0 as u32
        )
    }
}

fn inspect_pinned_handle(
    file: &File,
    expected: ExpectedKind,
    volume: u32,
    display_path: &Path,
) -> Result<(FileIdentity, bool), String> {
    let metadata = file.metadata().map_err(|error| {
        format!(
            "inspect protected Windows handle {}: {error}",
            display_path.display()
        )
    })?;
    if is_reparse(&metadata) {
        return Err(format!(
            "Windows Runbook paths may not contain reparse points: {}",
            display_path.display()
        ));
    }
    let directory = metadata.is_dir();
    if matches!(expected, ExpectedKind::Directory) && !directory {
        return Err(format!(
            "protected Windows path is not a directory: {}",
            display_path.display()
        ));
    }
    if matches!(expected, ExpectedKind::File) && directory {
        return Err(format!(
            "protected Windows path is not a file: {}",
            display_path.display()
        ));
    }
    let current = identity(file)?;
    if current.volume != volume {
        return Err(format!(
            "protected Windows path crossed its pinned NTFS volume: {}",
            display_path.display()
        ));
    }
    Ok((current, directory))
}

fn open_existing_verified_child(
    parent: &File,
    name: &OsStr,
    expected: ExpectedKind,
    access: u32,
    volume: u32,
    display_path: &Path,
    action: &str,
) -> Result<(File, bool), String> {
    let child = nt_open_child(
        parent,
        name,
        expected,
        access,
        FILE_OPEN,
        false,
        std::ptr::null(),
    )
    .map_err(|error| nt_error(action, display_path, error))?;
    let (_, is_directory) = inspect_pinned_handle(&child, expected, volume, display_path)?;
    Ok((child, is_directory))
}

fn pin_path_with_access(
    path: &Path,
    expected: ExpectedKind,
    final_access: u32,
) -> Result<PinnedPath, String> {
    let (lexical, root_path, names) = protected_components(path)?;
    let root_access = if names.is_empty() {
        final_access
    } else {
        TRAVERSE_ACCESS
    };
    let mut current = open_volume_root(&root_path, root_access)?;
    let volume = require_local_ntfs_handle(&current)?;
    let root_identity = identity(&current)?;
    if root_identity.volume != volume {
        return Err("the pinned Windows root identity does not match its NTFS volume".into());
    }
    let mut current_identity = root_identity;
    let mut directory = true;
    let mut display = root_path;

    for (index, name) in names.iter().enumerate() {
        let last = index + 1 == names.len();
        let kind = if last {
            expected
        } else {
            ExpectedKind::Directory
        };
        let access = if last { final_access } else { TRAVERSE_ACCESS };
        display.push(name);
        let child = nt_open_child(
            &current,
            name,
            kind,
            access,
            FILE_OPEN,
            false,
            std::ptr::null(),
        )
        .map_err(|error| nt_error("pin protected Windows component", &display, error))?;
        let inspected = inspect_pinned_handle(&child, kind, volume, &display)?;
        current = child;
        current_identity = inspected.0;
        directory = inspected.1;
    }

    Ok(PinnedPath {
        path: lexical,
        handle: current,
        identity: current_identity,
        directory,
    })
}

pub fn validate_local_ntfs_path(path: &Path) -> Result<PathBuf, String> {
    pin_path_with_access(path, ExpectedKind::Any, FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .map(|pinned| pinned.path)
}

pub fn open_no_reparse(path: &Path, directory: bool) -> Result<File, String> {
    pin_path_with_access(
        path,
        if directory {
            ExpectedKind::Directory
        } else {
            ExpectedKind::File
        },
        GENERIC_READ | SYNCHRONIZE,
    )
    .map(|pinned| pinned.handle)
}

pub fn identity(file: &File) -> Result<FileIdentity, String> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` owns a valid handle and `info` is writable for the full
    // `BY_HANDLE_FILE_INFORMATION` value Win32 initializes.
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) };
    if ok == 0 {
        return Err(format!(
            "inspect protected Windows handle identity: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(FileIdentity {
        volume: info.dwVolumeSerialNumber,
        index: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    })
}

pub fn verify_identity(path: &Path, expected: FileIdentity, directory: bool) -> Result<(), String> {
    let current = pin_path_with_access(
        path,
        if directory {
            ExpectedKind::Directory
        } else {
            ExpectedKind::File
        },
        FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    )?;
    if current.identity == expected {
        Ok(())
    } else {
        Err(format!(
            "protected Windows path changed while it was in use: {}",
            path.display()
        ))
    }
}

fn checked_plain_component(name: &OsStr) -> Result<&OsStr, String> {
    let units: Vec<u16> = name.encode_wide().collect();
    if units.is_empty()
        || units.iter().any(|unit| *unit == 0 || *unit == b':' as u16)
        || units
            .last()
            .is_some_and(|unit| *unit == b'.' as u16 || *unit == b' ' as u16)
    {
        return Err(
            "protected Windows path components may not use streams, NULs, or trailing aliases"
                .into(),
        );
    }
    Ok(name)
}

fn checked_leaf(name: &OsStr) -> Result<&OsStr, String> {
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(component)), None) => checked_plain_component(component),
        _ => Err("protected Windows child name must be one plain path component".into()),
    }
}

fn validate_parent_handle(parent: &File) -> Result<u32, String> {
    let volume = require_local_ntfs_handle(parent)?;
    let parent_identity = identity(parent)?;
    if parent_identity.volume != volume {
        return Err("protected Windows parent is not on its reported NTFS volume".into());
    }
    Ok(volume)
}

pub fn open_child_no_reparse(parent: &File, name: &OsStr, directory: bool) -> Result<File, String> {
    let name = checked_leaf(name)?;
    let volume = validate_parent_handle(parent)?;
    let child = nt_open_child(
        parent,
        name,
        if directory {
            ExpectedKind::Directory
        } else {
            ExpectedKind::File
        },
        GENERIC_READ | SYNCHRONIZE,
        FILE_OPEN,
        false,
        std::ptr::null(),
    )
    .map_err(|error| nt_error("open protected Windows child", Path::new(name), error))?;
    inspect_pinned_handle(
        &child,
        if directory {
            ExpectedKind::Directory
        } else {
            ExpectedKind::File
        },
        volume,
        Path::new(name),
    )?;
    Ok(child)
}

struct OwnedSid(Vec<usize>);

impl OwnedSid {
    fn as_ptr(&self) -> PSID {
        self.0.as_ptr().cast_mut().cast()
    }

    fn current_user() -> Result<Self, String> {
        let mut token = std::ptr::null_mut();
        // SAFETY: the pseudo-handle is always valid for the current process and
        // `token` is writable; success is checked before the handle is used.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(format!(
                "open the current Windows process token: {}",
                std::io::Error::last_os_error()
            ));
        }
        let result = (|| {
            let mut required = 0u32;
            // SAFETY: a null buffer with length zero is the documented sizing
            // call; `required` is a valid writable output.
            unsafe {
                GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut required);
            }
            if required == 0 {
                return Err(format!(
                    "size the current Windows user token: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let words = (required as usize).div_ceil(std::mem::size_of::<usize>());
            let mut token_buffer = vec![0usize; words];
            // SAFETY: `token_buffer` has at least `required` aligned writable
            // bytes and the token handle remains valid through this closure.
            if unsafe {
                GetTokenInformation(
                    token,
                    TokenUser,
                    token_buffer.as_mut_ptr().cast(),
                    required,
                    &mut required,
                )
            } == 0
            {
                return Err(format!(
                    "read the current Windows user token: {}",
                    std::io::Error::last_os_error()
                ));
            }
            // SAFETY: the successful call above initialized at least
            // `required >= size_of::<TOKEN_USER>()` bytes in this aligned buffer.
            let token_user = unsafe { &*(token_buffer.as_ptr().cast::<TOKEN_USER>()) };
            // SAFETY: `token_user.User.Sid` points into the still-live token
            // buffer populated by `GetTokenInformation`.
            let sid_length = unsafe { GetLengthSid(token_user.User.Sid) };
            if sid_length == 0 {
                return Err("the current Windows token contains an invalid user SID".into());
            }
            let sid_words = (sid_length as usize).div_ceil(std::mem::size_of::<usize>());
            let mut sid = vec![0usize; sid_words];
            // SAFETY: the source SID was validated for `sid_length` bytes and
            // `sid` provides an aligned destination allocation of that size.
            if unsafe { CopySid(sid_length, sid.as_mut_ptr().cast(), token_user.User.Sid) } == 0 {
                return Err(format!(
                    "copy the current Windows user SID: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(Self(sid))
        })();
        // SAFETY: `token` is the owned handle returned by `OpenProcessToken`
        // and this is its single unconditional close.
        unsafe {
            CloseHandle(token);
        }
        result
    }

    fn local_system() -> Result<Self, String> {
        let words = (SECURITY_MAX_SID_SIZE as usize).div_ceil(std::mem::size_of::<usize>());
        let mut sid = vec![0usize; words];
        let mut size = SECURITY_MAX_SID_SIZE;
        // SAFETY: `sid` is an aligned writable allocation of `size` bytes and
        // the optional domain SID is intentionally null for LocalSystem.
        if unsafe {
            CreateWellKnownSid(
                WinLocalSystemSid,
                std::ptr::null_mut(),
                sid.as_mut_ptr().cast(),
                &mut size,
            )
        } == 0
        {
            return Err(format!(
                "create the Windows LocalSystem SID: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self(sid))
    }
}

struct TrustedAcls {
    current_user: OwnedSid,
    file_acl: *mut windows_sys::Win32::Security::ACL,
    directory_acl: *mut windows_sys::Win32::Security::ACL,
}

impl TrustedAcls {
    fn new() -> Result<Self, String> {
        let current_user = OwnedSid::current_user()?;
        let local_system = OwnedSid::local_system()?;
        let file_acl = build_acl(&current_user, &local_system, NO_INHERITANCE)?;
        let directory_acl = match build_acl(
            &current_user,
            &local_system,
            OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
        ) {
            Ok(acl) => acl,
            Err(error) => {
                // SAFETY: `file_acl` was allocated by `SetEntriesInAclW` and
                // ownership has not yet moved into `TrustedAcls`.
                unsafe {
                    LocalFree(file_acl.cast());
                }
                return Err(error);
            }
        };
        Ok(Self {
            current_user,
            file_acl,
            directory_acl,
        })
    }

    fn apply(&self, file: &File, directory: bool) -> Result<(), String> {
        let acl = if directory {
            self.directory_acl
        } else {
            self.file_acl
        };
        // SAFETY: `file` is live and `acl` is owned by `self`, which outlives
        // this call; all unused security-info pointers are null.
        let status = unsafe {
            SetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                acl,
                std::ptr::null(),
            )
        };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!(
                "set the protected Windows user and LocalSystem ACL: {}",
                std::io::Error::from_raw_os_error(status as i32)
            ))
        }
    }

    fn creation_descriptor(&self, directory: bool) -> Result<SECURITY_DESCRIPTOR, String> {
        let mut descriptor = SECURITY_DESCRIPTOR::default();
        // SAFETY: `descriptor` is writable and the revision is the documented
        // `SECURITY_DESCRIPTOR_REVISION` value.
        if unsafe {
            InitializeSecurityDescriptor(
                std::ptr::addr_of_mut!(descriptor).cast(),
                1, // SECURITY_DESCRIPTOR_REVISION
            )
        } == 0
        {
            return Err(format!(
                "initialize the protected Windows creation descriptor: {}",
                std::io::Error::last_os_error()
            ));
        }
        let acl = if directory {
            self.directory_acl
        } else {
            self.file_acl
        };
        // SAFETY: `descriptor` is initialized and `acl` remains owned by
        // `self`; the API only records the pointer for this immediate use.
        if unsafe {
            SetSecurityDescriptorDacl(std::ptr::addr_of_mut!(descriptor).cast(), 1, acl, 0)
        } == 0
        {
            return Err(format!(
                "attach the protected Windows creation DACL: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: `descriptor` was initialized above and both control masks
        // use the documented `SE_DACL_PROTECTED` bit.
        if unsafe {
            SetSecurityDescriptorControl(
                std::ptr::addr_of_mut!(descriptor).cast(),
                SE_DACL_PROTECTED,
                SE_DACL_PROTECTED,
            )
        } == 0
        {
            return Err(format!(
                "protect the Windows creation DACL from inheritance: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(descriptor)
    }

    fn current_user_owns(&self, file: &File) -> Result<bool, String> {
        let mut owner = std::ptr::null_mut();
        let mut descriptor = std::ptr::null_mut();
        // SAFETY: `file` is live, all requested outputs are writable, and
        // omitted security components are represented by null pointers.
        let status = unsafe {
            GetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!(
                "inspect the Windows ACL migration marker owner: {}",
                std::io::Error::from_raw_os_error(status as i32)
            ));
        }
        // SAFETY: on successful `GetSecurityInfo`, a non-null owner points
        // inside the returned descriptor, while `current_user` owns a valid SID.
        let matches =
            !owner.is_null() && unsafe { EqualSid(owner, self.current_user.as_ptr()) } != 0;
        if !descriptor.is_null() {
            // SAFETY: Win32 allocated this descriptor for the successful call;
            // it is freed once after all embedded pointers are no longer used.
            unsafe {
                LocalFree(descriptor.cast());
            }
        }
        Ok(matches)
    }
}

impl Drop for TrustedAcls {
    fn drop(&mut self) {
        // SAFETY: both ACL pointers were allocated by `SetEntriesInAclW`, are
        // uniquely owned by this value, and are released exactly once here.
        unsafe {
            LocalFree(self.file_acl.cast());
            LocalFree(self.directory_acl.cast());
        }
    }
}

fn build_acl(
    current_user: &OwnedSid,
    local_system: &OwnedSid,
    inheritance: u32,
) -> Result<*mut windows_sys::Win32::Security::ACL, String> {
    let trustee = |sid: PSID, trustee_type| TRUSTEE_W {
        pMultipleTrustee: std::ptr::null_mut(),
        MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: trustee_type,
        ptstrName: sid.cast(),
    };
    let entries = [
        EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_ALL_ACCESS,
            grfAccessMode: SET_ACCESS,
            grfInheritance: inheritance,
            Trustee: trustee(current_user.as_ptr(), TRUSTEE_IS_USER),
        },
        EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_ALL_ACCESS,
            grfAccessMode: SET_ACCESS,
            grfInheritance: inheritance,
            Trustee: trustee(local_system.as_ptr(), TRUSTEE_IS_WELL_KNOWN_GROUP),
        },
    ];
    let mut acl = std::ptr::null_mut();
    // SAFETY: `entries` and both SID allocations remain live for the call, and
    // `acl` is a writable output whose ownership is transferred on success.
    let status = unsafe {
        SetEntriesInAclW(
            entries.len() as u32,
            entries.as_ptr(),
            std::ptr::null(),
            &mut acl,
        )
    };
    if status == ERROR_SUCCESS {
        Ok(acl)
    } else {
        Err(format!(
            "build the protected Windows user and LocalSystem ACL: {}",
            std::io::Error::from_raw_os_error(status as i32)
        ))
    }
}

fn create_child_relative(
    parent: &File,
    name: &OsStr,
    directory: bool,
    acls: &TrustedAcls,
) -> Result<File, String> {
    let name = checked_leaf(name)?;
    let path = Path::new(name);
    let descriptor = acls.creation_descriptor(directory)?;
    nt_open_child(
        parent,
        name,
        if directory {
            ExpectedKind::Directory
        } else {
            ExpectedKind::File
        },
        GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | SYNCHRONIZE,
        FILE_CREATE,
        true,
        std::ptr::addr_of!(descriptor).cast(),
    )
    .map_err(|error| nt_error("create protected Windows child", path, error))
}

pub fn create_secure_directory(parent: &Path, name: &OsStr) -> Result<PathBuf, String> {
    let name = checked_leaf(name)?;
    let parent = pin_path_with_access(parent, ExpectedKind::Directory, CREATE_PARENT_ACCESS)?;
    let child_path = parent.path.join(name);
    let acls = TrustedAcls::new()?;
    let child = create_child_relative(&parent.handle, name, true, &acls).map_err(|error| {
        format!(
            "create protected Windows directory {}: {error}",
            child_path.display()
        )
    })?;
    inspect_pinned_handle(
        &child,
        ExpectedKind::Directory,
        parent.identity.volume,
        &child_path,
    )?;
    acls.apply(&child, true)?;
    child.sync_all().map_err(|error| {
        format!(
            "sync protected Windows directory {}: {error}",
            child_path.display()
        )
    })?;
    parent.handle.sync_all().map_err(|error| {
        format!(
            "sync protected Windows parent {}: {error}",
            parent.path.display()
        )
    })?;
    Ok(child_path)
}

pub fn create_secure_file(
    parent: &Path,
    name: &OsStr,
) -> Result<(PathBuf, FileIdentity, File), String> {
    let name = checked_leaf(name)?;
    let parent = pin_path_with_access(parent, ExpectedKind::Directory, CREATE_PARENT_ACCESS)?;
    let path = parent.path.join(name);
    let acls = TrustedAcls::new()?;
    let file = create_child_relative(&parent.handle, name, false, &acls)
        .map_err(|error| format!("create protected Windows file {}: {error}", path.display()))?;
    let (file_identity, _) =
        inspect_pinned_handle(&file, ExpectedKind::File, parent.identity.volume, &path)?;
    acls.apply(&file, false)?;
    parent.handle.sync_all().map_err(|error| {
        format!(
            "sync protected Windows parent {}: {error}",
            parent.path.display()
        )
    })?;
    Ok((path, file_identity, file))
}

pub fn restrict_to_current_user(path: &Path) -> Result<(), String> {
    let (_, _, names) = protected_components(path)?;
    if names.is_empty() {
        return Err("refusing to change the ACL of a Windows volume root".into());
    }
    let pinned = pin_path_with_access(path, ExpectedKind::Any, ACL_ACCESS)?;
    TrustedAcls::new()?.apply(&pinned.handle, pinned.directory)
}

fn directory_entries(directory: &File) -> Result<Vec<(OsString, bool)>, String> {
    const BUFFER_BYTES: usize = 64 * 1024;
    let words = BUFFER_BYTES.div_ceil(std::mem::size_of::<usize>());
    let mut buffer = vec![0usize; words];
    let mut entries = Vec::new();
    let mut restart = true;

    loop {
        buffer.fill(0);
        let mut io_status = IO_STATUS_BLOCK::default();
        // SAFETY: `directory` is a pinned live directory handle and `buffer`
        // is aligned, writable, and exactly `BUFFER_BYTES` long.
        let status = unsafe {
            NtQueryDirectoryFile(
                directory.as_raw_handle(),
                std::ptr::null_mut(),
                None,
                std::ptr::null(),
                &mut io_status,
                buffer.as_mut_ptr().cast(),
                BUFFER_BYTES as u32,
                FileIdBothDirectoryInformation,
                false,
                std::ptr::null(),
                restart,
            )
        };
        restart = false;
        if status == STATUS_NO_MORE_FILES {
            break;
        }
        if status < 0 {
            return Err(format!(
                "enumerate the pinned Windows directory: NTSTATUS {:#010x}",
                status as u32
            ));
        }
        let returned = io_status.Information;
        if returned == 0 || returned > BUFFER_BYTES {
            return Err(
                "enumerating the pinned Windows directory returned an invalid length".into(),
            );
        }

        let mut offset = 0usize;
        loop {
            let header = std::mem::offset_of!(FILE_ID_BOTH_DIR_INFORMATION, FileName);
            if offset.checked_add(header).is_none_or(|end| end > returned) {
                return Err("the pinned Windows directory returned a malformed entry".into());
            }
            // SAFETY: the bounds check above proves the fixed header is inside
            // the initialized result buffer, which is aligned for this struct.
            let info = unsafe {
                &*(buffer
                    .as_ptr()
                    .cast::<u8>()
                    .add(offset)
                    .cast::<FILE_ID_BOTH_DIR_INFORMATION>())
            };
            let name_bytes = info.FileNameLength as usize;
            if !name_bytes.is_multiple_of(std::mem::size_of::<u16>())
                || offset
                    .checked_add(header)
                    .and_then(|start| start.checked_add(name_bytes))
                    .is_none_or(|end| end > returned)
            {
                return Err("the pinned Windows directory returned a malformed name".into());
            }
            // SAFETY: the validated byte count is even and its complete range
            // lies inside the live directory-query buffer.
            let name = OsString::from_wide(unsafe {
                std::slice::from_raw_parts(
                    std::ptr::addr_of!(info.FileName).cast::<u16>(),
                    name_bytes / std::mem::size_of::<u16>(),
                )
            });
            if name != OsStr::new(".") && name != OsStr::new("..") {
                entries.push((name, info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0));
            }
            if info.NextEntryOffset == 0 {
                break;
            }
            let next = info.NextEntryOffset as usize;
            if next < header
                || offset
                    .checked_add(next)
                    .is_none_or(|value| value >= returned)
            {
                return Err("the pinned Windows directory returned an invalid entry offset".into());
            }
            offset += next;
        }
    }
    Ok(entries)
}

fn mark_delete(file: &File, path: &Path) -> Result<(), String> {
    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    let info_size = std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32;
    // SAFETY: `file` is live and `info` is a correctly typed immutable buffer
    // whose exact size is supplied to Win32.
    let ok = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            std::ptr::addr_of!(info).cast(),
            info_size,
        )
    };
    if ok != 0 {
        Ok(())
    } else {
        Err(format!(
            "delete protected Windows path {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(target_os = "windows")]
pub fn collect_tree_no_reparse(
    root: &Path,
    max_entries: usize,
) -> Result<Vec<(PathBuf, bool)>, String> {
    let root = pin_path_with_access(root, ExpectedKind::Directory, DIRECTORY_ACL_ACCESS)?;
    let root_entries = directory_entries(&root.handle)?;
    if max_entries < root_entries.len() {
        return Err(format!(
            "runbook package contains more than {max_entries} entries"
        ));
    }

    struct Frame {
        relative: PathBuf,
        directory: File,
        entries: std::vec::IntoIter<(OsString, bool)>,
    }

    let mut stack = vec![Frame {
        relative: PathBuf::new(),
        directory: root.handle,
        entries: root_entries.into_iter(),
    }];
    let mut entries = Vec::new();

    while let Some(frame) = stack.last_mut() {
        let Some((name, is_directory_hint)) = frame.entries.next() else {
            stack.pop();
            continue;
        };
        if entries.len() >= max_entries {
            return Err(format!(
                "runbook package contains more than {max_entries} entries"
            ));
        }
        let relative = frame.relative.join(&name);
        let path = root.path.join(&relative);
        let kind = if is_directory_hint {
            ExpectedKind::Directory
        } else {
            ExpectedKind::File
        };
        let access = if is_directory_hint {
            DIRECTORY_ACL_ACCESS
        } else {
            ACL_ACCESS | GENERIC_READ
        };
        let (child, is_directory) = open_existing_verified_child(
            &frame.directory,
            &name,
            kind,
            access,
            root.identity.volume,
            &path,
            "collect managed Windows directory child",
        )?;
        entries.push((relative.clone(), is_directory));
        if is_directory {
            let child_entries = directory_entries(&child)?;
            if entries.len() + child_entries.len() > max_entries {
                return Err(format!(
                    "runbook package contains more than {max_entries} entries"
                ));
            }
            stack.push(Frame {
                relative,
                directory: child,
                entries: child_entries.into_iter(),
            });
        }
    }
    entries.sort_by(|(left, _), (right, _)| {
        left.components()
            .count()
            .cmp(&right.components().count())
            .then_with(|| left.cmp(right))
    });
    Ok(entries)
}

pub fn remove_file_no_reparse(path: &Path) -> Result<bool, String> {
    let (parent_path, leaf) = protected_parent_and_leaf(path)?;
    let parent = pin_path_with_access(&parent_path, ExpectedKind::Directory, CREATE_PARENT_ACCESS)?;
    let path = parent.path.join(leaf.clone());
    let child = match nt_open_child(
        &parent.handle,
        &leaf,
        ExpectedKind::File,
        DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_OPEN,
        false,
        std::ptr::null(),
    ) {
        Ok(child) => child,
        Err(NtOpenError(status))
            if status == STATUS_OBJECT_NAME_NOT_FOUND || status == STATUS_NO_SUCH_FILE =>
        {
            return Ok(false);
        }
        Err(error) => {
            return Err(nt_error("remove managed Windows file", &path, error));
        }
    };
    inspect_pinned_handle(&child, ExpectedKind::File, parent.identity.volume, &path)?;
    mark_delete(&child, &path)?;
    parent.handle.sync_all().map_err(|error| {
        format!(
            "sync managed Windows parent {}: {error}",
            parent.path.display()
        )
    })?;
    Ok(true)
}

pub fn remove_empty_directory_no_reparse(path: &Path) -> Result<Option<bool>, String> {
    let (parent_path, leaf) = protected_parent_and_leaf(path)?;
    let parent = pin_path_with_access(&parent_path, ExpectedKind::Directory, CREATE_PARENT_ACCESS)?;
    let path = parent.path.join(leaf.clone());
    let directory = match nt_open_child(
        &parent.handle,
        &leaf,
        ExpectedKind::Directory,
        DIRECTORY_ACL_ACCESS | DELETE,
        FILE_OPEN,
        false,
        std::ptr::null(),
    ) {
        Ok(directory) => directory,
        Err(NtOpenError(status))
            if status == STATUS_OBJECT_NAME_NOT_FOUND || status == STATUS_NO_SUCH_FILE =>
        {
            return Ok(None);
        }
        Err(error) => return Err(nt_error("open managed Windows directory", &path, error)),
    };
    inspect_pinned_handle(
        &directory,
        ExpectedKind::Directory,
        parent.identity.volume,
        &path,
    )?;
    if !directory_entries(&directory)?.is_empty() {
        return Ok(Some(false));
    }
    mark_delete(&directory, &path)?;
    parent.handle.sync_all().map_err(|error| {
        format!(
            "sync managed Windows parent {}: {error}",
            parent.path.display()
        )
    })?;
    Ok(Some(true))
}

fn harden_tree_without_reparse(
    root: File,
    root_path: &Path,
    volume: u32,
    acls: &TrustedAcls,
) -> Result<(), String> {
    struct Frame {
        path: PathBuf,
        directory: File,
        entries: std::vec::IntoIter<(OsString, bool)>,
    }

    acls.apply(&root, true)?;
    let root_entries = directory_entries(&root)?;
    let mut stack = vec![Frame {
        path: root_path.to_path_buf(),
        directory: root,
        entries: root_entries.into_iter(),
    }];

    while let Some(frame) = stack.last_mut() {
        let Some((name, directory_hint)) = frame.entries.next() else {
            stack.pop();
            continue;
        };
        let child_path = frame.path.join(&name);
        let kind = if directory_hint {
            ExpectedKind::Directory
        } else {
            ExpectedKind::File
        };
        let access = if directory_hint {
            DIRECTORY_ACL_ACCESS
        } else {
            ACL_ACCESS
        };
        let (child, is_directory) = open_existing_verified_child(
            &frame.directory,
            &name,
            kind,
            access,
            volume,
            &child_path,
            "open Windows ACL migration child",
        )?;
        acls.apply(&child, is_directory)?;
        if is_directory {
            let entries = directory_entries(&child)?;
            stack.push(Frame {
                path: child_path,
                directory: child,
                entries: entries.into_iter(),
            });
        }
    }
    Ok(())
}

fn try_open_marker(parent: &File, volume: u32, path: &Path) -> Result<Option<File>, String> {
    match nt_open_child(
        parent,
        OsStr::new(ACL_MIGRATION_MARKER),
        ExpectedKind::File,
        ACL_ACCESS | GENERIC_READ,
        FILE_OPEN,
        false,
        std::ptr::null(),
    ) {
        Ok(marker) => {
            inspect_pinned_handle(&marker, ExpectedKind::File, volume, path)?;
            Ok(Some(marker))
        }
        Err(NtOpenError(status))
            if status == STATUS_OBJECT_NAME_NOT_FOUND || status == STATUS_NO_SUCH_FILE =>
        {
            Ok(None)
        }
        Err(error) => Err(nt_error("open Windows ACL migration marker", path, error)),
    }
}

pub fn initialize_app_data_security(app_data_dir: &Path) -> Result<(), String> {
    let (_, _, names) = protected_components(app_data_dir)?;
    if names.is_empty() {
        return Err("refusing to migrate the ACL of a Windows volume root".into());
    }
    let pinned = pin_path_with_access(
        app_data_dir,
        ExpectedKind::Directory,
        DIRECTORY_ACL_ACCESS | GENERIC_WRITE,
    )?;
    let marker_path = pinned.path.join(ACL_MIGRATION_MARKER);
    let acls = TrustedAcls::new()?;

    // Restrict the root before looking at the marker. A marker is trusted only
    // when it is a plain file owned by this user; another account cannot forge
    // that ownership merely because an older app-data ACL was permissive.
    acls.apply(&pinned.handle, true)?;
    if let Some(marker) = try_open_marker(&pinned.handle, pinned.identity.volume, &marker_path)? {
        if acls.current_user_owns(&marker)? {
            acls.apply(&marker, false)?;
            return Ok(());
        }
    }

    // Every entry is enumerated from, and opened relative to, an already-pinned
    // directory handle. Reparse points are opened as the reparse object and
    // rejected, so this migration can never walk into their targets.
    harden_tree_without_reparse(pinned.handle, &pinned.path, pinned.identity.volume, &acls)?;

    // A forged marker owned by another account is deliberately not trusted.
    // The tree is secure now, but migration will repeat until that stale file
    // is removed; this is safer than deleting a name we did not create.
    let parent = pin_path_with_access(app_data_dir, ExpectedKind::Directory, CREATE_PARENT_ACCESS)?;
    match create_child_relative(
        &parent.handle,
        OsStr::new(ACL_MIGRATION_MARKER),
        false,
        &acls,
    ) {
        Ok(mut marker) => {
            acls.apply(&marker, false)?;
            marker
                .write_all(b"v2\n")
                .and_then(|_| marker.sync_all())
                .map_err(|error| format!("persist Windows ACL migration marker: {error}"))?;
        }
        Err(error) => {
            let marker = try_open_marker(&parent.handle, parent.identity.volume, &marker_path)?
                .ok_or(error)?;
            if acls.current_user_owns(&marker)? {
                acls.apply(&marker, false)?;
            }
        }
    }
    parent
        .handle
        .sync_all()
        .map_err(|error| format!("sync protected Windows app-data directory: {error}"))
}

pub fn sync_directory(path: &Path) -> Result<(), String> {
    let directory = pin_path_with_access(
        path,
        ExpectedKind::Directory,
        GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE,
    )?;
    directory.handle.sync_all().map_err(|error| {
        format!(
            "sync protected Windows directory {}: {error}",
            directory.path.display()
        )
    })
}

fn protected_parent_and_leaf(path: &Path) -> Result<(PathBuf, OsString), String> {
    let (lexical, _, names) = protected_components(path)?;
    if names.is_empty() {
        return Err("a protected Windows file path cannot be a volume root".into());
    }
    let leaf = lexical
        .file_name()
        .ok_or("protected Windows file path has no filename")?
        .to_os_string();
    checked_leaf(&leaf)?;
    let parent = lexical
        .parent()
        .ok_or("protected Windows file path has no parent")?
        .to_path_buf();
    Ok((parent, leaf))
}

fn rename_relative(
    source: &Path,
    destination: &Path,
    replace: bool,
    expected_kind: ExpectedKind,
) -> Result<(), String> {
    let (source_parent_path, source_name) = protected_parent_and_leaf(source)?;
    let (destination_parent_path, destination_name) = protected_parent_and_leaf(destination)?;
    let source_parent = pin_path_with_access(
        &source_parent_path,
        ExpectedKind::Directory,
        CREATE_PARENT_ACCESS,
    )?;
    let destination_parent = pin_path_with_access(
        &destination_parent_path,
        ExpectedKind::Directory,
        CREATE_PARENT_ACCESS,
    )?;
    if source_parent.identity.volume != destination_parent.identity.volume {
        return Err("managed Windows files cannot be renamed across volumes".into());
    }
    let source_file = nt_open_child(
        &source_parent.handle,
        &source_name,
        expected_kind,
        DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_OPEN,
        false,
        std::ptr::null(),
    )
    .map_err(|error| nt_error("open managed Windows rename source", source, error))?;
    inspect_pinned_handle(
        &source_file,
        expected_kind,
        source_parent.identity.volume,
        source,
    )?;

    let name: Vec<u16> = destination_name.encode_wide().collect();
    let name_bytes = name
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .and_then(|bytes| u32::try_from(bytes).ok())
        .ok_or("managed Windows destination filename is too long")?;
    let header = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
    let buffer_bytes = header
        .checked_add(name_bytes as usize)
        .ok_or("managed Windows rename buffer is too large")?;
    let mut buffer = vec![0usize; buffer_bytes.div_ceil(std::mem::size_of::<usize>())];
    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: the aligned allocation includes the fixed header plus exactly
    // `name_bytes`; every written field and copied UTF-16 unit is in bounds.
    unsafe {
        (*info).Anonymous.ReplaceIfExists = replace;
        (*info).RootDirectory = destination_parent.handle.as_raw_handle();
        (*info).FileNameLength = name_bytes;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
            name.len(),
        );
    }
    // SAFETY: `source_file` and destination root remain live and `info` points
    // to a fully initialized rename buffer of `buffer_bytes` bytes.
    let ok = unsafe {
        SetFileInformationByHandle(
            source_file.as_raw_handle(),
            FileRenameInfo,
            info.cast(),
            buffer_bytes as u32,
        )
    };
    if ok == 0 {
        return Err(format!(
            "atomically rename the managed Windows file: {}",
            std::io::Error::last_os_error()
        ));
    }
    source_parent
        .handle
        .sync_all()
        .map_err(|error| format!("sync managed Windows source directory: {error}"))?;
    if source_parent.identity != destination_parent.identity {
        destination_parent
            .handle
            .sync_all()
            .map_err(|error| format!("sync managed Windows destination directory: {error}"))?;
    }
    Ok(())
}

pub fn promote_new_file(source: &Path, destination: &Path) -> Result<(), String> {
    rename_relative(source, destination, false, ExpectedKind::File)
}

pub fn promote_new_directory(source: &Path, destination: &Path) -> Result<(), String> {
    rename_relative(source, destination, false, ExpectedKind::Directory)
}

pub fn broadcast_environment_change() {
    let environment: Vec<u16> = "Environment".encode_utf16().chain(Some(0)).collect();
    let mut result = 0usize;
    // SAFETY: `environment` is NUL-terminated and remains live for the
    // synchronous timeout call; `result` is a writable output.
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            environment.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            5_000,
            &mut result,
        );
    }
}

pub fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    rename_relative(source, destination, true, ExpectedKind::File)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use windows_sys::Win32::Security::{
        GetAce, GetSecurityDescriptorControl, ACCESS_ALLOWED_ACE, ACL,
    };

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "vterminal-windows-fs-{label}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    fn create_junction(link: &Path, target: &Path) {
        let status = std::process::Command::new("cmd.exe")
            .arg("/D")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .status()
            .expect("start junction creation");
        assert!(status.success(), "create test junction");
    }

    fn assert_exact_trusted_acl(file: &File, directory: bool) {
        let current_user = OwnedSid::current_user().expect("read current user SID");
        let local_system = OwnedSid::local_system().expect("create LocalSystem SID");
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut descriptor = std::ptr::null_mut();
        let status = unsafe {
            GetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, ERROR_SUCCESS, "read protected DACL");
        assert!(!descriptor.is_null(), "security descriptor is present");
        assert!(!dacl.is_null(), "DACL is present rather than null");

        let mut control = 0u16;
        let mut revision = 0u32;
        assert_ne!(
            unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) },
            0,
            "read security descriptor control"
        );
        assert_ne!(control & SE_DACL_PROTECTED, 0, "DACL blocks inheritance");
        assert_eq!(unsafe { (*dacl).AceCount }, 2, "only two trusted ACEs");

        let expected_flags = if directory {
            (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8
        } else {
            0
        };
        let mut saw_user = false;
        let mut saw_system = false;
        for index in 0..2 {
            let mut raw_ace = std::ptr::null_mut();
            assert_ne!(
                unsafe { GetAce(dacl, index, &mut raw_ace) },
                0,
                "read DACL ACE"
            );
            let ace = raw_ace.cast::<ACCESS_ALLOWED_ACE>();
            assert_eq!(unsafe { (*ace).Header.AceType }, 0, "ACE allows access");
            assert_eq!(unsafe { (*ace).Header.AceFlags }, expected_flags);
            assert_eq!(unsafe { (*ace).Mask }, FILE_ALL_ACCESS);
            let sid = unsafe { std::ptr::addr_of_mut!((*ace).SidStart).cast() };
            if unsafe { EqualSid(sid, current_user.as_ptr()) } != 0 {
                saw_user = true;
            } else if unsafe { EqualSid(sid, local_system.as_ptr()) } != 0 {
                saw_system = true;
            } else {
                panic!("DACL contains an untrusted SID");
            }
        }
        assert!(saw_user, "DACL grants the current user");
        assert!(saw_system, "DACL grants LocalSystem");
        unsafe {
            LocalFree(descriptor.cast());
        }
    }

    #[test]
    fn rejects_unc_drive_relative_and_nested_leaf_names() {
        assert!(rejects_prefix(Path::new(r"\\server\share\report")));
        assert!(absolute_lexical(Path::new(r"C:report")).is_err());
        assert!(checked_leaf(OsStr::new("report.json")).is_ok());
        assert!(checked_leaf(OsStr::new(r"evidence\report.log")).is_err());
        assert!(checked_leaf(OsStr::new("report.json:stream")).is_err());
        assert!(checked_leaf(OsStr::new("trailing.")).is_err());
        assert!(checked_leaf(OsStr::new("..")).is_err());
    }

    #[test]
    fn creates_protected_directory_and_file_on_local_temp_volume() {
        let root = test_root("create");
        std::fs::create_dir(&root).expect("create test root");
        let bundle =
            create_secure_directory(&root, OsStr::new("bundle")).expect("create secure bundle");
        let (path, expected, mut file) =
            create_secure_file(&bundle, OsStr::new("report.json")).expect("create secure file");
        file.write_all(b"{}\n").expect("write secure file");
        file.sync_all().expect("sync secure file");
        verify_identity(&path, expected, false).expect("identity remains pinned");
        drop(file);

        let mut bytes = Vec::new();
        let directory = open_no_reparse(&bundle, true).expect("open secure bundle");
        open_child_no_reparse(&directory, OsStr::new("report.json"), false)
            .expect("reopen secure file relative to pinned directory")
            .read_to_end(&mut bytes)
            .expect("read secure file");
        assert_eq!(bytes, b"{}\n");

        let final_path = bundle.join("final.json");
        promote_new_file(&path, &final_path).expect("promote by pinned handles");
        verify_identity(&final_path, expected, false).expect("rename preserves file identity");
        assert!(!path.exists());
        let (replacement, replacement_identity, mut replacement_file) =
            create_secure_file(&bundle, OsStr::new("replacement.json"))
                .expect("create replacement file");
        replacement_file
            .write_all(b"replacement\n")
            .expect("write replacement file");
        replacement_file.sync_all().expect("sync replacement file");
        drop(replacement_file);
        replace_file(&replacement, &final_path).expect("replace by pinned handles");
        verify_identity(&final_path, replacement_identity, false)
            .expect("replacement identity is installed");
        assert_eq!(
            std::fs::read(&final_path).expect("read replacement"),
            b"replacement\n"
        );
        std::fs::remove_dir_all(&root).expect("remove test root");
    }

    #[test]
    fn relative_creation_installs_the_protected_dacl_atomically() {
        let root = test_root("creation-dacl");
        std::fs::create_dir(&root).expect("create test root");
        let parent = pin_path_with_access(&root, ExpectedKind::Directory, CREATE_PARENT_ACCESS)
            .expect("pin test parent");
        let acls = TrustedAcls::new().expect("build trusted ACLs");
        let file = create_child_relative(&parent.handle, OsStr::new("created.txt"), false, &acls)
            .expect("create file with OBJECT_ATTRIBUTES security descriptor");
        assert_exact_trusted_acl(&file, false);
        drop(file);
        std::fs::remove_dir_all(&root).expect("remove test root");
    }

    #[test]
    fn component_walk_rejects_an_intermediate_junction() {
        let root = test_root("component-junction");
        let outside = test_root("component-outside");
        std::fs::create_dir(&root).expect("create protected test root");
        std::fs::create_dir(&outside).expect("create outside test root");
        std::fs::write(outside.join("report.json"), b"outside").expect("write outside file");
        let junction = root.join("redirect");
        create_junction(&junction, &outside);

        let error = open_no_reparse(&junction.join("report.json"), false)
            .expect_err("intermediate junction must be rejected");
        assert!(error.contains("reparse point"), "unexpected error: {error}");

        std::fs::remove_dir(&junction).expect("remove test junction");
        std::fs::remove_dir_all(&root).expect("remove protected test root");
        std::fs::remove_dir_all(&outside).expect("remove outside test root");
    }

    #[test]
    fn recursive_acl_migration_stops_at_a_junction() {
        let root = test_root("migration-junction");
        let outside = test_root("migration-outside");
        std::fs::create_dir(&root).expect("create migration root");
        std::fs::create_dir(&outside).expect("create outside migration root");
        std::fs::write(root.join("settings.json"), b"{}").expect("write migration file");
        std::fs::write(outside.join("untouched.txt"), b"outside").expect("write outside file");
        let junction = root.join("redirect");
        create_junction(&junction, &outside);

        let error = initialize_app_data_security(&root)
            .expect_err("migration must reject a reparse point rather than follow it");
        assert!(error.contains("reparse point"), "unexpected error: {error}");
        assert!(!root.join(ACL_MIGRATION_MARKER).exists());
        assert_eq!(
            std::fs::read(outside.join("untouched.txt")).expect("read outside file"),
            b"outside"
        );

        std::fs::remove_dir(&junction).expect("remove migration test junction");
        std::fs::remove_dir_all(&root).expect("remove migration root");
        std::fs::remove_dir_all(&outside).expect("remove outside migration root");
    }

    #[test]
    fn completed_acl_migration_writes_v2_marker() {
        let root = test_root("migration-marker");
        std::fs::create_dir(&root).expect("create migration root");
        std::fs::create_dir(root.join("nested")).expect("create nested directory");
        std::fs::write(root.join("nested").join("settings.json"), b"{}")
            .expect("write nested file");

        initialize_app_data_security(&root).expect("harden app data");
        assert_eq!(
            std::fs::read(root.join(ACL_MIGRATION_MARKER)).expect("read migration marker"),
            b"v2\n"
        );
        let marker = open_no_reparse(&root.join(ACL_MIGRATION_MARKER), false)
            .expect("open migration marker");
        assert_exact_trusted_acl(&marker, false);
        initialize_app_data_security(&root).expect("reuse trusted migration marker");

        std::fs::remove_dir_all(&root).expect("remove migration root");
    }
}
