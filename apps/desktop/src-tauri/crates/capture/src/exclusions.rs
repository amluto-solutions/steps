//! Which programs and windows are an excluded app's (docs/spec/02-capture.md#special-cases): one
//! judgement for clicks, pre-reads and screenshots, so a pop-up an excluded app's window owns is
//! kept out of all of them alike (#103, #110).

/// Whether `name`, a program's file name, is on the `excluded` list (program file names in any
/// case, perhaps with spaces round them).
pub(crate) fn is_listed(excluded: &[String], name: &str) -> bool {
    excluded
        .iter()
        .any(|app| app.trim().eq_ignore_ascii_case(name))
}

/// Whether a program, by the file name of its process, is kept out of the recording: one on the
/// `excluded` list. A program that can't be named (`None`: its process refused the query) can't
/// be shown not to be excluded, so while anything is excluded it is treated as excluded.
pub(crate) fn is_excluded_program(excluded: &[String], name: Option<&str>) -> bool {
    name.map_or_else(|| !excluded.is_empty(), |name| is_listed(excluded, name))
}

/// Whether a top-level window of process `pid` is owned by an excluded app's window (#103): a
/// pop-up (a drop-down list, a menu) is a top-level window of its own, which another program may
/// draw, as a web view draws its drop-downs and menus (`msedgewebview2.exe` for Teams or the new
/// Outlook), but it belongs to the app whose window opened it. `owners` are the processes of the
/// windows up its owners (`owner_processes_at`, `owner_processes_of`), whether or not those are
/// showing; `is_excluded` judges a process, and is asked only for one other than the window's
/// own, which is judged by its window.
pub(crate) fn is_owned_by_excluded(
    pid: u32,
    owners: &[u32],
    mut is_excluded: impl FnMut(u32) -> bool,
) -> bool {
    owners
        .iter()
        .filter(|&&owner| owner != pid)
        .any(|&owner| is_excluded(owner))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_program_is_excluded_by_its_file_name_in_any_case() {
        let excluded = vec!["keepass.exe".to_string(), " ms-teams.exe ".to_string()];
        assert!(is_excluded_program(&excluded, Some("KeePass.exe")));
        assert!(is_excluded_program(&excluded, Some("ms-teams.exe")));
        assert!(!is_excluded_program(&excluded, Some("notepad.exe")));
    }

    #[test]
    fn a_program_that_cant_be_named_is_excluded_only_while_anything_is() {
        assert!(is_excluded_program(&["keepass.exe".to_string()], None));
        assert!(!is_excluded_program(&[], None));
    }

    #[test]
    fn a_window_is_an_excluded_apps_when_any_owner_is_and_its_own_process_is_not_asked() {
        let mut asked = Vec::new();
        let teams = 20;
        let mut is_excluded = |pid: u32| {
            asked.push(pid);
            pid == teams
        };
        assert!(is_owned_by_excluded(30, &[30, 40, teams], &mut is_excluded));
        assert!(!is_owned_by_excluded(30, &[30, 40], &mut is_excluded));
        assert!(!is_owned_by_excluded(30, &[], &mut is_excluded));
        // The window's own process is judged by its window, never as an owner.
        assert!(!asked.contains(&30));
    }
}
