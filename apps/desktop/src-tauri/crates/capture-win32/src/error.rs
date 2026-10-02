/// Errors from the Win32 layer.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Windows call failed: {0}")]
    Windows(#[from] windows::core::Error),
    #[error("the input thread stopped before it was ready")]
    InputThreadGone,
    #[error("an input source is already running in this process")]
    AlreadyRunning,
    #[error("OCR could not read the image: {0}")]
    Ocr(String),
}

pub type Result<T> = std::result::Result<T, Error>;
