//! IT policy from the registry (docs/spec/07-settings-and-policy.md#registry-policy-desktop-windows),
//! or on Linux from `/etc/amluto-steps/policy.json` with the same value names
//! (docs/spec/07-settings-and-policy.md#linux).
//!
//! `HKLM\SOFTWARE\Policies\Amluto\Steps` covers the machine and wins over the same key under HKCU,
//! value by value. List values that "add" (excluded apps, blur terms, sensitive field words, locked
//! settings) are combined from both. Policy is read once at start: Group Policy and Intune apply
//! at sign-in, and a policy change mid-recording would change what's being captured.

use std::sync::OnceLock;

use serde::Serialize;

#[cfg(windows)]
pub const POLICY_KEY: &str = r"SOFTWARE\Policies\Amluto\Steps";

/// Linux: the machine's policy, set by IT (root only can write `/etc`).
#[cfg(not(windows))]
pub const POLICY_FILE: &str = "/etc/amluto-steps/policy.json";

/// Setting keys that `Locked` can name. Anything else is ignored (and logged), so a typo in a
/// policy can't lock something unexpected.
pub const LOCKABLE: &[&str] = &[
    "Monitors",
    "ScreenshotMode",
    "ScreenshotQuality",
    "AppSwitchSteps",
    "IncludeOriginals",
    "ExportFolder",
    "AskWhereToSave",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyLibrary {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub libraries: Vec<PolicyLibrary>,
    pub default_library: Option<String>,
    pub brand_profiles: Vec<String>,
    pub default_pdf_brand: Option<String>,
    pub app_colours_brand: Option<String>,
    pub excluded_apps: Vec<String>,
    pub blur_terms: Vec<String>,
    pub sensitive_field_patterns: Vec<String>,
    /// `Some(true)`: on and locked; `Some(false)`: off and locked; `None`: the user's choice.
    pub auto_start: Option<bool>,
    pub locked: Vec<String>,
    pub disable_update_check: bool,
    /// "Record what's typed" (keys, commands and field values) can't be switched on.
    pub disable_keystroke_recording: bool,
    /// Whether the start dialog's "Record what's typed" starts ticked (30/09/2026). Only
    /// where it starts: the person can still untick it for a recording. `None`: their choice.
    pub record_typing_by_default: Option<bool>,
    /// The same for "Include command output".
    pub include_output_by_default: Option<bool>,
    /// Typing into something the recording couldn't name shows its text (01/10/2026).
    pub show_unnamed_typing: Option<bool>,
    /// The app's language, set by IT (a code from packages/core/src/languages.ts; the UI checks
    /// it). `None`: the person's choice, Windows' language to start with.
    pub language: Option<String>,
    /// The tone new recordings are worded in: casual, plain or formal (01/10/2026).
    pub language_tone: Option<String>,
    /// How much blur suggestions look for: light, standard or thorough (01/10/2026).
    pub blur_strength: Option<String>,
    /// Lock… is hidden; guides already locked stay locked (04/10/2026).
    pub disable_guide_locks: bool,
    /// A password that unlocks any locked guide, as a hash (`pbkdf2-sha256$…`, made as
    /// docs/it/guide-locks.md shows); the UI checks it.
    pub guide_lock_recovery_password: Option<String>,
    /// Whether guides record this PC's name and the Windows login; `None`: the person's choice.
    pub record_pc_and_login: Option<bool>,
}

impl Policy {
    #[must_use]
    pub fn is_locked(&self, key: &str) -> bool {
        self.locked.iter().any(|item| item == key)
    }
}

/// The screenshot quality the window asked for, unless IT has locked it at Balanced.
#[must_use]
pub fn screenshot_quality(asked: library::ScreenshotQuality) -> library::ScreenshotQuality {
    if current().is_locked("ScreenshotQuality") {
        library::ScreenshotQuality::Balanced
    } else {
        asked
    }
}

/// One hive's values, as read. Kept separate so merging is testable without a registry.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HiveValues {
    pub libraries: Option<Vec<String>>,
    pub default_library: Option<String>,
    pub brand_profiles: Option<Vec<String>>,
    pub default_pdf_brand: Option<String>,
    pub app_colours_brand: Option<String>,
    pub excluded_apps: Option<Vec<String>>,
    pub blur_terms: Option<Vec<String>>,
    pub sensitive_field_patterns: Option<Vec<String>>,
    pub auto_start: Option<u32>,
    pub locked: Option<Vec<String>>,
    pub disable_update_check: Option<u32>,
    pub disable_keystroke_recording: Option<u32>,
    pub record_typing_by_default: Option<u32>,
    pub include_output_by_default: Option<u32>,
    pub show_unnamed_typing: Option<u32>,
    pub language: Option<String>,
    pub language_tone: Option<String>,
    pub blur_strength: Option<String>,
    pub disable_guide_locks: Option<u32>,
    pub guide_lock_recovery_password: Option<String>,
    pub record_pc_and_login: Option<u32>,
}

