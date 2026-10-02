//! The program Chrome or Edge starts for Steps for Chrome: this program, given the extension's
//! address (`chrome-extension://<id>/`) as its first argument. It opens no window and writes no
//! file: it passes messages between the browser (its standard input and output) and the running
//! app (the link's pipe), unread, until either end closes
//! (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together).

/// Whether the browser started this program to relay for Steps for Chrome.
#[must_use]
pub fn started_by_browser() -> bool {
    cfg!(windows)
        && std::env::args()
            .nth(1)
            .is_some_and(|argument| argument.starts_with("chrome-extension://"))
}

/// Relays until either end closes; the program's exit code.
#[must_use]
pub fn relay() -> i32 {
    #[cfg(windows)]
    {
        windows::relay()
    }
    #[cfg(not(windows))]
    {
        1
    }
}

#[cfg(windows)]
mod windows {
    use std::os::windows::io::AsHandle;
    use std::time::Duration;

    use tokio::io::{AsyncRead, AsyncWrite};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

    use super::super::protocol::{ToBrowser, read_frame, write_frame};

    /// Windows' "all pipe instances are busy": another browser is connecting at this moment.
    const ERROR_PIPE_BUSY: i32 = 231;

    pub(super) fn relay() -> i32 {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
        else {
            return 1;
        };
        let code = runtime.block_on(async {
            let mut stdout = tokio::io::stdout();
            let pipe = match open_app().await {
                Ok(pipe) => pipe,
                Err(reason) => {
                    // The extension says so in its Settings, and tries again later.
                    let unavailable = ToBrowser::Unavailable { reason }.encode();
                    let _ = write_frame(&mut stdout, &unavailable).await;
                    return 0;
                }
            };
            let (mut from_app, mut to_app) = tokio::io::split(pipe);
            let mut stdin = tokio::io::stdin();
            let mut both = tokio::task::JoinSet::new();
            both.spawn(async move { pass_on(&mut stdin, &mut to_app).await });
            both.spawn(async move { pass_on(&mut from_app, &mut stdout).await });
            // Either end closing ends the relay.
            let _ = both.join_next().await;
            0
        });
        // The read waiting on standard input would otherwise hold the program open.
        runtime.shutdown_background();
        code
    }

    /// The running app's end of the link, if it's there and runs as this person.
    async fn open_app() -> Result<NamedPipeClient, &'static str> {
        let name = super::super::pipe_name().ok_or("notRunning")?;
        for _ in 0..40 {
            match ClientOptions::new().open(&name) {
                // Someone else's pipe of the same name is as good as none: nothing is sent to it.
                Ok(pipe) if capture::platform::pipe::server_is_same_user(pipe.as_handle()) => {
                    return Ok(pipe);
                }
                Ok(_) => {
                    eprintln!("Steps: the link's pipe belongs to another account");
                    return Err("notRunning");
                }
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(_) => return Err("notRunning"),
            }
        }
        Err("notRunning")
    }

    /// Passes whole messages on, each checked for size, until the reading end closes.
    async fn pass_on<R, W>(from: &mut R, to: &mut W)
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        while let Ok(Some(bytes)) = read_frame(from).await {
            if write_frame(to, &bytes).await.is_err() {
                break;
            }
        }
    }
}
