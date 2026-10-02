//! What Steps for Chrome and Edge and the app say to each other, and how
//! (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together). Each message is JSON
//! after its length in 4 bytes, the browser's native messaging format, used unchanged on the
//! app's pipe too, so the relay passes messages on without reading them.
use std::io;

use capture::facts::PageTarget;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The protocol both ends speak. A different number from the extension ends the connection.
pub const PROTOCOL: u32 = 1;

/// The largest message either way: far more than a click's facts need.
pub const MAX_MESSAGE: usize = 64 * 1024;

/// How long before it reached the app a click can have happened and still count.
const MAX_AGE_MS: u32 = 10_000;

/// The browser a connection comes from, told apart by its program.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Browser {
    Chrome,
    Edge,
}

impl Browser {
    /// The browser a window's program is (`chrome.exe`, `msedge.exe`), if either.
    #[must_use]
    pub fn of_program(exe: Option<&str>) -> Option<Self> {
        match exe?.to_ascii_lowercase().as_str() {
            "chrome.exe" => Some(Self::Chrome),
            "msedge.exe" => Some(Self::Edge),
            _ => None,
        }
    }
}

/// A message from Steps for Chrome or Edge. Anything else is ignored.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum FromBrowser {
    /// The first message: which protocol, from which browser.
    #[serde(rename_all = "camelCase")]
    Hello {
        protocol: u32,
        browser: Browser,
        version: String,
    },
    /// A pointer went down in a web page while the app was recording: the element's step facts,
    /// the tab's title (to tell which window it was in; never kept) and how long ago it was.
    #[serde(rename_all = "camelCase")]
    Click {
        age_ms: u32,
        title: String,
        target: Option<Box<PageTarget>>,
    },
}

impl FromBrowser {
    /// A message, if it is one and within every limit.
    #[must_use]
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let message: Self = serde_json::from_slice(bytes).ok()?;
        let within = match &message {
            Self::Hello { version, .. } => version.chars().count() <= 40,
            Self::Click {
                age_ms,
                title,
                target,
            } => {
                *age_ms <= MAX_AGE_MS
                    && title.chars().count() <= PageTarget::MAX_CHARS
                    && target.as_deref().is_none_or(PageTarget::within_limits)
            }
        };
        within.then_some(message)
    }
}

/// A message to Steps for Chrome or Edge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ToBrowser {
    /// The app's answer to the extension's hello.
    Hello { protocol: u32, version: String },
    /// Whether the app is recording: while it is, the extension reports clicks in pages.
    Recording { on: bool },
    /// From the relay itself: there's no app to connect to (it isn't running).
    Unavailable { reason: &'static str },
}

impl ToBrowser {
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }
}

/// Reads one message's bytes; `None` when the other end has closed.
///
/// # Errors
/// When reading fails, or a message is larger than [`MAX_MESSAGE`].
pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut length = [0u8; 4];
    match reader.read_exact(&mut length).await {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    // Native byte order, as the browser writes it.
    let length = usize::try_from(u32::from_ne_bytes(length)).unwrap_or(usize::MAX);
    if length > MAX_MESSAGE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "a message larger than the link allows",
        ));
    }
    let mut bytes = vec![0u8; length];
    reader.read_exact(&mut bytes).await?;
    Ok(Some(bytes))
}

