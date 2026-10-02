//! Opening files, folders and links with Windows' own handlers.

use std::path::Path;
use std::process::Command;

use crate::recorder::CommandError;

fn spawned(mut command: Command) -> Result<(), CommandError> {
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| CommandError::new("openFailed", error.to_string()))
}

/// Opens a file with its default app, or a folder in Explorer.
pub fn open_path(path: &Path) -> Result<(), CommandError> {
    let mut command = Command::new("explorer.exe");
    command.arg(path);
    spawned(command)
}

/// Opens the file's folder in Explorer with the file selected.
///
/// Explorer only understands `/select,"C:\a b\c.zip"`, with just the path quoted. The standard
/// argument quoting wraps the whole switch in quotes when the path has a space, which Explorer
/// ignores, opening Documents instead; so the argument is written out by hand. Windows paths
/// can't contain a quote, so the quoting can't be broken out of.
pub fn reveal(file: &Path) -> Result<(), CommandError> {
    let mut command = Command::new("explorer.exe");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.raw_arg(format!("/select,\"{}\"", file.display()));
    }
    #[cfg(not(windows))]
    command.arg(file);
    spawned(command)
}

/// Opens a `mailto:` or web link with the default handler. Explorer treats a link it doesn't
/// recognise as a folder to browse (and opens Documents), so the URL protocol handler is used.
///
/// The handler also opens files and programs, so only `mailto:` and `https:` links get to it.
pub fn open_link(url: &str) -> Result<(), CommandError> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("mailto:") || lower.starts_with("https://"))
        || url.chars().any(char::is_control)
    {
        return Err(CommandError::new(
            "openFailed",
            "Only email and web links can be opened.",
        ));
    }
    let mut command = Command::new("rundll32.exe");
    command.arg("url.dll,FileProtocolHandler").arg(url);
    spawned(command)
}

/// A page Settings > About may open: amluto.com, or an open-source component's own page. Only
/// these, so the window can't send the browser anywhere else.
fn web_page_url(page: &str, name: Option<&str>) -> Option<String> {
    let crate_name = |name: &str| {
        (1..=64).contains(&name.len())
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    };
    let npm_name = |name: &str| {
        let bare = name.strip_prefix('@').map_or(Some(name), |scoped| {
            scoped.split_once('/').and_then(|(scope, rest)| {
                (!scope.is_empty() && scope.chars().all(npm_char)).then_some(rest)
            })
        });
        bare.is_some_and(|bare| (1..=214).contains(&bare.len()) && bare.chars().all(npm_char))
    };
    match (page, name) {
        ("amluto", None) => Some("https://amluto.com".into()),
        ("steps", None) => Some("https://steps.amluto.com/#download".into()),
        // Steps' source code, which the GPL has it offer.
        ("source", None) => Some("https://github.com/amluto-solutions/steps".into()),
        ("crate", Some(name)) if crate_name(name) => {
            Some(format!("https://crates.io/crates/{name}"))
        }
        ("npm", Some(name)) if npm_name(name) => {
            Some(format!("https://www.npmjs.com/package/{name}"))
        }
        _ => None,
    }
}

fn npm_char(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '.' | '_' | '~')
}

/// Opens amluto.com or a component's page in the browser (Settings > About).
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands take their arguments by value"
)]
#[tauri::command(rename_all = "camelCase")]
pub fn open_web_page(page: String, name: Option<String>) -> Result<(), CommandError> {
    let url = web_page_url(&page, name.as_deref())
        .ok_or_else(|| CommandError::new("openFailed", "That page can't be opened."))?;
    open_link(&url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_email_and_web_links_reach_the_handler() {
        // Each of these is refused before anything is started.
        for url in [
            "file:///C:/Windows/System32/notepad.exe",
            r"C:\Windows\System32\calc.exe",
            "http://example.test",
            "javascript:alert(1)",
            "mailto:steps@amluto.com\r\ncalc",
        ] {
            assert!(open_link(url).is_err(), "{url} should be refused");
        }
    }

    #[test]
    fn about_opens_only_amluto_and_component_pages() {
        assert_eq!(
            web_page_url("amluto", None).as_deref(),
            Some("https://amluto.com")
        );
        assert_eq!(
            web_page_url("steps", None).as_deref(),
            Some("https://steps.amluto.com/#download")
        );
        assert_eq!(
            web_page_url("source", None).as_deref(),
            Some("https://github.com/amluto-solutions/steps")
        );
        assert_eq!(
            web_page_url("crate", Some("serde_json")).as_deref(),
            Some("https://crates.io/crates/serde_json")
        );
        assert_eq!(
            web_page_url("npm", Some("@tiptap/core")).as_deref(),
            Some("https://www.npmjs.com/package/@tiptap/core")
        );
        for (page, name) in [
            ("amluto", Some("x")),
            ("source", Some("x")),
            ("crate", Some("../../evil")),
            ("crate", Some("a b")),
            ("npm", Some("@/x")),
            ("npm", Some("x?y=1")),
            ("npm", Some("UPPER")),
            ("https://evil.test", None),
            ("npm", None),
        ] {
            assert_eq!(web_page_url(page, name), None, "{page} {name:?}");
        }
    }
}
