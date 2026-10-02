//! Updates for the downloadable `.exe` (docs/spec/10-distribution.md#updates-for-the-exe).
//!
//! A signed `release.json` at <https://steps.amluto.com/update/> says what the newest version is.
//! The updater plugin asks for it only when the app does (at most daily, and on "Check for
//! updates"). A new version is downloaded in the background, refused unless it is signed with
//! Amluto's key for exactly the version announced, and kept in the app's data. The next time the
//! app starts, before any window shows, the setup is checked again and run silently; it replaces
//! the program and opens the new version. "Restart now" does the same straight away. Never while
//! recording.
//!
//! The copy the setup `.exe` installed asks, and the portable program (the loose `.exe`) when
//! its "Update automatically" is on or Check for updates is pressed: it replaces itself where it
//! is (docs/spec/10-distribution.md#the-portable-program-updates-itself). The Store package updates
//! through the Store, IT redeploys the `.msi`, development builds don't update, and IT can switch
//! the check off (`DisableUpdateCheck`). No window may use the plugin's own commands: the ones here
//! are the only way in.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::utils::config::BundleType;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::recorder::{CommandError, RecorderService};

/// Where this copy gets its updates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Channel {
    /// Installed by the setup `.exe`: asks steps.amluto.com.
    Checks,
    /// The Microsoft Store package: the Store updates it.
    Store,
    /// The `.msi`: IT installs new versions.
    Msi,
    /// Installed by the setup `.exe`, but IT policy switched the check off.
    Policy,
    /// The portable program from a release, run without installing: it asks for its own entry
    /// in `release.json` and replaces itself where it is.
    Portable,
    /// The portable program in a folder it can't write to (copied into Program Files): it
    /// couldn't replace itself, so it doesn't ask.
    ReadOnly,
    /// A development build: never updated.
    None,
}

/// The rule on its own. The Store package comes first: it is built from the same program as the
/// setup, so it mustn't rest on the stamp alone (the release stamps it unknown as well).
fn channel_for(
    packaged: bool,
    bundle: Option<&BundleType>,
    switched_off: bool,
    release_build: bool,
) -> Channel {
    if packaged {
        return Channel::Store;
    }
    match bundle {
        // The setup's copy on Windows; the AppImage and the .deb on Linux.
        Some(BundleType::Nsis | BundleType::AppImage | BundleType::Deb) if switched_off => {
            Channel::Policy
        }
        Some(BundleType::Nsis | BundleType::AppImage | BundleType::Deb) => Channel::Checks,
        Some(BundleType::Msi) => Channel::Msi,
        // No installer stamped it: the portable program, or a development build.
        _ if release_build && switched_off => Channel::Policy,
        _ if release_build => Channel::Portable,
        _ => Channel::None,
    }
}

/// Whether this is the portable program, whatever the update policy: it keeps its data beside
/// itself even when IT has switched its update checks off.
#[must_use]
pub fn is_portable() -> bool {
    capture::platform::package_full_name().is_none()
        && tauri::utils::platform::bundle_type().is_none()
        && !cfg!(debug_assertions)
}

/// The portable program's entry in `release.json`: its own, since it is replaced by a program,
/// not installed by a setup.
const PORTABLE_TARGET: &str = "windows-x86_64-portable";

/// The updater for this copy: the portable program looks up its own entry.
fn updater(app: &AppHandle) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater> {
    if channel() == Channel::Portable {
        app.updater_builder().target(PORTABLE_TARGET).build()
    } else {
        app.updater()
    }
}

/// The copies that update themselves.
fn updates_itself(channel: Channel) -> bool {
    matches!(channel, Channel::Checks | Channel::Portable)
}

/// This copy's channel. The Tauri CLI stamps the program inside each installer with its type.
pub fn channel() -> Channel {
    match channel_for(
        capture::platform::package_full_name().is_some(),
        tauri::utils::platform::bundle_type().as_ref(),
        crate::policy::current().disable_update_check,
        !cfg!(debug_assertions),
    ) {
        // `Steps data` couldn't be made beside the program, so neither could the new program:
        // downloading it would only fail at every start.
        Channel::Portable if crate::app_folder::portable_root().is_none() => Channel::ReadOnly,
        channel => channel,
    }
}

/// The update found by the last check, kept for the download.
#[derive(Default)]
pub struct UpdateService {
    found: Mutex<Option<Update>>,
}

