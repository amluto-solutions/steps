//! The app's end of the link: the pipe the relay opens for each browser, open to this person's
//! account only (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together).
use std::os::windows::io::AsHandle;
use std::time::Duration;

use capture::platform::pipe::{client_is_same_user, private_server};
use tauri::AppHandle;
use tauri::async_runtime::JoinHandle;
use tokio::net::windows::named_pipe::NamedPipeServer;
use tokio::sync::mpsc::UnboundedReceiver;

use super::BrowserLink;
use super::protocol::{FromBrowser, PROTOCOL, ToBrowser, read_frame, write_frame};

/// How long the extension has to say hello before the connection is closed.
const HELLO_WITHIN: Duration = Duration::from_secs(5);

/// Listens until stopped (the task is aborted) or the pipe can't be made.
pub(super) fn start(app: AppHandle, link: BrowserLink) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        if let Err(problem) = serve(&app, &link).await {
            link.set_problem(&app, problem);
        }
    })
}

async fn serve(app: &AppHandle, link: &BrowserLink) -> Result<(), &'static str> {
    let name = super::pipe_name().ok_or("pipe")?;
    // The first instance: if the name is taken (another Steps, or someone else's pipe), the link
    // stays off rather than sharing it.
    let mut listening = private_server(&name, true).map_err(|error| {
        log::warn!("the browser link's pipe couldn't be made: {error}");
        "pipeTaken"
    })?;
    log::info!("the browser link is listening");
    loop {
        listening.connect().await.map_err(|error| {
            log::warn!("the browser link stopped listening: {error}");
            "pipe"
        })?;
        let next = private_server(&name, false).map_err(|error| {
            log::warn!("the browser link couldn't listen again: {error}");
            "pipe"
        })?;
        let connected = std::mem::replace(&mut listening, next);
        link.accept(app, connected);
    }
}

/// One browser's connection, until it closes or the link is switched off.
pub(super) async fn client(
    app: AppHandle,
    link: BrowserLink,
    id: u64,
    pipe: NamedPipeServer,
    mut outbox: UnboundedReceiver<ToBrowser>,
) {
    // The pipe lets no one else in; checked again all the same.
    if !client_is_same_user(pipe.as_handle()) {
        log::warn!("the browser link refused a program running as someone else");
        link.drop_client(&app, id);
        return;
    }
    let (mut reader, mut writer) = tokio::io::split(pipe);
    let writing = tauri::async_runtime::spawn(async move {
        while let Some(message) = outbox.recv().await {
            if write_frame(&mut writer, &message.encode()).await.is_err() {
                break;
            }
        }
    });
    // The extension speaks first; the app answers with its own hello, then whether it's
    // recording. A different protocol hears the app's hello (so the extension can say which
    // side to update) and is closed.
    let hello = tokio::time::timeout(HELLO_WITHIN, read_frame(&mut reader)).await;
    let browser = match hello {
        Ok(Ok(Some(bytes))) => match FromBrowser::parse(&bytes) {
            Some(FromBrowser::Hello {
                protocol, browser, ..
            }) => {
                link.send(
                    id,
                    ToBrowser::Hello {
                        protocol: PROTOCOL,
                        version: app.package_info().version.to_string(),
                    },
                );
                (protocol == PROTOCOL).then_some(browser)
            }
            _ => None,
        },
        _ => None,
    };
    if let Some(browser) = browser {
        link.hello(&app, id, browser);
        while let Ok(Some(bytes)) = read_frame(&mut reader).await {
            // Anything else, or anything over a limit, is ignored.
            if let Some(FromBrowser::Click {
                age_ms,
                title,
                target,
            }) = FromBrowser::parse(&bytes)
            {
                link.add_click(browser, age_ms, title, target.map(|target| *target));
            }
        }
    }
    // Let the hello reach a browser speaking another protocol before closing.
    tokio::time::sleep(Duration::from_millis(100)).await;
    writing.abort();
    link.drop_client(&app, id);
}
