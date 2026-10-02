//! A named pipe only this person's own programs can open: the link between Steps for Chrome and
//! Edge (through the program the browser starts) and the running app
//! (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together).
//!
//! - The app's end ([`private_server`]) grants access to this person's account alone, refuses
//!   clients on other computers, and can insist on being the pipe's first instance, so a pipe of
//!   the same name made earlier by someone else stops the link rather than sharing it.
//! - The browser's end checks the program at the other end runs as the same person
//!   ([`server_is_same_user`]) before sending anything, and opens it for identification only
//!   (tokio's default), so that program can't act as the person.
use std::ffi::c_void;
use std::io;
use std::os::windows::io::{AsRawHandle, BorrowedHandle};

use tokio::net::windows::named_pipe::{NamedPipeServer, PipeMode, ServerOptions};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{
    EqualSid, GetTokenInformation, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY,
    TOKEN_USER, TokenUser,
};
use windows::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId};
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::core::{PCWSTR, PWSTR};

/// At most this many ends connected at once: Chrome, Edge and a spare.
const MAX_INSTANCES: usize = 4;

/// A handle closed when dropped.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: the handle was opened by this module and is closed exactly once, here.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// Memory Windows allocated with `LocalAlloc`, freed when dropped.
struct Local(*mut c_void);

impl Drop for Local {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the pointer came from a Win32 call that allocates with `LocalAlloc`, and is
            // freed exactly once, here.
            let _ = unsafe { LocalFree(Some(HLOCAL(self.0))) };
        }
    }
}

/// A process's `TOKEN_USER`, in a buffer aligned for it (its SID points inside the buffer).
struct TokenUserBuffer(Vec<u64>);

impl TokenUserBuffer {
    /// The user of the process `process` (open with at least limited-query rights).
    fn of(process: HANDLE) -> Option<Self> {
        let mut token = HANDLE::default();
        // SAFETY: `process` is valid for the call; the token handle goes to a local and is owned
        // (and closed) by `Owned` below. TOKEN_QUERY only reads.
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &raw mut token) }.ok()?;
        let token = Owned(token);
        let mut needed = 0u32;
        // SAFETY: no buffer: this asks only for the size, written to a local. It "fails" with
        // ERROR_INSUFFICIENT_BUFFER by design.
        let _ = unsafe { GetTokenInformation(token.0, TokenUser, None, 0, &raw mut needed) };
        let bytes = usize::try_from(needed).ok()?;
        if bytes < std::mem::size_of::<TOKEN_USER>() || bytes > 4096 {
            return None;
        }
        let mut buffer = vec![0u64; bytes.div_ceil(8)];
        // SAFETY: `buffer` is owned here, 8-byte aligned (enough for TOKEN_USER) and at least
        // `needed` bytes long.
        unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                Some(buffer.as_mut_ptr().cast::<c_void>()),
                needed,
                &raw mut needed,
            )
        }
        .ok()?;
        Some(Self(buffer))
    }

    fn sid(&self) -> PSID {
        // SAFETY: `of` filled the buffer with a TOKEN_USER (checked to be large enough); its
        // SID points inside the same buffer, which lives as long as `self`.
        unsafe { (*self.0.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }
}

/// This process's user.
fn own_user() -> Option<TokenUserBuffer> {
    // SAFETY: the pseudo-handle for the current process needs no closing.
    TokenUserBuffer::of(unsafe { GetCurrentProcess() })
}

/// This person's account as a SID string (`S-1-5-21-…`): part of the pipe's name, and the only
/// account its security descriptor lets in.
#[must_use]
pub fn user_sid() -> Option<String> {
    let user = own_user()?;
    let mut text = PWSTR::null();
    // SAFETY: the SID is valid while `user` lives; the string Windows allocates is freed by
    // `Local` below.
    unsafe { ConvertSidToStringSidW(user.sid(), &raw mut text) }.ok()?;
    let _free = Local(text.0.cast::<c_void>());
    // SAFETY: on success `text` is a NUL-terminated string Windows allocated.
    unsafe { text.to_string() }.ok()
}

/// The Windows session this process runs in: each signed-in session has its own link.
#[must_use]
pub fn session_id() -> Option<u32> {
    let mut session = 0u32;
    // SAFETY: the current process's id, and an out-pointer to a local.
    unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &raw mut session) }.ok()?;
    Some(session)
}

/// Whether process `pid` runs as this person. False whenever it can't be told.
fn runs_as_this_user(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let Some(own) = own_user() else {
        return false;
    };
    // SAFETY: requests only limited-query rights; the handle is owned (and closed) below.
    let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
    else {
        return false;
    };
    let process = Owned(process);
    let Some(theirs) = TokenUserBuffer::of(process.0) else {
        return false;
    };
    // SAFETY: both SIDs are valid while their buffers live, which is past this call.
    unsafe { EqualSid(own.sid(), theirs.sid()) }.is_ok()
}

