/// Errors from the X11 layer.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no X server to connect to: {0}")]
    NoDisplay(String),
    #[error("X server request failed: {0}")]
    X11(String),
    #[error("the X server has no {0} extension")]
    MissingExtension(&'static str),
    #[error("the input thread stopped before it was ready")]
    InputThreadGone,
    #[error("an input source is already running in this process")]
    AlreadyRunning,
    #[error("OCR could not read the image: {0}")]
    Ocr(String),
}

impl From<x11rb::errors::ConnectionError> for Error {
    fn from(error: x11rb::errors::ConnectionError) -> Self {
        Self::X11(error.to_string())
    }
}

impl From<x11rb::errors::ReplyError> for Error {
    fn from(error: x11rb::errors::ReplyError) -> Self {
        Self::X11(error.to_string())
    }
}

impl From<x11rb::errors::ReplyOrIdError> for Error {
    fn from(error: x11rb::errors::ReplyOrIdError) -> Self {
        Self::X11(error.to_string())
    }
}

impl From<x11rb::errors::ConnectError> for Error {
    fn from(error: x11rb::errors::ConnectError) -> Self {
        Self::NoDisplay(error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
