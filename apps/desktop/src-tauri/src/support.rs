//! "Get help": a support bundle the user sees before anything leaves the PC
//! (docs/spec/07-settings-and-policy.md, "Support bundle").
//!
//! The zip holds the logs, the app and Windows versions and the settings, with library names and
//! paths, the user's name and their profile folder replaced by placeholders. It is saved in app
//! data; the user looks at it, then writes the email and attaches it themselves. Nothing is sent.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use zip::write::SimpleFileOptions;

use crate::recorder::CommandError;

/// Settings from the window, as JSON. Anything bigger isn't settings.
const MAX_SETTINGS_BYTES: usize = 64 * 1024;
/// Older bundles are removed when a new one is made.
const BUNDLES_KEPT: usize = 3;
/// Amluto support: the address the privacy policy gives too (site/index.html).
const SUPPORT_ADDRESS: &str = "steps@amluto.com";
const SUBJECT: &str = "Steps: help needed";
const BODY: &str = "Please describe what happened and what you expected.\r\n\r\n\
The support file is in the folder Steps just opened. Please attach it to this email.";
/// The body when the mail app took the file as an attachment.
const BODY_ATTACHED: &str = "Please describe what happened and what you expected.\r\n\r\n\
The support file is attached.";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryName {
    name: String,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportBundle {
    path: PathBuf,
    /// The files inside the zip, as the user sees them before sending.
    files: Vec<String>,
}

/// Replaces private text with placeholders, longest first, ignoring case.
#[derive(Debug, Default)]
pub struct Redactor {
    rules: Vec<(String, String)>,
}

impl Redactor {
    #[must_use]
    pub fn new(libraries: &[LibraryName], display_name: &str, profile: Option<&str>) -> Self {
        let mut rules: Vec<(String, String)> = Vec::new();
        for (index, library) in libraries.iter().enumerate() {
            let number = index + 1;
            let path = library.path.trim_end_matches(['\\', '/']);
            rules.push((path.to_owned(), format!("<library {number} folder>")));
            rules.push((
                path.replace('\\', "/"),
                format!("<library {number} folder>"),
            ));
            rules.push((library.name.clone(), format!("<library {number}>")));
        }
        if let Some(profile) = profile {
            rules.push((
                profile.trim_end_matches('\\').to_owned(),
                "%USERPROFILE%".to_owned(),
            ));
        }
        rules.push((display_name.to_owned(), "<your name>".to_owned()));
        // Very short needles would blank out ordinary words.
        rules.retain(|(needle, _)| needle.trim().chars().count() >= 3);
        rules.sort_by_key(|(needle, _)| std::cmp::Reverse(needle.len()));
        Self { rules }
    }

    #[must_use]
    pub fn apply(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for (needle, replacement) in &self.rules {
            out = replace_ignoring_case(&out, needle, replacement);
        }
        out
    }
}

fn replace_ignoring_case(text: &str, needle: &str, replacement: &str) -> String {
    let lower_text = text.to_lowercase();
    let lower_needle = needle.to_lowercase();
    // Lower-casing can change byte lengths outside ASCII; then only exact matches are replaced.
    if lower_text.len() != text.len() || lower_needle.len() != needle.len() {
        return text.replace(needle, replacement);
    }
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (start, _) in lower_text.match_indices(&lower_needle) {
        if start < last {
            continue;
        }
        out.push_str(&text[last..start]);
        out.push_str(replacement);
        last = start + needle.len();
    }
    out.push_str(&text[last..]);
    out
}

#[cfg(windows)]
fn windows_version() -> serde_json::Value {
    use winreg::RegKey;
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};

    let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", KEY_READ)
    else {
        return serde_json::Value::Null;
    };
    let build: String = key.get_value("CurrentBuild").unwrap_or_default();
    let update: u32 = key.get_value("UBR").unwrap_or_default();
    // ProductName still says "Windows 10" on Windows 11; the build number tells them apart.
    let windows = if build.parse::<u32>().is_ok_and(|build| build >= 22_000) {
        "Windows 11"
    } else {
        "Windows 10 or older"
    };
    serde_json::json!({
        "windows": windows,
        "edition": key.get_value::<String, _>("EditionID").unwrap_or_default(),
        "version": key.get_value::<String, _>("DisplayVersion").unwrap_or_default(),
        "build": format!("{build}.{update}"),
    })
}

/// Linux: the distribution (`/etc/os-release`), and the session and desktop, which decide what
/// can be recorded.
#[cfg(not(windows))]
fn windows_version() -> serde_json::Value {
    let release = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
    let pretty = release
        .lines()
        .find_map(|line| line.strip_prefix("PRETTY_NAME="))
        .map(|name| name.trim_matches('"').to_string())
        .unwrap_or_default();
    serde_json::json!({
        "linux": pretty,
        "session": std::env::var("XDG_SESSION_TYPE").unwrap_or_default(),
        "desktop": std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default(),
    })
}

