//! The person's own names, for blur suggestions (docs/spec/08-privacy-and-security.md#suggested-blurs):
//! screenshots show them in paths, File Explorer, Settings and title bars, and the text-reading
//! detector can't tell them from any other word (F006, 01/10/2026). Read on this PC only; they
//! never leave it.

/// The account name, and on Windows each `OneDrive` account's email and display name and the
/// Office user name; on Linux the login and the full name. Duplicates and blanks left out.
#[tauri::command]
pub fn identity_names() -> Vec<String> {
    let mut names = platform_names();
    names.retain(|name| name.trim().chars().count() >= 3);
    let mut seen = std::collections::HashSet::new();
    names.retain(|name| seen.insert(name.trim().to_lowercase()));
    names
}

/// This PC's name and the Windows (or Linux) login, recorded with a guide's saves and lock when
/// Settings > Privacy allows (docs/spec/03-data-and-sharing.md#password-locks, 04/10/2026).
#[derive(serde::Serialize)]
pub struct Machine {
    pc: String,
    login: String,
}

#[tauri::command]
pub fn identity_machine() -> Machine {
    let variable = |name: &str| std::env::var(name).unwrap_or_default().trim().to_string();
    let pc = if cfg!(windows) {
        variable("COMPUTERNAME")
    } else {
        std::fs::read_to_string("/etc/hostname")
            .map_or_else(|_| variable("HOSTNAME"), |name| name.trim().to_string())
    };
    let login = if cfg!(windows) {
        variable("USERNAME")
    } else {
        variable("USER")
    };
    // Kept short: they go into shared guide files.
    let short = |text: String| text.chars().take(100).collect::<String>();
    Machine {
        pc: short(pc),
        login: short(login),
    }
}

#[cfg(windows)]
fn platform_names() -> Vec<String> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};

    let mut names = Vec::new();
    if let Ok(user) = std::env::var("USERNAME") {
        names.push(user);
    }
    let user = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(accounts) =
        user.open_subkey_with_flags(r"Software\Microsoft\OneDrive\Accounts", KEY_READ)
    {
        for account in accounts.enum_keys().flatten() {
            let Ok(key) = accounts.open_subkey_with_flags(&account, KEY_READ) else {
                continue;
            };
            for value in ["UserEmail", "DisplayName"] {
                if let Ok(text) = key.get_value::<String, _>(value) {
                    // An email's part before the @ shows on its own too (paths, greetings).
                    if let Some((local, _)) = text.split_once('@') {
                        names.push(local.to_string());
                    }
                    names.push(text);
                }
            }
        }
    }
    if let Ok(info) =
        user.open_subkey_with_flags(r"Software\Microsoft\Office\Common\UserInfo", KEY_READ)
        && let Ok(name) = info.get_value::<String, _>("UserName")
    {
        names.push(name);
    }
    names
}

#[cfg(not(windows))]
fn platform_names() -> Vec<String> {
    let mut names = Vec::new();
    let login = std::env::var("USER").unwrap_or_default();
    if !login.is_empty() {
        // The full name is the first field of the comment in /etc/passwd ("Robin Hale,,,").
        if let Ok(passwd) = std::fs::read_to_string("/etc/passwd") {
            for line in passwd.lines() {
                let fields: Vec<&str> = line.split(':').collect();
                if fields.first() == Some(&login.as_str())
                    && let Some(full) = fields.get(4).and_then(|gecos| gecos.split(',').next())
                {
                    names.push(full.to_string());
                }
            }
        }
        names.push(login);
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_cleaned_of_blanks_and_repeats() {
        let names = identity_names();
        let mut lower: Vec<String> = names.iter().map(|name| name.to_lowercase()).collect();
        lower.sort();
        lower.dedup();
        assert_eq!(lower.len(), names.len());
        assert!(names.iter().all(|name| name.trim().chars().count() >= 3));
    }
}
