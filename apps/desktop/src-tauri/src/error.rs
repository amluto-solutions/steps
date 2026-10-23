//! The error every Tauri command returns: `{ code, message }`. The window words it from its code
//! (`errors.<code>` in en.json; `error-codes.test.ts` checks every code the app sends has words
//! there), and the message is only the detail it may show.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    code: &'static str,
    message: String,
}

impl CommandError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// The error code, for tests in other modules.
    #[cfg(test)]
    pub(crate) fn code(&self) -> &str {
        self.code
    }
}

/// A file the app couldn't read or write, with the system's reason as the detail.
pub(crate) fn storage_error(error: impl std::fmt::Display) -> CommandError {
    CommandError::new("storageError", error.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{CommandError, storage_error};

    #[test]
    fn a_command_error_reaches_the_window_as_its_code_and_message() {
        assert_eq!(
            serde_json::to_value(CommandError::new(
                "notReady",
                "The library list is not loaded."
            ))
            .unwrap(),
            json!({ "code": "notReady", "message": "The library list is not loaded." })
        );
    }

    #[test]
    fn a_file_that_cant_be_read_or_written_keeps_its_cause_as_the_message() {
        assert_eq!(
            serde_json::to_value(storage_error("The disk is full.")).unwrap(),
            json!({ "code": "storageError", "message": "The disk is full." })
        );
    }
}