fn support_folder(app: &AppHandle) -> Result<PathBuf, CommandError> {
    crate::app_folder::local_folder(app)
        .map(|dir| dir.join("support"))
        .map_err(|error| CommandError::new("storage", error))
}

fn storage(error: impl std::fmt::Display) -> CommandError {
    CommandError::new("storage", error.to_string())
}

/// Keeps the newest bundles and removes the rest; failures are ignored.
fn prune_bundles(folder: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    let mut bundles: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
        })
        .filter_map(|path| Some((fs::metadata(&path).ok()?.modified().ok()?, path)))
        .collect();
    bundles.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    for (_, path) in bundles.into_iter().skip(keep) {
        let _ = fs::remove_file(path);
    }
}

/// Builds the zip from named text parts. Kept apart from the command so it can be tested.
fn write_zip(path: &Path, parts: &[(String, String)]) -> Result<(), CommandError> {
    let file = fs::File::create(path).map_err(storage)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, text) in parts {
        zip.start_file(name.as_str(), options).map_err(storage)?;
        zip.write_all(text.as_bytes()).map_err(storage)?;
    }
    zip.finish().map_err(storage)?;
    Ok(())
}

fn log_parts(dir: &Path, redactor: &Redactor) -> Vec<(String, String)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut parts: Vec<(String, String)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("log"))
        })
        .filter_map(|path| {
            let name = path.file_name()?.to_string_lossy().into_owned();
            let bytes = fs::read(&path).ok()?;
            Some((
                format!("logs/{name}"),
                redactor.apply(&String::from_utf8_lossy(&bytes)),
            ))
        })
        .collect();
    parts.sort();
    parts
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands take owned arguments"
)]
pub fn support_create_bundle(
    app: AppHandle,
    settings: String,
    libraries: Vec<LibraryName>,
    display_name: String,
) -> Result<SupportBundle, CommandError> {
    if settings.len() > MAX_SETTINGS_BYTES {
        return Err(CommandError::new("invalid", "The settings are too large."));
    }
    let settings: serde_json::Value = serde_json::from_str(&settings)
        .map_err(|_| CommandError::new("invalid", "The settings aren't valid."))?;
    let profile = std::env::var("USERPROFILE").ok();
    let redactor = Redactor::new(&libraries, &display_name, profile.as_deref());

    let about = serde_json::json!({
        "app": app.package_info().version.to_string(),
        "system": windows_version(),
        "createdAt": chrono_free_now(),
        "policy": {
            "libraries": crate::policy::current().libraries.len(),
            "excludedApps": crate::policy::current().excluded_apps.len(),
            "locked": crate::policy::current().locked,
        },
    });
    let mut parts = vec![
        ("about.json".to_owned(), pretty(&about)),
        (
            "settings.json".to_owned(),
            redactor.apply(&pretty(&settings)),
        ),
    ];
    // The shortcuts live in Steps' own folder, not Tauri's.
    if let Some(app_data) = crate::app_folder::app_folder(&app)
        && let Ok(shortcuts) = fs::read_to_string(app_data.join("shortcuts.json"))
    {
        parts.push(("shortcuts.json".to_owned(), shortcuts));
    }
    if let Ok(logs) = crate::app_folder::log_folder(&app) {
        parts.extend(log_parts(&logs, &redactor));
    }

    let folder = support_folder(&app)?;
    fs::create_dir_all(&folder).map_err(storage)?;
    let path = folder.join(format!(
        "Steps support {}.zip",
        chrono_free_now().replace(':', "-")
    ));
    write_zip(&path, &parts)?;
    prune_bundles(&folder, BUNDLES_KEPT);
    log::info!("support bundle made with {} files", parts.len());
    Ok(SupportBundle {
        path,
        files: parts.into_iter().map(|(name, _)| name).collect(),
    })
}

fn pretty(value: &serde_json::Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

/// UTC time as `yyyy-mm-ddThh:mm:ssZ`, without a date library in this crate.
fn chrono_free_now() -> String {
    utc_time(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_secs()),
    )
}

fn utc_time(seconds: u64) -> String {
    let days = seconds / 86_400;
    let rest = seconds % 86_400;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let shifted = days + 719_468;
    let era = shifted / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

/// Shows a bundle in its folder, so the user can look inside before attaching it.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands take owned arguments"
)]
pub fn support_show_bundle(app: AppHandle, path: String) -> Result<(), CommandError> {
    let folder = support_folder(&app)?;
    let file = PathBuf::from(&path);
    // Only bundles this app made: anything else could be used to open arbitrary paths.
    if file.parent() != Some(folder.as_path()) || !file.is_file() {
        return Err(CommandError::new(
            "notFound",
            "The support file isn't there any more.",
        ));
    }
    crate::open::reveal(&file)
}