/// What the About screen shows about a new version. The notes come from the unsigned
/// `release.json`, so they are only ever shown as plain text.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
    /// Seconds since 1970, when the release was published.
    published: Option<i64>,
}

fn updates_on() -> Result<(), CommandError> {
    if updates_itself(channel()) {
        Ok(())
    } else {
        Err(CommandError::new(
            "updatesOff",
            "This copy of Steps doesn't check for updates.",
        ))
    }
}

fn not_recording(app: &AppHandle) -> Result<(), CommandError> {
    if app.state::<RecorderService>().is_recording_active() {
        Err(CommandError::new(
            "updateWhileRecording",
            "Stop the recording before installing the update.",
        ))
    } else {
        Ok(())
    }
}

/// Where this copy gets its updates, for the About screen.
#[tauri::command]
#[must_use]
pub fn updates_channel() -> Channel {
    channel()
}

/// Asks steps.amluto.com whether there's a newer version. `None`: this is the newest.
#[tauri::command]
pub async fn updates_check(app: AppHandle) -> Result<Option<UpdateInfo>, CommandError> {
    updates_on()?;
    let update = updater(&app)
        .map_err(|error| CommandError::new("updateCheckFailed", error.to_string()))?
        .check()
        .await
        .map_err(|error| {
            log::warn!("update check failed: {error}");
            CommandError::new("updateCheckFailed", error.to_string())
        })?;
    #[allow(
        clippy::redundant_closure_for_method_calls,
        reason = "the date type is the time crate's, which the app doesn't otherwise name"
    )]
    let info = update.as_ref().map(|update| UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
        published: update.date.map(|date| date.unix_timestamp()),
    });
    log::info!(
        "update check: {}",
        info.as_ref()
            .map_or("this is the newest version", |info| info.version.as_str())
    );
    *app.state::<UpdateService>()
        .found
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = update;
    Ok(info)
}

// ----- Downloaded in the background, installed at the next start -----

/// Where a downloaded update waits (the app's local data, never the install folder).
const PENDING_FOLDER: &str = "updates";
/// The downloaded update: the setup on Windows; the `AppImage` or `.deb` on Linux.
#[cfg(windows)]
const PENDING_SETUP: &str = "setup.exe";
#[cfg(not(windows))]
const PENDING_SETUP: &str = "update.package";
const PENDING_RECORD: &str = "pending.json";
/// Starts that may try to install the same update: a setup that keeps failing must not reopen
/// the app into another attempt forever.
const MAX_ATTEMPTS: u32 = 2;
/// The only start option passed on to the new version: starting with Windows, in the tray.
const KEPT_ARGS: [&str; 1] = ["--minimized"];

/// A downloaded setup and what it was signed as.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Pending {
    version: String,
    /// The `.sig` from `release.json`, checked again before the setup runs.
    signature: String,
    attempts: u32,
}

/// The app's local data: `%LOCALAPPDATA%\com.amluto.steps` for an installed copy, the portable
/// program's `Steps data\Local` for it.
fn pending_folder(app: &AppHandle) -> Option<PathBuf> {
    crate::app_folder::local_folder(app)
        .ok()
        .map(|dir| dir.join(PENDING_FOLDER))
}

fn read_pending(folder: &Path) -> Option<Pending> {
    serde_json::from_slice(&fs::read(folder.join(PENDING_RECORD)).ok()?).ok()
}

fn write_pending(folder: &Path, pending: &Pending) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(pending).map_err(std::io::Error::other)?;
    fs::write(folder.join(PENDING_RECORD), bytes)
}

fn forget_pending(folder: &Path) {
    if folder.exists()
        && let Err(error) = fs::remove_dir_all(folder)
    {
        log::warn!("couldn't remove the downloaded update: {error}");
    }
}

/// Amluto's public key, as `tauri.conf.json` gives it to the updater.
fn public_key(app: &AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")?
        .get("pubkey")?
        .as_str()
        .map(str::to_string)
}