/// Writes one message.
///
/// # Errors
/// When writing fails, or the message is larger than [`MAX_MESSAGE`].
pub async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, bytes: &[u8]) -> io::Result<()> {
    let length = u32::try_from(bytes.len())
        .ok()
        .filter(|_| bytes.len() <= MAX_MESSAGE)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "a message larger than the link allows",
            )
        })?;
    writer.write_all(&length.to_ne_bytes()).await?;
    writer.write_all(bytes).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run<T>(work: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(work)
    }

    #[test]
    fn messages_are_framed_as_the_browser_frames_them() {
        run(async {
            let mut bytes = Vec::new();
            write_frame(&mut bytes, br#"{"type":"recording","on":true}"#)
                .await
                .unwrap();
            assert_eq!(&bytes[..4], &30u32.to_ne_bytes());
            let mut reader = bytes.as_slice();
            assert_eq!(
                read_frame(&mut reader).await.unwrap().unwrap(),
                br#"{"type":"recording","on":true}"#
            );
            // The other end closed, even halfway through a length.
            assert!(read_frame(&mut reader).await.unwrap().is_none());
            assert!(read_frame(&mut &[1u8, 0][..]).await.unwrap().is_none());
        });
    }

    #[test]
    fn a_message_too_large_is_refused_both_ways() {
        run(async {
            let huge = vec![b' '; MAX_MESSAGE + 1];
            assert!(write_frame(&mut Vec::new(), &huge).await.is_err());
            let length = u32::try_from(MAX_MESSAGE + 1).unwrap().to_ne_bytes();
            assert!(read_frame(&mut &length[..]).await.is_err());
            // A length the other end never sends in full is an error, not a hang.
            let mut short = 10u32.to_ne_bytes().to_vec();
            short.extend_from_slice(b"abc");
            assert!(read_frame(&mut short.as_slice()).await.is_err());
        });
    }

    #[test]
    fn the_browsers_messages_are_read_strictly() {
        assert_eq!(
            FromBrowser::parse(
                br#"{"type":"hello","protocol":1,"browser":"edge","version":"0.4.2"}"#
            ),
            Some(FromBrowser::Hello {
                protocol: 1,
                browser: Browser::Edge,
                version: "0.4.2".into()
            })
        );
        let click = FromBrowser::parse(
            br#"{"type":"click","ageMs":35,"title":"Invoices","target":{"tagName":"BUTTON","innerText":"Approve invoice"}}"#,
        );
        let Some(FromBrowser::Click { age_ms, target, .. }) = click else {
            panic!("not a click: {click:?}");
        };
        assert_eq!(age_ms, 35);
        assert_eq!(
            target.unwrap().inner_text.as_deref(),
            Some("Approve invoice")
        );
        // Unknown kinds, unknown facts, missing facts and anything over a limit are ignored.
        for refused in [
            r#"{"type":"typing","text":"secret"}"#.to_string(),
            r#"{"type":"click","ageMs":1,"title":"","target":null,"value":"x"}"#.to_string(),
            r#"{"type":"click","ageMs":1,"title":"","target":{"password":"x"}}"#.to_string(),
            r#"{"type":"click","title":"","target":null}"#.to_string(),
            r#"{"type":"click","ageMs":60000,"title":"","target":null}"#.to_string(),
            format!(
                r#"{{"type":"click","ageMs":1,"title":"","target":{{"innerText":"{}"}}}}"#,
                "x".repeat(2_001)
            ),
            r#"{"type":"hello","protocol":1,"browser":"firefox","version":"1"}"#.to_string(),
            "not json".to_string(),
        ] {
            assert_eq!(FromBrowser::parse(refused.as_bytes()), None, "{refused}");
        }
    }

    #[test]
    fn the_browser_is_told_apart_by_its_program() {
        assert_eq!(
            Browser::of_program(Some("Chrome.exe")),
            Some(Browser::Chrome)
        );
        assert_eq!(Browser::of_program(Some("msedge.exe")), Some(Browser::Edge));
        assert_eq!(Browser::of_program(Some("firefox.exe")), None);
        assert_eq!(Browser::of_program(None), None);
    }

    #[test]
    fn the_apps_messages_are_what_the_extension_reads() {
        assert_eq!(
            ToBrowser::Recording { on: true }.encode(),
            br#"{"type":"recording","on":true}"#
        );
        assert_eq!(
            ToBrowser::Unavailable {
                reason: "notRunning"
            }
            .encode(),
            br#"{"type":"unavailable","reason":"notRunning"}"#
        );
    }
}