fn clean(values: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let value = value.trim();
        if !value.is_empty() && !out.iter().any(|item| item.eq_ignore_ascii_case(value)) {
            out.push(value.to_owned());
        }
    }
    out
}

fn combined(machine: Option<Vec<String>>, user: Option<Vec<String>>) -> Vec<String> {
    clean(machine.into_iter().chain(user).flatten().collect())
}

fn text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// Expands `%NAME%` environment variables, as Windows does for paths, so one policy can point
/// everyone at their own synced folder (`%USERPROFILE%\Contoso\Guides`). Unknown names are kept
/// as written, so the folder simply isn't found rather than pointing somewhere unexpected.
fn expand_env(path: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(path.len());
    let mut rest = path;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                if let Some(value) = lookup(name) {
                    out.push_str(&value);
                } else {
                    out.push('%');
                    out.push_str(name);
                    out.push('%');
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `Name=Path` entries; a bare path takes its folder name.
fn libraries(entries: Vec<String>) -> Vec<PolicyLibrary> {
    let mut out: Vec<PolicyLibrary> = Vec::new();
    for entry in clean(entries) {
        let (name, path) = if let Some((name, path)) = entry.split_once('=') {
            (name.trim().to_owned(), path.trim().to_owned())
        } else {
            let name = entry
                .trim_end_matches(['\\', '/'])
                .rsplit(['\\', '/'])
                .next()
                .unwrap_or(&entry)
                .to_owned();
            (name, entry.clone())
        };
        let path = expand_env(&path, |name| std::env::var(name).ok());
        if path.is_empty() || out.iter().any(|item| item.path.eq_ignore_ascii_case(&path)) {
            continue;
        }
        out.push(PolicyLibrary {
            name: if name.is_empty() { path.clone() } else { name },
            path,
        });
    }
    out
}

/// The machine's values win; lists that add are combined.
#[must_use]
pub fn merge(machine: HiveValues, user: HiveValues) -> Policy {
    let locked = combined(machine.locked, user.locked)
        .into_iter()
        .filter_map(|key| {
            let known = LOCKABLE.iter().find(|item| item.eq_ignore_ascii_case(&key));
            if known.is_none() {
                log::warn!("policy: unknown setting in Locked ignored: {key}");
            }
            known.map(|item| (*item).to_owned())
        })
        .collect();
    Policy {
        libraries: libraries(machine.libraries.or(user.libraries).unwrap_or_default()),
        default_library: text(machine.default_library).or_else(|| text(user.default_library)),
        // Brand files on a share or synced folder; `%USERPROFILE%` and the like are expanded.
        brand_profiles: clean(
            machine
                .brand_profiles
                .or(user.brand_profiles)
                .unwrap_or_default(),
        )
        .into_iter()
        .map(|path| expand_env(&path, |name| std::env::var(name).ok()))
        .collect(),
        default_pdf_brand: text(machine.default_pdf_brand).or_else(|| text(user.default_pdf_brand)),
        app_colours_brand: text(machine.app_colours_brand).or_else(|| text(user.app_colours_brand)),
        excluded_apps: combined(machine.excluded_apps, user.excluded_apps),
        blur_terms: combined(machine.blur_terms, user.blur_terms),
        sensitive_field_patterns: combined(
            machine.sensitive_field_patterns,
            user.sensitive_field_patterns,
        ),
        auto_start: machine
            .auto_start
            .or(user.auto_start)
            .map(|value| value != 0),
        locked,
        disable_update_check: machine
            .disable_update_check
            .or(user.disable_update_check)
            .is_some_and(|value| value != 0),
        disable_keystroke_recording: machine
            .disable_keystroke_recording
            .or(user.disable_keystroke_recording)
            .is_some_and(|value| value != 0),
        record_typing_by_default: machine
            .record_typing_by_default
            .or(user.record_typing_by_default)
            .map(|value| value != 0),
        include_output_by_default: machine
            .include_output_by_default
            .or(user.include_output_by_default)
            .map(|value| value != 0),
        show_unnamed_typing: machine
            .show_unnamed_typing
            .or(user.show_unnamed_typing)
            .map(|value| value != 0),
        language: text(machine.language).or_else(|| text(user.language)),
        language_tone: text(machine.language_tone).or_else(|| text(user.language_tone)),
        blur_strength: text(machine.blur_strength).or_else(|| text(user.blur_strength)),
        disable_guide_locks: machine
            .disable_guide_locks
            .or(user.disable_guide_locks)
            .is_some_and(|value| value != 0),
        guide_lock_recovery_password: text(machine.guide_lock_recovery_password)
            .or_else(|| text(user.guide_lock_recovery_password)),
        record_pc_and_login: machine
            .record_pc_and_login
            .or(user.record_pc_and_login)
            .map(|value| value != 0),
    }
}

#[cfg(windows)]
fn read_hive(root: winreg::HKEY, path: &str) -> HiveValues {
    use winreg::RegKey;
    use winreg::enums::KEY_READ;

    let Ok(key) = RegKey::predef(root).open_subkey_with_flags(path, KEY_READ) else {
        return HiveValues::default();
    };
    // A value of the wrong type is ignored rather than guessed at. A list may also be one string
    // separated by semicolons: that is how the .msi's install properties write it, since an
    // msiexec command line can't carry a multi-string.
    let string = |name: &str| key.get_value::<String, _>(name).ok();
    let list = |name: &str| {
        key.get_value::<Vec<String>, _>(name)
            .ok()
            .or_else(|| string(name).map(|value| split_list(&value)))
    };
    let number = |name: &str| key.get_value::<u32, _>(name).ok();
    HiveValues {
        libraries: list("Libraries"),
        default_library: string("DefaultLibrary"),
        brand_profiles: list("BrandProfiles"),
        default_pdf_brand: string("DefaultPdfBrand"),
        app_colours_brand: string("AppColoursBrand"),
        excluded_apps: list("ExcludedApps"),
        blur_terms: list("BlurTerms"),
        sensitive_field_patterns: list("SensitiveFieldPatterns"),
        auto_start: number("AutoStart"),
        locked: list("Locked"),
        disable_update_check: number("DisableUpdateCheck"),
        disable_keystroke_recording: number("DisableKeystrokeRecording"),
        record_typing_by_default: number("RecordTypingByDefault"),
        include_output_by_default: number("IncludeCommandOutputByDefault"),
        show_unnamed_typing: number("ShowUnnamedTyping"),
        language: string("Language"),
        language_tone: string("LanguageTone"),
        blur_strength: string("BlurStrength"),
        disable_guide_locks: number("DisableGuideLocks"),
        guide_lock_recovery_password: string("GuideLockRecoveryPassword"),
        record_pc_and_login: number("RecordPcAndLogin"),
    }
}

/// A list written as one string ("a;b;c"), as the .msi's install properties write it. Blank items
/// are dropped.
fn split_list(value: &str) -> Vec<String> {
    value
        .split(';')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(windows)]
fn read_registry() -> Policy {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    merge(
        read_hive(HKEY_LOCAL_MACHINE, POLICY_KEY),
        read_hive(HKEY_CURRENT_USER, POLICY_KEY),
    )
}

/// A policy file's values, under the registry's names: lists as arrays (or one string separated
/// by semicolons), switches as numbers or `true`/`false`. A value of the wrong type is ignored.
#[cfg(any(not(windows), test))]
fn hive_from_json(value: &serde_json::Value) -> HiveValues {
    use serde_json::Value;
    let string = |name: &str| value.get(name).and_then(Value::as_str).map(str::to_string);
    let list = |name: &str| match value.get(name) {
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        ),
        Some(Value::String(text)) => Some(split_list(text)),
        _ => None,
    };
    let number = |name: &str| match value.get(name) {
        Some(Value::Bool(on)) => Some(u32::from(*on)),
        Some(Value::Number(number)) => number.as_u64().and_then(|n| u32::try_from(n).ok()),
        _ => None,
    };
    HiveValues {
        libraries: list("Libraries"),
        default_library: string("DefaultLibrary"),
        brand_profiles: list("BrandProfiles"),
        default_pdf_brand: string("DefaultPdfBrand"),
        app_colours_brand: string("AppColoursBrand"),
        excluded_apps: list("ExcludedApps"),
        blur_terms: list("BlurTerms"),
        sensitive_field_patterns: list("SensitiveFieldPatterns"),
        auto_start: number("AutoStart"),
        locked: list("Locked"),
        disable_update_check: number("DisableUpdateCheck"),
        disable_keystroke_recording: number("DisableKeystrokeRecording"),
        record_typing_by_default: number("RecordTypingByDefault"),
        include_output_by_default: number("IncludeCommandOutputByDefault"),
        show_unnamed_typing: number("ShowUnnamedTyping"),
        language: string("Language"),
        language_tone: string("LanguageTone"),
        blur_strength: string("BlurStrength"),
        disable_guide_locks: number("DisableGuideLocks"),
        guide_lock_recovery_password: string("GuideLockRecoveryPassword"),
        record_pc_and_login: number("RecordPcAndLogin"),
    }
}

/// Linux: `/etc/amluto-steps/policy.json`. There's no per-user policy: a file in the home folder
/// would be the person's own to change.
#[cfg(not(windows))]
fn read_registry() -> Policy {
    let Ok(text) = std::fs::read_to_string(POLICY_FILE) else {
        return Policy::default();
    };
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(value) => merge(hive_from_json(&value), HiveValues::default()),
        Err(error) => {
            log::warn!("policy: {POLICY_FILE} isn't valid JSON, so it's ignored: {error}");
            Policy::default()
        }
    }
}

