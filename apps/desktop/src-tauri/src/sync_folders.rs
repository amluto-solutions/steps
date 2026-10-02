//! Whether a folder is synced to the cloud (`OneDrive` or a `SharePoint` library), so the app can say plainly that people
//! with access to the library can see the unblurred originals
//! (docs/spec/03-data-and-sharing.md#redactions-and-the-original-screenshots).
//!
//! `OneDrive`'s own folders come from its environment variables, and every `SharePoint` library it
//! syncs is listed under `HKCU\Software\SyncEngines\Providers\OneDrive\<id>\MountPoint`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

fn normalised(path: &Path) -> String {
    let mut text = path.to_string_lossy().replace('/', "\\").to_lowercase();
    while text.ends_with('\\') {
        text.pop();
    }
    text
}

/// Whether `path` is one of `roots` or inside one.
fn inside_any(path: &Path, roots: &[PathBuf]) -> bool {
    let path = normalised(path);
    roots
        .iter()
        .map(|root| normalised(root))
        .any(|root| !root.is_empty() && (path == root || path.starts_with(&format!("{root}\\"))))
}

#[cfg(windows)]
fn mount_points() -> Vec<PathBuf> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};

    let Ok(providers) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Software\SyncEngines\Providers\OneDrive", KEY_READ)
    else {
        return Vec::new();
    };
    providers
        .enum_keys()
        .filter_map(std::result::Result::ok)
        .filter_map(|name| providers.open_subkey_with_flags(name, KEY_READ).ok())
        .filter_map(|key| key.get_value::<String, _>("MountPoint").ok())
        .filter(|mount| !mount.trim().is_empty())
        .map(PathBuf::from)
        .collect()
}

#[cfg(not(windows))]
fn mount_points() -> Vec<PathBuf> {
    Vec::new()
}

fn synced_roots() -> &'static [PathBuf] {
    static ROOTS: OnceLock<Vec<PathBuf>> = OnceLock::new();
    ROOTS.get_or_init(|| {
        let mut roots: Vec<PathBuf> = ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"]
            .iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .collect();
        roots.extend(mount_points());
        roots
    })
}

/// True when `path` is in a folder `OneDrive` syncs (personal, work, or a `SharePoint` library).
#[must_use]
pub fn is_synced(path: &Path) -> bool {
    inside_any(path, synced_roots())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_counts_as_synced_inside_a_root_but_not_beside_one() {
        let roots = [
            PathBuf::from(r"C:\Users\sam\Contoso\Guides - Documents"),
            PathBuf::from(r"C:\Users\sam\OneDrive - Contoso\"),
        ];
        assert!(inside_any(
            Path::new(r"c:\users\sam\contoso\guides - documents"),
            &roots
        ));
        assert!(inside_any(
            Path::new(r"C:\Users\sam\OneDrive - Contoso\Amluto Steps"),
            &roots
        ));
        assert!(inside_any(
            Path::new("C:/Users/sam/Contoso/Guides - Documents/Team"),
            &roots
        ));
        assert!(!inside_any(
            Path::new(r"C:\Users\sam\OneDrive - Contoso Old"),
            &roots
        ));
        assert!(!inside_any(Path::new(r"D:\Guides"), &roots));
        assert!(!inside_any(Path::new(r"D:\Guides"), &[PathBuf::new()]));
    }
}
