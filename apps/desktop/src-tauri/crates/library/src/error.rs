//! The one error type for library operations. Each variant has a stable camelCase `code` for the
//! UI and a plain-English message a person can act on.

/// Everything a library operation can fail with.
#[derive(Debug, thiserror::Error)]
pub enum LibraryError {
    /// An id from the UI (library, guide, step, media, version or bin entry) isn't a safe
    /// folder or file name. The payload names the kind of id.
    #[error("The {0} id is invalid.")]
    InvalidId(&'static str),
    /// The request itself doesn't make sense (an empty name, a relative path…).
    #[error("{0}")]
    Invalid(String),
    /// No library with that id is registered.
    #[error("That library isn't in your list of libraries.")]
    LibraryNotFound,
    /// The folder is already registered as a library.
    #[error("That folder is already one of your libraries.")]
    LibraryExists,
    /// Removing the default library would leave new recordings nowhere to go.
    #[error("The default library can't be removed. Make another library the default first.")]
    DefaultLibrary,
    /// No guide with that id is in the library.
    #[error("The guide was not found. It may have been moved or deleted.")]
    GuideNotFound,
    /// A guide with that id is already in the library.
    #[error("A guide with this id already exists in the library.")]
    GuideExists,
    /// No saved version with that id.
    #[error("That version of the guide was not found.")]
    VersionNotFound,
    /// No bin entry with that id.
    #[error("That guide is no longer in the bin.")]
    TrashNotFound,
    /// No image with that id in the guide.
    #[error("The image was not found.")]
    ImageNotFound,
    /// A file has a `formatVersion` this app doesn't understand.
    #[error("This guide was made by a newer version of Steps.")]
    NewerFormat,
    /// An image was the wrong format, too large or damaged.
    #[error("This image can't be used: {0}")]
    UnsupportedImage(String),
    /// An `.amlsteps` file broke one of the hostile-file rules. The payload names the rule.
    #[error("This file can't be imported: {0}")]
    ImportRejected(String),
    /// A move copied the guide but couldn't put the original in the bin, so both exist.
    #[error("The guide was copied, but the original could not be moved to the bin: {0}")]
    MoveIncomplete(String),
    /// "Apply blur permanently" burned the blur in and pointed every step at the copies, but
    /// this many originals couldn't be deleted yet (another program has them open).
    #[error("The blur is burned in, but {0} original screenshots couldn't be deleted yet.")]
    OriginalsLeft(usize),
    /// A file couldn't be read or written.
    #[error("Steps could not read or write the library: {0}")]
    Storage(#[from] std::io::Error),
    /// A JSON file in the library is damaged.
    #[error("A file in the library is damaged: {0}")]
    Json(#[from] serde_json::Error),
}

impl LibraryError {
    /// The stable code the UI switches on.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidId(_) => "invalidId",
            Self::Invalid(_) => "invalidRequest",
            Self::LibraryNotFound => "libraryNotFound",
            Self::LibraryExists => "libraryExists",
            Self::DefaultLibrary => "defaultLibrary",
            Self::GuideNotFound => "guideNotFound",
            Self::GuideExists => "guideExists",
            Self::VersionNotFound => "versionNotFound",
            Self::TrashNotFound => "trashNotFound",
            Self::ImageNotFound => "imageNotFound",
            Self::NewerFormat => "newerFormat",
            Self::UnsupportedImage(_) => "unsupportedImage",
            Self::ImportRejected(_) => "importRejected",
            Self::MoveIncomplete(_) => "moveIncomplete",
            Self::OriginalsLeft(_) => "originalsLeft",
            Self::Storage(_) => "storageError",
            Self::Json(_) => "damagedFile",
        }
    }

    /// Shorthand for an import rejection naming the rule that failed.
    pub(crate) fn rejected(rule: impl Into<String>) -> Self {
        Self::ImportRejected(rule.into())
    }
}

/// Result alias for library operations.
pub type Result<T> = std::result::Result<T, LibraryError>;