/// The policy for this run of the app, read the first time it's needed.
pub fn current() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| {
        let policy = read_registry();
        if policy != Policy::default() {
            log::info!(
                "policy: {} libraries, {} excluded apps, {} locked settings",
                policy.libraries.len(),
                policy.excluded_apps.len(),
                policy.locked.len()
            );
        }
        policy
    })
}

#[tauri::command]
#[must_use]
pub fn policy_get() -> Policy {
    current().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_linux_policy_file_uses_the_registry_names() {
        let file = serde_json::json!({
            "ExcludedApps": ["keepassxc", "1password"],
            "BlurTerms": "Project Falcon; Codename Kite",
            "Locked": ["ExportFolder", "Nonsense"],
            "DisableKeystrokeRecording": true,
            "RecordTypingByDefault": true,
            "IncludeCommandOutputByDefault": 0,
            "AutoStart": 0,
            "DefaultPdfBrand": "client-a",
            "Language": " de ",
            "LanguageTone": "plain",
            "Libraries": 7
        });
        let policy = merge(hive_from_json(&file), HiveValues::default());
        assert_eq!(policy.excluded_apps, ["keepassxc", "1password"]);
        assert_eq!(policy.blur_terms, ["Project Falcon", "Codename Kite"]);
        assert_eq!(policy.locked, ["ExportFolder"]);
        assert!(policy.disable_keystroke_recording);
        assert_eq!(policy.record_typing_by_default, Some(true));
        assert_eq!(policy.include_output_by_default, Some(false));
        assert_eq!(policy.auto_start, Some(false));
        assert_eq!(policy.default_pdf_brand.as_deref(), Some("client-a"));
        assert_eq!(policy.language.as_deref(), Some("de"));
        assert_eq!(policy.language_tone.as_deref(), Some("plain"));
        // A value of the wrong type is left out.
        assert!(policy.libraries.is_empty());
    }

    #[test]
    fn an_msi_list_is_one_string_split_on_semicolons() {
        assert_eq!(
            split_list(r" Finance=S:\Guides ; ;HR=%USERPROFILE%\HR;"),
            vec![
                r"Finance=S:\Guides".to_string(),
                r"HR=%USERPROFILE%\HR".to_string()
            ]
        );
        assert!(split_list("").is_empty());
    }

    #[allow(
        clippy::unnecessary_wraps,
        reason = "every list in HiveValues is an Option"
    )]
    fn strings(values: &[&str]) -> Option<Vec<String>> {
        Some(values.iter().map(|value| (*value).to_owned()).collect())
    }

    #[test]
    fn nothing_set_means_no_policy() {
        assert_eq!(
            merge(HiveValues::default(), HiveValues::default()),
            Policy::default()
        );
    }

    #[test]
    fn the_machine_wins_value_by_value() {
        let machine = HiveValues {
            default_pdf_brand: Some("client".into()),
            auto_start: Some(0),
            record_typing_by_default: Some(0),
            ..HiveValues::default()
        };
        let user = HiveValues {
            default_pdf_brand: Some("amluto".into()),
            default_library: Some("Team".into()),
            auto_start: Some(1),
            disable_update_check: Some(1),
            disable_keystroke_recording: Some(1),
            record_typing_by_default: Some(1),
            include_output_by_default: Some(1),
            ..HiveValues::default()
        };
        let policy = merge(machine, user);
        assert_eq!(policy.record_typing_by_default, Some(false));
        assert_eq!(policy.include_output_by_default, Some(true));
        assert_eq!(policy.default_pdf_brand.as_deref(), Some("client"));
        assert_eq!(policy.default_library.as_deref(), Some("Team"));
        assert_eq!(policy.auto_start, Some(false));
        assert!(policy.disable_update_check);
        assert!(policy.disable_keystroke_recording);
    }

    #[test]
    fn lists_that_add_are_combined_without_duplicates() {
        let policy = merge(
            HiveValues {
                excluded_apps: strings(&["KeePass.exe", "", " bank.exe "]),
                blur_terms: strings(&["Project Falcon"]),
                ..HiveValues::default()
            },
            HiveValues {
                excluded_apps: strings(&["keepass.exe", "mstsc.exe"]),
                ..HiveValues::default()
            },
        );
        assert_eq!(
            policy.excluded_apps,
            ["KeePass.exe", "bank.exe", "mstsc.exe"]
        );
        assert_eq!(policy.blur_terms, ["Project Falcon"]);
    }

    #[test]
    fn libraries_take_name_equals_path_or_a_bare_path() {
        let policy = merge(
            HiveValues {
                libraries: strings(&[
                    r"Team guides=C:\Users\a\Contoso\Guides",
                    r"D:\Shared\Procedures\",
                    r"Duplicate=c:\users\a\contoso\guides",
                    "Empty=",
                ]),
                ..HiveValues::default()
            },
            HiveValues::default(),
        );
        assert_eq!(
            policy.libraries,
            [
                PolicyLibrary {
                    name: "Team guides".into(),
                    path: r"C:\Users\a\Contoso\Guides".into()
                },
                PolicyLibrary {
                    name: "Procedures".into(),
                    path: r"D:\Shared\Procedures\".into()
                },
            ]
        );
    }

    #[test]
    fn library_paths_expand_environment_variables() {
        let lookup = |name: &str| {
            (name.eq_ignore_ascii_case("USERPROFILE")).then(|| r"C:\Users\sam".to_owned())
        };
        assert_eq!(
            expand_env(r"%USERPROFILE%\Contoso\Guides", lookup),
            r"C:\Users\sam\Contoso\Guides"
        );
        assert_eq!(expand_env(r"%NOPE%\Guides", lookup), r"%NOPE%\Guides");
        assert_eq!(expand_env("50% done", lookup), "50% done");
        assert_eq!(expand_env("%%", lookup), "%%");
    }

    #[test]
    fn only_known_settings_can_be_locked() {
        let policy = merge(
            HiveValues {
                locked: strings(&["screenshotmode", "Everything"]),
                ..HiveValues::default()
            },
            HiveValues {
                locked: strings(&["ExportFolder"]),
                ..HiveValues::default()
            },
        );
        assert_eq!(policy.locked, ["ScreenshotMode", "ExportFolder"]);
        assert!(policy.is_locked("ScreenshotMode"));
        assert!(!policy.is_locked("Everything"));
    }
}