/// Whether the program at the other end of a pipe this process opened runs as the same person.
#[must_use]
pub fn server_is_same_user(pipe: BorrowedHandle<'_>) -> bool {
    let mut pid = 0u32;
    // SAFETY: `pipe` is an open pipe handle for the length of the borrow; out-pointer to a local.
    let known = unsafe { GetNamedPipeServerProcessId(HANDLE(pipe.as_raw_handle()), &raw mut pid) };
    known.is_ok() && runs_as_this_user(pid)
}

/// Whether the program that opened this process's pipe runs as the same person. The pipe's
/// security descriptor already lets no one else in; checked again all the same.
#[must_use]
pub fn client_is_same_user(pipe: BorrowedHandle<'_>) -> bool {
    let mut pid = 0u32;
    // SAFETY: `pipe` is an open pipe handle for the length of the borrow; out-pointer to a local.
    let known = unsafe { GetNamedPipeClientProcessId(HANDLE(pipe.as_raw_handle()), &raw mut pid) };
    known.is_ok() && runs_as_this_user(pid)
}

/// Creates an instance of the pipe `name` that only this person's account can open, refusing
/// clients on other computers. `first`: fail if the pipe already exists (someone else made it).
/// Must be called inside a Tokio runtime with I/O enabled.
///
/// # Errors
/// When the account can't be read, or Windows refuses the pipe (for `first`, when it exists).
pub fn private_server(name: &str, first: bool) -> io::Result<NamedPipeServer> {
    let sid = user_sid().ok_or_else(|| io::Error::other("this account's SID couldn't be read"))?;
    // A protected DACL (no inherited entries) with one entry: full access for this account.
    let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid})")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    // SAFETY: `sddl` is NUL-terminated and outlives the call; the descriptor Windows allocates
    // is freed by `Local` below, after the pipe is made.
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl.as_ptr()),
            SDDL_REVISION_1,
            &raw mut descriptor,
            None,
        )
    }
    .map_err(io::Error::other)?;
    let _free = Local(descriptor.0);
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(std::mem::size_of::<SECURITY_ATTRIBUTES>()).unwrap_or(24),
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: false.into(),
    };
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(first)
        .reject_remote_clients(true)
        .max_instances(MAX_INSTANCES)
        .pipe_mode(PipeMode::Byte);
    // SAFETY: `attributes` is a valid SECURITY_ATTRIBUTES whose descriptor lives until `_free`
    // drops at the end of this function, after the pipe is created (Windows copies it).
    unsafe { options.create_with_security_attributes_raw(name, (&raw mut attributes).cast()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_account_and_session_are_known() {
        let sid = user_sid().unwrap();
        assert!(sid.starts_with("S-1-"), "{sid}");
        assert!(session_id().is_some());
        // SAFETY: test only: our own process id.
        assert!(runs_as_this_user(unsafe { GetCurrentProcessId() }));
        assert!(!runs_as_this_user(0));
        // The System process (4) doesn't run as this person.
        assert!(!runs_as_this_user(4));
    }

    #[test]
    fn the_private_pipe_carries_both_ways_at_once_and_refuses_a_second_first_instance() {
        use std::os::windows::io::AsHandle;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::windows::named_pipe::ClientOptions;

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()
            .unwrap();
        runtime.block_on(async {
            let name = format!(r"\\.\pipe\amluto-steps-pipe-test-{}", std::process::id());
            let server = private_server(&name, true).unwrap();
            // Someone else's pipe of the same name would be refused in the same way.
            assert!(private_server(&name, true).is_err());
            let mut client = ClientOptions::new().open(&name).unwrap();
            server.connect().await.unwrap();
            assert!(server_is_same_user(client.as_handle()));
            assert!(client_is_same_user(server.as_handle()));

            // A read waiting on one side doesn't hold up a write on the same handle.
            let (mut server_read, mut server_write) = tokio::io::split(server);
            let waiting = tokio::spawn(async move {
                let mut bytes = [0u8; 5];
                server_read.read_exact(&mut bytes).await.map(|_| bytes)
            });
            server_write.write_all(b"from app").await.unwrap();
            let mut heard = [0u8; 8];
            client.read_exact(&mut heard).await.unwrap();
            assert_eq!(&heard, b"from app");
            client.write_all(b"hello").await.unwrap();
            assert_eq!(&waiting.await.unwrap().unwrap(), b"hello");
        });
    }
}
