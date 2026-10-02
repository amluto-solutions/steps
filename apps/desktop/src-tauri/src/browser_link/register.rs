//! Tells Chrome and Edge where Steps' native messaging host is, for this person only
//! (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together): a manifest in the app's
//! local data naming this program and the extension allowed to start it, and a key under each
//! browser's `NativeMessagingHosts` in `HKEY_CURRENT_USER` pointing at the manifest.
use std::fs;
use std::io;
use std::path::Path;

use winreg::RegKey;
use winreg::enums::HKEY_CURRENT_USER;

/// The host's name, as the extension asks for it (`connectNative`).
pub const HOST_NAME: &str = "com.amluto.steps";

/// Steps for Chrome's id in the Chrome Web Store (which Edge installs from too) and in Edge
/// Add-ons, if listed there: the only extensions a browser lets start the host. The Chrome Web
/// Store's id isn't known yet (30/09/2026); until it's here no browser starts the host.
pub const EXTENSION_IDS: &[&str] = &[];

/// Each browser's key for the host, under `HKEY_CURRENT_USER`.
pub const BROWSER_KEYS: [&str; 2] = [
    r"Software\Google\Chrome\NativeMessagingHosts\com.amluto.steps",
    r"Software\Microsoft\Edge\NativeMessagingHosts\com.amluto.steps",
];

/// The manifest's contents: the browser starts `program` for the extensions in `extension_ids`
/// alone, talking over its standard input and output.
#[must_use]
pub fn manifest(program: &Path, extension_ids: &[&str]) -> String {
    let origins: Vec<String> = extension_ids
        .iter()
        .map(|id| format!("chrome-extension://{id}/"))
        .collect();
    let manifest = serde_json::json!({
        "name": HOST_NAME,
        "description": "Steps by Amluto",
        "path": program,
        "type": "stdio",
        "allowed_origins": origins,
    });
    serde_json::to_string_pretty(&manifest).unwrap_or_default()
}

/// Writes the manifest at `manifest_path` for `program` and points each key at it.
///
/// # Errors
/// When the manifest or a key can't be written.
pub fn register(
    manifest_path: &Path,
    program: &Path,
    extension_ids: &[&str],
    keys: &[&str],
) -> io::Result<()> {
    if let Some(folder) = manifest_path.parent() {
        fs::create_dir_all(folder)?;
    }
    let contents = manifest(program, extension_ids);
    // Unchanged since the last start: nothing to write.
    if fs::read_to_string(manifest_path).ok().as_deref() != Some(contents.as_str()) {
        let staged = manifest_path.with_extension("json.tmp");
        fs::write(&staged, contents)?;
        fs::rename(&staged, manifest_path)?;
    }
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    for key in keys {
        let (key, _) = hkcu.create_subkey(key)?;
        key.set_value("", &manifest_path.as_os_str())?;
    }
    Ok(())
}

/// Removes the keys that point at this copy's manifest, and the manifest. A key another copy of
/// Steps set (the portable program beside an installed one) is left as it is.
pub fn unregister(manifest_path: &Path, keys: &[&str]) {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    for key in keys {
        let ours = hkcu
            .open_subkey(key)
            .and_then(|opened| opened.get_value::<std::ffi::OsString, _>(""))
            .is_ok_and(|value| Path::new(&value) == manifest_path);
        if ours && let Err(error) = hkcu.delete_subkey(key) {
            log::warn!("the browser link's key {key} couldn't be removed: {error}");
        }
    }
    let _ = fs::remove_file(manifest_path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_manifest_names_this_program_and_only_steps_extension() {
        let text = manifest(
            Path::new(r"C:\Users\Sam\AppData\Local\Steps\amluto-steps.exe"),
            &["abcdefghijklmnopabcdefghijklmnop"],
        );
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["name"], "com.amluto.steps");
        assert_eq!(value["type"], "stdio");
        assert_eq!(
            value["path"],
            r"C:\Users\Sam\AppData\Local\Steps\amluto-steps.exe"
        );
        assert_eq!(
            value["allowed_origins"],
            serde_json::json!(["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"])
        );
    }

    #[test]
    fn registering_and_unregistering_touch_only_this_copys_keys() {
        let base = format!(
            r"Software\AmlutoStepsTest-browser-link-{}",
            std::process::id()
        );
        let ours = format!(r"{base}\Chrome\com.amluto.steps");
        let others = format!(r"{base}\Edge\com.amluto.steps");
        let folder = tempfile::tempdir().unwrap();
        let manifest_path = folder.path().join("com.amluto.steps.json");
        let program = Path::new(r"D:\Tools\amluto-steps-0.4.3-x64-portable.exe");

        register(&manifest_path, program, &["abc"], &[&ours, &others]).unwrap();
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let pointed: String = hkcu.open_subkey(&ours).unwrap().get_value("").unwrap();
        assert_eq!(Path::new(&pointed), manifest_path);
        assert!(
            fs::read_to_string(&manifest_path)
                .unwrap()
                .contains("portable.exe")
        );

        // Another copy of Steps registered itself for Edge since.
        hkcu.create_subkey(&others)
            .unwrap()
            .0
            .set_value("", &r"C:\Other\com.amluto.steps.json")
            .unwrap();
        unregister(&manifest_path, &[&ours, &others]);
        assert!(hkcu.open_subkey(&ours).is_err());
        assert!(hkcu.open_subkey(&others).is_ok());
        assert!(!manifest_path.exists());
        hkcu.delete_subkey_all(&base).unwrap();
    }
}