/// Opens a new email to Amluto support with the support file attached, when the mail app takes
/// attachments that way (classic Outlook, Thunderbird: Simple MAPI). Otherwise (the new Outlook,
/// web mail) it opens a `mailto:` email and shows the file in its folder to attach by hand, unless
/// the folder is already open. The subject and body are fixed here, not taken from the window,
/// and the person presses Send themselves. Returns at once: the mail app's window can stay open.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands take owned arguments"
)]
pub fn support_open_email(
    app: AppHandle,
    path: String,
    folder_shown: bool,
) -> Result<(), CommandError> {
    let folder = support_folder(&app)?;
    let file = PathBuf::from(&path);
    // Only bundles this app made: anything else could be used to send any file on the PC.
    if file.parent() != Some(folder.as_path()) || !file.is_file() {
        return Err(CommandError::new(
            "notFound",
            "The support file isn't there any more.",
        ));
    }
    std::thread::Builder::new()
        .name("amluto-support-email".into())
        .spawn(move || {
            // Simple MAPI on Windows, `xdg-email` on Linux.
            let outcome = capture::platform::mail::compose_with_attachment(
                SUPPORT_ADDRESS,
                SUBJECT,
                BODY_ATTACHED,
                &file,
            );
            log::info!("support email: {outcome:?}");
            if outcome == capture::platform::mail::MailOutcome::Unavailable {
                if !folder_shown && let Err(error) = crate::open::reveal(&file) {
                    log::warn!("support email: couldn't show the file: {error:?}");
                }
                if let Err(error) = open_mailto() {
                    log::warn!("support email: couldn't open the email: {error:?}");
                }
            }
        })
        .map(|_| ())
        .map_err(|error| CommandError::new("openFailed", error.to_string()))
}

/// A new email with the fixed subject and body, for mail apps that don't take attachments.
fn open_mailto() -> Result<(), CommandError> {
    let encode = |text: &str| -> String {
        text.bytes()
            .map(|byte| match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                    (byte as char).to_string()
                }
                _ => format!("%{byte:02X}"),
            })
            .collect()
    };
    let url = format!(
        "mailto:{SUPPORT_ADDRESS}?subject={}&body={}",
        encode(SUBJECT),
        encode(BODY)
    );
    crate::open::open_link(&url)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands take owned arguments"
)]
pub fn support_open_logs(app: AppHandle) -> Result<(), CommandError> {
    let dir = crate::app_folder::log_folder(&app)
        .map_err(|error| CommandError::new("notFound", error))?;
    fs::create_dir_all(&dir).map_err(storage)?;
    crate::open::open_path(&dir)
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;

    fn library(name: &str, path: &str) -> LibraryName {
        LibraryName {
            name: name.to_owned(),
            path: path.to_owned(),
        }
    }

    #[test]
    fn redacts_library_folders_names_the_user_and_their_profile() {
        let redactor = Redactor::new(
            &[library(
                "Payroll team",
                r"C:\Users\sam\Contoso\Payroll Guides\",
            )],
            "Sam Jones",
            Some(r"C:\Users\sam"),
        );
        let log = r"saved to c:\users\sam\contoso\payroll guides\g1 (Payroll Team) by Sam Jones; cache C:\Users\sam\AppData";
        assert_eq!(
            redactor.apply(log),
            r"saved to <library 1 folder>\g1 (<library 1>) by <your name>; cache %USERPROFILE%\AppData"
        );
        assert_eq!(
            redactor.apply("C:/Users/sam/Contoso/Payroll Guides/x"),
            "<library 1 folder>/x"
        );
    }

    #[test]
    fn short_names_are_left_alone() {
        let redactor = Redactor::new(&[library("HR", r"D:\HR")], "Al", None);
        assert_eq!(redactor.apply("HR and Al"), "HR and Al");
        assert_eq!(redactor.apply(r"in D:\HR\x"), r"in <library 1 folder>\x");
    }

    #[test]
    fn the_zip_holds_exactly_the_listed_parts_and_old_bundles_are_pruned() {
        let folder = tempfile::tempdir().expect("temp dir");
        let path = folder.path().join("bundle.zip");
        write_zip(
            &path,
            &[
                ("about.json".to_owned(), "{}".to_owned()),
                ("logs/amluto-steps.log".to_owned(), "hello".to_owned()),
            ],
        )
        .expect("zip");
        let mut zip = zip::ZipArchive::new(fs::File::open(&path).expect("open")).expect("read");
        assert_eq!(zip.len(), 2);
        let mut text = String::new();
        zip.by_name("logs/amluto-steps.log")
            .expect("log")
            .read_to_string(&mut text)
            .expect("text");
        assert_eq!(text, "hello");

        for index in 0..5 {
            fs::write(folder.path().join(format!("old {index}.zip")), b"x").expect("write");
        }
        prune_bundles(folder.path(), 3);
        let left = fs::read_dir(folder.path()).expect("list").count();
        assert_eq!(left, 3);
    }

    #[test]
    fn dates_are_utc_iso() {
        assert_eq!(utc_time(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_time(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(utc_time(1_790_398_245), "2026-09-26T04:50:45Z");
        assert_eq!(chrono_free_now().len(), 20);
    }
}
