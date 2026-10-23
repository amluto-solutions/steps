//! Who is using Steps, and where it keeps their files: the name given in Settings (the author of
//! new guides and versions, the holder of an edit lock, the name on comments) and the app-data
//! folder (`%APPDATA%\Amluto\Steps`, or the portable copy's `Steps data`, `app_folder.rs`).
//!
//! One value for the whole app, managed as Tauri state. The recorder sets it up at start, from its
//! settings file (`recorder-settings.json`, which keeps the name with the default library's
//! folder), and changes the name when Settings saves; the recorder and the library both read it.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// A handle on the app-wide value; every clone reads and changes the same one.
#[derive(Debug, Clone, Default)]
pub struct User {
    known: Arc<Mutex<Known>>,
}

#[derive(Debug, Default)]
struct Known {
    app_data: Option<PathBuf>,
    display_name: String,
}

impl User {
    fn known(&self) -> MutexGuard<'_, Known> {
        self.known.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Sets up the app-data folder and the saved name with `find`, once. Anyone reading either
    /// meanwhile waits for it, since `find` reads the disk and a reader shouldn't take "not set up
    /// yet" for an answer. If `find` fails nothing is set, and a later call tries again; once it
    /// has succeeded, later calls change nothing and don't run `find`.
    ///
    /// `find` mustn't use this value: it's held while `find` runs.
    pub(crate) fn initialize<E>(
        &self,
        find: impl FnOnce() -> Result<(PathBuf, String), E>,
    ) -> Result<(), E> {
        let mut known = self.known();
        if known.app_data.is_some() {
            return Ok(());
        }
        let (app_data, display_name) = find()?;
        known.app_data = Some(app_data);
        known.display_name = display_name;
        Ok(())
    }

    /// The app-data folder, or `None` until set up (commands then answer `notReady`).
    pub(crate) fn app_data(&self) -> Option<PathBuf> {
        self.known().app_data.clone()
    }

    /// The name given in Settings; empty until one is given.
    pub(crate) fn display_name(&self) -> String {
        self.known().display_name.clone()
    }

    /// A name Settings has just saved (the recorder checks and trims it first).
    pub(crate) fn set_display_name(&self, display_name: String) {
        self.known().display_name = display_name;
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use super::User;

    #[test]
    fn before_initialize_there_is_no_app_data_folder_and_no_name() {
        let user = User::default();
        assert_eq!(user.app_data(), None);
        assert_eq!(user.display_name(), "");
    }

    #[test]
    fn initialize_gives_every_holder_the_app_data_folder_and_the_saved_name() {
        let recorder = User::default();
        let library = recorder.clone();
        let folder = PathBuf::from("C:/Users/Robin/AppData/Roaming/Amluto/Steps");

        recorder
            .initialize(|| Ok::<_, String>((folder.clone(), "Robin".to_string())))
            .unwrap();

        assert_eq!(library.app_data(), Some(folder));
        assert_eq!(library.display_name(), "Robin");
    }

    #[test]
    fn only_the_first_initialize_that_succeeds_counts() {
        let user = User::default();
        let folder = PathBuf::from("C:/Users/Robin/AppData/Roaming/Amluto/Steps");

        // A set-up that fails leaves nothing, so commands go on saying "not ready".
        assert_eq!(
            user.initialize(|| Err::<(PathBuf, String), _>("no app-data folder")),
            Err("no app-data folder")
        );
        assert_eq!(user.app_data(), None);

        user.initialize(|| Ok::<_, &str>((folder.clone(), "Robin".to_string())))
            .unwrap();
        let mut asked = false;
        user.initialize(|| {
            asked = true;
            Ok::<_, &str>((PathBuf::from("D:/Elsewhere"), "Sam".to_string()))
        })
        .unwrap();

        assert!(!asked);
        assert_eq!(user.app_data(), Some(folder));
        assert_eq!(user.display_name(), "Robin");
    }

    #[test]
    fn a_reader_waits_for_a_set_up_in_progress() {
        // The set-up reads the disk. A library command arriving meanwhile waits for it, rather
        // than answering "not ready" or taking an empty name for the guide's author.
        let user = User::default();
        let reader = user.clone();
        let folder = PathBuf::from("C:/Users/Robin/AppData/Roaming/Amluto/Steps");
        let (send, answer) = mpsc::channel();
        let mut waited = false;

        user.initialize(|| {
            thread::spawn(move || send.send((reader.app_data(), reader.display_name())));
            waited = answer.recv_timeout(Duration::from_millis(100)).is_err();
            Ok::<_, String>((folder.clone(), "Robin".to_string()))
        })
        .unwrap();

        assert!(waited);
        assert_eq!(answer.recv().unwrap(), (Some(folder), "Robin".to_string()));
    }

    #[test]
    fn a_name_saved_in_settings_reaches_every_holder_and_the_folder_stays() {
        let recorder = User::default();
        let library = recorder.clone();
        let folder = PathBuf::from("C:/Users/Robin/AppData/Roaming/Amluto/Steps");
        recorder
            .initialize(|| Ok::<_, String>((folder.clone(), String::new())))
            .unwrap();

        recorder.set_display_name("Robin".to_string());

        assert_eq!(library.display_name(), "Robin");
        assert_eq!(library.app_data(), Some(folder));
    }
}