#[cfg(all(test, windows))]
mod registry_tests {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    use super::*;

    /// Writes a throwaway key under HKCU\Software (not the Policies key, which needs admin), reads
    /// it the way policy is read, and removes it.
    #[test]
    #[ignore = "writes to the current user's registry; run with --ignored"]
    fn reads_multi_strings_strings_and_numbers() {
        let path = format!(r"Software\Amluto Steps policy test {}", std::process::id());
        let root = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = root.create_subkey(&path).unwrap();
        key.set_value(
            "ExcludedApps",
            &vec!["KeePass.exe".to_owned(), "mstsc.exe".to_owned()],
        )
        .unwrap();
        key.set_value("DefaultLibrary", &"Team").unwrap();
        key.set_value("AutoStart", &0u32).unwrap();
        // The wrong type is ignored, not guessed at.
        key.set_value("BlurTerms", &"not a list").unwrap();
        let values = read_hive(HKEY_CURRENT_USER, &path);
        root.delete_subkey_all(&path).unwrap();
        assert_eq!(
            values.excluded_apps,
            Some(vec!["KeePass.exe".to_owned(), "mstsc.exe".to_owned()])
        );
        assert_eq!(values.default_library.as_deref(), Some("Team"));
        assert_eq!(values.auto_start, Some(0));
        assert_eq!(values.blur_terms, None);
        assert_eq!(read_hive(HKEY_CURRENT_USER, &path), HiveValues::default());
    }
}