/// Checks a setup the way the updater plugin does: Amluto's key, and signed for exactly
/// `version`. Done again at install time, since the file waited on disk in between.
fn verify(setup: &[u8], signature: &str, public_key: &str, version: &str) -> Result<(), String> {
    use base64::Engine as _;
    let decode = |text: &str| {
        base64::engine::general_purpose::STANDARD
            .decode(text.trim())
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .ok_or_else(|| "not base64".to_string())
    };
    let key = minisign_verify::PublicKey::decode(&decode(public_key)?)
        .map_err(|error| error.to_string())?;
    let signature = minisign_verify::Signature::decode(&decode(signature)?)
        .map_err(|error| error.to_string())?;
    key.verify(setup, &signature, true)
        .map_err(|error| error.to_string())?;
    // Read only now that the global signature (over this comment) has been checked.
    let signed = signature
        .trusted_comment()
        .split('\t')
        .find_map(|part| part.strip_prefix("version:"));
    if signed == Some(version) {
        Ok(())
    } else {
        Err(format!("signed for {signed:?}, not {version}"))
    }
}

/// What to do with a waiting update when the app starts.
#[derive(Debug, PartialEq, Eq)]
enum AtStart {
    Install,
    /// Already running that version or newer, or given up on: removed.
    Forget,
}

fn at_start(pending: &Pending, running: &semver::Version) -> AtStart {
    let newer = semver::Version::parse(&pending.version).is_ok_and(|version| version > *running);
    if newer && pending.attempts < MAX_ATTEMPTS {
        AtStart::Install
    } else {
        AtStart::Forget
    }
}

/// The start options passed on to the new version.
fn kept_args() -> impl Iterator<Item = String> {
    std::env::args()
        .skip(1)
        .filter(|arg| KEPT_ARGS.contains(&arg.as_str()))
}

