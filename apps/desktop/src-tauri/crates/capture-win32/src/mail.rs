//! A new email in the default mail app with a file attached, through Simple MAPI: the one way
//! Windows has to hand a mail app an attachment. Classic Outlook and Thunderbird take it; the new
//! Outlook and web mail don't, and the caller falls back to a `mailto:` link.

use std::path::Path;

use windows::Win32::Foundation::FreeLibrary;
use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::System::Mapi::{
    LPMAPISENDMAILW, MAPI_DIALOG, MAPI_E_USER_ABORT, MAPI_LOGON_UI, MAPI_TO, MapiFileDescW,
    MapiMessageW, MapiRecipDescW, SUCCESS_SUCCESS,
};
use windows::core::{PWSTR, s, w};

/// What became of the email.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailOutcome {
    /// The mail app showed it, and it was sent or saved.
    Opened,
    /// The mail app showed it, and the person closed it.
    Cancelled,
    /// No mail app takes Simple MAPI (or it failed): use a `mailto:` link instead.
    Unavailable,
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Shows a new email to `address` with `file` attached, for the person to check and send. Blocks
/// until the mail app's window closes, so call it off the UI thread.
#[must_use]
pub fn compose_with_attachment(
    address: &str,
    subject: &str,
    body: &str,
    file: &Path,
) -> MailOutcome {
    // Every string the message points at lives until the call returns.
    let mut name = wide(address);
    let mut smtp = wide(&format!("SMTP:{address}"));
    let mut subject = wide(subject);
    let mut body = wide(body);
    let mut path = wide(&file.to_string_lossy());
    let mut file_name = wide(
        &file
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
    );
    let mut recipient = MapiRecipDescW {
        ulRecipClass: MAPI_TO,
        lpszName: PWSTR(name.as_mut_ptr()),
        lpszAddress: PWSTR(smtp.as_mut_ptr()),
        ..Default::default()
    };
    let mut attachment = MapiFileDescW {
        // No position in the body text: the attachment goes after it.
        nPosition: u32::MAX,
        lpszPathName: PWSTR(path.as_mut_ptr()),
        lpszFileName: PWSTR(file_name.as_mut_ptr()),
        ..Default::default()
    };
    let message = MapiMessageW {
        lpszSubject: PWSTR(subject.as_mut_ptr()),
        lpszNoteText: PWSTR(body.as_mut_ptr()),
        nRecipCount: 1,
        lpRecips: &raw mut recipient,
        nFileCount: 1,
        lpFiles: &raw mut attachment,
        ..Default::default()
    };

    // SAFETY: initialises COM for this thread (some mail apps need a single-threaded apartment);
    // it is undone below only if it succeeded here.
    let com = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
    // SAFETY: loads Windows' own MAPI stub by name from the system folder's search path.
    let outcome = match unsafe { LoadLibraryW(w!("mapi32.dll")) } {
        Ok(module) => {
            // SAFETY: looks up an exported function of the module just loaded.
            let found = unsafe { GetProcAddress(module, s!("MAPISendMailW")) };
            let result = found.map(|address| {
                // SAFETY: MAPISendMailW has exactly the LPMAPISENDMAILW signature (mapi.h).
                let send: LPMAPISENDMAILW = unsafe {
                    std::mem::transmute::<unsafe extern "system" fn() -> isize, LPMAPISENDMAILW>(
                        address,
                    )
                };
                send.map_or(u32::MAX, |send| {
                    // SAFETY: `message` and everything it points at outlive the call; no session
                    // (0) and no parent window (0), so the mail app shows its own window.
                    unsafe { send(0, 0, &raw const message, MAPI_DIALOG | MAPI_LOGON_UI, 0) }
                })
            });
            // SAFETY: frees the module loaded above, after the call has returned.
            let _ = unsafe { FreeLibrary(module) };
            match result {
                Some(SUCCESS_SUCCESS) => MailOutcome::Opened,
                Some(MAPI_E_USER_ABORT) => MailOutcome::Cancelled,
                _ => MailOutcome::Unavailable,
            }
        }
        Err(_) => MailOutcome::Unavailable,
    };
    if com {
        // SAFETY: balances the successful CoInitializeEx above, on the same thread.
        unsafe { CoUninitialize() };
    }
    outcome
}
