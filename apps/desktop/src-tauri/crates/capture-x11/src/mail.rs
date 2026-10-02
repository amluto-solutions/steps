//! A new email with a file attached, through `xdg-email` (xdg-utils), which hands it to the
//! desktop's mail app (Thunderbird and Evolution take the attachment). Without it, the caller
//! falls back to a `mailto:` link and shows the file, as on Windows.

use std::path::Path;
use std::process::{Command, Stdio};

/// What became of the email.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailOutcome {
    /// The mail app was asked to show it.
    Opened,
    /// Not used on Linux: `xdg-email` doesn't say whether it was sent.
    Cancelled,
    /// No `xdg-email`, or it failed: use a `mailto:` link instead.
    Unavailable,
}

/// Asks the mail app for a new email to `address` with `file` attached, for the person to check
/// and send.
#[must_use]
pub fn compose_with_attachment(
    address: &str,
    subject: &str,
    body: &str,
    file: &Path,
) -> MailOutcome {
    let status = Command::new("xdg-email")
        .arg("--subject")
        .arg(subject)
        .arg("--body")
        .arg(body)
        .arg("--attach")
        .arg(file)
        .arg(address)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match status {
        Ok(status) if status.success() => MailOutcome::Opened,
        _ => MailOutcome::Unavailable,
    }
}