/// Runs a checked setup silently in update mode; it replaces the program and opens the new
/// version with the same start options (the arguments the updater plugin uses in quiet mode).
/// The portable program replaces itself instead.
#[cfg(windows)]
fn launch_setup(folder: &Path) -> Result<(), String> {
    if channel() == Channel::Portable {
        return replace_program(folder);
    }
    std::process::Command::new(folder.join(PENDING_SETUP))
        .args(["/S", "/UPDATE", "/R", "/ARGS"])
        .args(kept_args())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Linux (docs/spec/10-distribution.md#linux): an `AppImage` is replaced where it is, beside itself
/// first and then renamed over, so it's never left half-written; a `.deb` is installed by `dpkg`
/// through the desktop's own administrator prompt (polkit's `pkexec`). Then the new version opens
/// with the same start options.
#[cfg(not(windows))]
fn launch_setup(folder: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    use tauri::utils::{config::BundleType, platform::bundle_type};

    let package = folder.join(PENDING_SETUP);
    let program = match bundle_type() {
        Some(BundleType::AppImage) => {
            let current = std::env::var_os("APPIMAGE")
                .map(PathBuf::from)
                .ok_or("not running from an AppImage")?;
            let staged = current.with_extension("AppImage.update");
            fs::copy(&package, &staged).map_err(|error| error.to_string())?;
            fs::set_permissions(&staged, fs::Permissions::from_mode(0o755))
                .and_then(|()| fs::rename(&staged, &current))
                .map_err(|error| {
                    let _ = fs::remove_file(&staged);
                    error.to_string()
                })?;
            current
        }
        Some(BundleType::Deb) => {
            let installed = std::process::Command::new("pkexec")
                .args(["dpkg", "-i"])
                .arg(&package)
                .status()
                .map_err(|error| format!("no administrator prompt (pkexec): {error}"))?;
            if !installed.success() {
                return Err(
                    "the package wasn't installed (the prompt was closed or refused)".into(),
                );
            }
            // The program was just replaced: its old path now reads "… (deleted)".
            let path = std::env::current_exe().map_err(|error| error.to_string())?;
            PathBuf::from(path.to_string_lossy().trim_end_matches(" (deleted)"))
        }
        _ => return Err("this copy can't install updates".into()),
    };
    std::process::Command::new(program)
        .args(kept_args())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Passed to the new portable program: the old one's process id, to wait for.
#[cfg(windows)]
const REPLACED_ARG: &str = "--replaced=";

/// The old program, renamed aside while the new one takes its name.
fn aside(program: &Path) -> PathBuf {
    program.with_extension("exe.old")
}

/// Puts `source` in `program`'s place: written beside it, the program renamed aside (Windows lets
/// a running program be renamed, not overwritten), and the new one renamed into its place. If the
/// new one can't take its place, the program is put back, so it's never missing.
#[cfg_attr(
    not(windows),
    allow(
        dead_code,
        reason = "the portable program is Windows only; tested everywhere"
    )
)]
fn swap_in(program: &Path, source: &Path) -> Result<(), String> {
    let staged = program.with_extension("exe.new");
    let old = aside(program);
    fs::copy(source, &staged)
        .map_err(|error| format!("the new program couldn't be written beside this one: {error}"))?;
    let _ = fs::remove_file(&old);
    if let Err(error) = fs::rename(program, &old) {
        let _ = fs::remove_file(&staged);
        return Err(format!("this program couldn't be moved aside: {error}"));
    }
    if let Err(error) = fs::rename(&staged, program) {
        let _ = fs::rename(&old, program);
        let _ = fs::remove_file(&staged);
        return Err(format!(
            "the new program couldn't take this one's place: {error}"
        ));
    }
    Ok(())
}

/// The portable program replaces itself where it is, then opens the new one, which waits for this
/// one to close; the old one goes at the next start.
#[cfg(windows)]
fn replace_program(folder: &Path) -> Result<(), String> {
    let program = std::env::current_exe().map_err(|error| error.to_string())?;
    swap_in(&program, &folder.join(PENDING_SETUP))?;
    std::process::Command::new(&program)
        .arg(format!("{REPLACED_ARG}{}", std::process::id()))
        .args(kept_args())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// At the very start, before anything else: a portable program that has just replaced its old
/// copy waits for that copy to close (it holds the global shortcuts and the recorder until it
/// does), then removes it.
pub fn after_replacement() {
    if !is_portable() {
        return;
    }
    #[cfg(windows)]
    if let Some(pid) = std::env::args().find_map(|arg| {
        arg.strip_prefix(REPLACED_ARG)
            .and_then(|pid| pid.parse::<u32>().ok())
    }) {
        capture::platform::window::wait_for_exit(pid, std::time::Duration::from_secs(10));
    }
    if let Ok(program) = std::env::current_exe() {
        let old = aside(&program);
        if old.exists() {
            // Tried again at the next start if the old copy hasn't quite closed yet.
            let _ = fs::remove_file(old);
        }
    }
}

/// Checks the waiting setup again and runs it. `Err` names what stopped it.
fn install_pending(app: &AppHandle, folder: &Path) -> Result<(), String> {
    let mut pending = read_pending(folder).ok_or("no downloaded update")?;
    let setup = fs::read(folder.join(PENDING_SETUP)).map_err(|error| error.to_string())?;
    let key = public_key(app).ok_or("no public key in the app's configuration")?;
    verify(&setup, &pending.signature, &key, &pending.version)?;
    pending.attempts += 1;
    write_pending(folder, &pending).map_err(|error| error.to_string())?;
    log::info!(
        "installing update {} (attempt {})",
        pending.version,
        pending.attempts
    );
    launch_setup(folder)
}

/// At start, before any window shows: installs an update downloaded last time. Returns true when
/// its setup is running, and the app must exit so the setup can replace it.
pub fn install_pending_on_start(app: &AppHandle) -> bool {
    let Some(folder) = pending_folder(app) else {
        return false;
    };
    if !updates_itself(channel()) {
        forget_pending(&folder);
        return false;
    }
    let Some(pending) = read_pending(&folder) else {
        return false;
    };
    if at_start(&pending, &app.package_info().version) == AtStart::Forget {
        forget_pending(&folder);
        return false;
    }
    match install_pending(app, &folder) {
        Ok(()) => true,
        Err(problem) => {
            log::warn!("the downloaded update wasn't installed: {problem}");
            forget_pending(&folder);
            false
        }
    }
}

/// Downloads the version the last check found (the plugin checks its signature), and keeps it
/// to install at the next start. Returns its version.
#[tauri::command]
pub async fn updates_download(app: AppHandle) -> Result<String, CommandError> {
    updates_on()?;
    let update = app
        .state::<UpdateService>()
        .found
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
        .ok_or_else(|| CommandError::new("noUpdate", "Check for updates first."))?;
    let folder = pending_folder(&app)
        .ok_or_else(|| CommandError::new("updateDownloadFailed", "no app data folder"))?;
    if read_pending(&folder).is_some_and(|pending| pending.version == update.version)
        && folder.join(PENDING_SETUP).exists()
    {
        return Ok(update.version);
    }
    let setup = update.download(|_, _| {}, || {}).await.map_err(|error| {
        log::warn!("update download or signature check failed: {error}");
        CommandError::new("updateDownloadFailed", error.to_string())
    })?;
    let store = || -> std::io::Result<()> {
        forget_pending(&folder);
        fs::create_dir_all(&folder)?;
        fs::write(folder.join(PENDING_SETUP), &setup)?;
        write_pending(
            &folder,
            &Pending {
                version: update.version.clone(),
                signature: update.signature.clone(),
                attempts: 0,
            },
        )
    };
    store().map_err(|error| CommandError::new("updateDownloadFailed", error.to_string()))?;
    log::info!(
        "update {} downloaded; it installs at the next start",
        update.version
    );
    Ok(update.version)
}

/// The downloaded version waiting for the next start, if there is one.
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands receive owned values across IPC."
)]
#[tauri::command]
#[must_use]
pub fn updates_pending(app: AppHandle) -> Option<String> {
    if !updates_itself(channel()) {
        return None;
    }
    let pending = read_pending(&pending_folder(&app)?)?;
    (at_start(&pending, &app.package_info().version) == AtStart::Install).then_some(pending.version)
}

/// Restart now: installs the downloaded version straight away. The setup closes Steps and
/// opens the new version, so this returns only if something stopped it.
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands receive owned values across IPC."
)]
#[tauri::command]
pub fn updates_install(app: AppHandle) -> Result<(), CommandError> {
    updates_on()?;
    not_recording(&app)?;
    let folder = pending_folder(&app)
        .ok_or_else(|| CommandError::new("noUpdate", "Check for updates first."))?;
    install_pending(&app, &folder).map_err(|problem| {
        log::warn!("the downloaded update wasn't installed: {problem}");
        forget_pending(&folder);
        CommandError::new("updateInstallFailed", problem)
    })?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_setup_exe_install_checks_and_policy_can_stop_it() {
        assert_eq!(
            channel_for(false, Some(&BundleType::Nsis), false, true),
            Channel::Checks
        );
        assert_eq!(
            channel_for(false, Some(&BundleType::Nsis), true, true),
            Channel::Policy
        );
        assert_eq!(
            channel_for(false, Some(&BundleType::Msi), false, true),
            Channel::Msi
        );
        assert_eq!(channel_for(false, None, false, false), Channel::None);
    }

    #[test]
    fn the_linux_packages_update_themselves_unless_policy_says_not() {
        for bundle in [BundleType::Deb, BundleType::AppImage] {
            assert_eq!(
                channel_for(false, Some(&bundle), false, true),
                Channel::Checks
            );
            assert_eq!(
                channel_for(false, Some(&bundle), true, true),
                Channel::Policy
            );
        }
    }

    #[test]
    fn the_portable_program_is_its_own_channel() {
        assert_eq!(channel_for(false, None, false, true), Channel::Portable);
        // Policy can switch its checks off, as for the setup's copy.
        assert_eq!(channel_for(false, None, true, true), Channel::Policy);
        assert!(updates_itself(Channel::Portable) && updates_itself(Channel::Checks));
        assert!(!updates_itself(Channel::Policy) && !updates_itself(Channel::Msi));
        assert!(!updates_itself(Channel::ReadOnly));
        assert_eq!(
            aside(Path::new(r"D:\Tools\amluto-steps-0.4.3-x64-portable.exe")),
            PathBuf::from(r"D:\Tools\amluto-steps-0.4.3-x64-portable.exe.old")
        );
        // A stamped installer copy is never taken for the portable one.
        assert_eq!(
            channel_for(false, Some(&BundleType::Nsis), false, true),
            Channel::Checks
        );
    }

    #[test]
    fn the_store_package_never_checks_whatever_its_stamp_says() {
        for bundle in [Some(&BundleType::Nsis), Some(&BundleType::Msi), None] {
            assert_eq!(channel_for(true, bundle, false, true), Channel::Store);
        }
    }

    #[test]
    fn a_development_build_doesnt_check() {
        // `cargo test` builds are never stamped by the bundler.
        assert_eq!(tauri::utils::platform::bundle_type(), None);
        assert_ne!(channel(), Channel::Checks);
    }

    // A throwaway key's public half and its signature of FIXTURE for version 0.2.0, made with
    // `tauri signer` on 27/09/2026. Not Amluto's key, and no private key is kept.
    const FIXTURE: &[u8] = b"Amluto Steps test setup";
    const FIXTURE_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEVGRkJDQkU3N0REMDgyQzIKUldUQ2d0Qjk1OHY3NzBGMkREVGlVT0lvcEpUL2JhMk5paE1DKy82Nk5oazl6VjV5czhSK2dXdW4K";
    const FIXTURE_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUQ2d0Qjk1OHY3NytlMGtlWXlvWUl4THdmL1pRdldQNGJZUlN1dFlqMnlBVzNTZ2doQnVIUWxJTXdNNDlsc1hUV3QzNm9RRk1YWnVTTUVZQll4cFBnYVhmVitFVkd4Z0FRPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwNTQxOTI4CWZpbGU6c2V0dXAuYmluCXZlcnNpb246MC4yLjAKK25wWTJ2UXFDeUVGdlZFaGJIT3RRRGxBSStGLzh0OWpQUGk5cnVRSVM1ZE5UWDVnM3c2M0FzOEhzbG42cDFtSU10ZXpzdlk0bFU4aWwrWit4aVJjQ2c9PQo=";

    #[test]
    fn a_waiting_setup_runs_only_if_it_is_still_the_signed_one_for_its_version() {
        assert_eq!(
            verify(FIXTURE, FIXTURE_SIGNATURE, FIXTURE_KEY, "0.2.0"),
            Ok(())
        );
        // Swapped on disk while it waited.
        assert!(verify(b"something else", FIXTURE_SIGNATURE, FIXTURE_KEY, "0.2.0").is_err());
        // Signed for 0.2.0, waiting as another version.
        assert!(verify(FIXTURE, FIXTURE_SIGNATURE, FIXTURE_KEY, "0.3.0").is_err());
        // Another key: the app's own, which never signed the fixture.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let amluto = config["plugins"]["updater"]["pubkey"].as_str().unwrap();
        assert!(verify(FIXTURE, FIXTURE_SIGNATURE, amluto, "0.2.0").is_err());
        assert!(verify(FIXTURE, "not a signature", FIXTURE_KEY, "0.2.0").is_err());
    }

    #[test]
    fn a_waiting_update_installs_only_if_newer_and_not_tried_too_often() {
        let running = semver::Version::new(0, 2, 0);
        let pending = |version: &str, attempts| Pending {
            version: version.into(),
            signature: String::new(),
            attempts,
        };
        assert_eq!(at_start(&pending("0.3.0", 0), &running), AtStart::Install);
        assert_eq!(at_start(&pending("0.3.0", 1), &running), AtStart::Install);
        // A setup that failed twice doesn't reopen the app into a third go.
        assert_eq!(at_start(&pending("0.3.0", 2), &running), AtStart::Forget);
        // Installed already (or older): the leftovers go.
        assert_eq!(at_start(&pending("0.2.0", 0), &running), AtStart::Forget);
        assert_eq!(at_start(&pending("0.1.9", 0), &running), AtStart::Forget);
        assert_eq!(at_start(&pending("garbage", 0), &running), AtStart::Forget);
    }

    #[test]
    fn the_portable_program_is_swapped_in_place_or_left_as_it_was() {
        let folder = std::env::temp_dir().join(format!("amluto-swap-test-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        let program = folder.join("amluto-steps-0.4.2-x64-portable.exe");
        let new = folder.join("setup.exe");
        fs::write(&program, b"old").unwrap();
        // Nothing to put in its place: the program stays as it was.
        assert!(swap_in(&program, &folder.join("missing.exe")).is_err());
        assert_eq!(fs::read(&program).unwrap(), b"old");
        assert!(!aside(&program).exists());
        fs::write(&new, b"new").unwrap();
        swap_in(&program, &new).unwrap();
        assert_eq!(fs::read(&program).unwrap(), b"new");
        assert_eq!(fs::read(aside(&program)).unwrap(), b"old");
        assert!(!program.with_extension("exe.new").exists());
        fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn the_waiting_record_round_trips_and_is_removed_whole() {
        let folder =
            std::env::temp_dir().join(format!("amluto-updates-test-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        let pending = Pending {
            version: "0.3.0".into(),
            signature: FIXTURE_SIGNATURE.into(),
            attempts: 1,
        };
        write_pending(&folder, &pending).unwrap();
        fs::write(folder.join(PENDING_SETUP), FIXTURE).unwrap();
        assert_eq!(read_pending(&folder), Some(pending));
        forget_pending(&folder);
        assert!(!folder.exists());
        assert_eq!(read_pending(&folder), None);
    }
}
