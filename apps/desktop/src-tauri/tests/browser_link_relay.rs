//! The program as Chrome starts it for Steps for Chrome: a relay between the browser (its standard
//! input and output) and the app's pipe (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together).
//! A development build meets the pipe named by `AMLUTO_STEPS_LINK_PIPE`, so a running Steps
//! isn't disturbed.
#![cfg(windows)]
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "tests")]

use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn frame(message: &str) -> Vec<u8> {
    let mut bytes = u32::try_from(message.len()).unwrap().to_ne_bytes().to_vec();
    bytes.extend_from_slice(message.as_bytes());
    bytes
}

fn read_message(reader: &mut impl Read) -> Option<String> {
    let mut length = [0u8; 4];
    reader.read_exact(&mut length).ok()?;
    let mut bytes = vec![0u8; usize::try_from(u32::from_ne_bytes(length)).unwrap()];
    reader.read_exact(&mut bytes).ok()?;
    String::from_utf8(bytes).ok()
}

async fn read_message_async(reader: &mut (impl AsyncReadExt + Unpin)) -> Option<String> {
    let mut length = [0u8; 4];
    reader.read_exact(&mut length).await.ok()?;
    let mut bytes = vec![0u8; usize::try_from(u32::from_ne_bytes(length)).unwrap()];
    reader.read_exact(&mut bytes).await.ok()?;
    String::from_utf8(bytes).ok()
}

/// The program as the browser starts it: the extension's address, then the parent window.
fn start_relay(pipe: &str) -> Child {
    Command::new(env!("CARGO_BIN_EXE_amluto-steps"))
        .args([
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
            "--parent-window=0",
        ])
        .env("AMLUTO_STEPS_LINK_PIPE", pipe)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

#[test]
fn with_no_app_running_the_browser_hears_so_and_the_relay_ends() {
    let pipe = format!(
        r"\\.\pipe\amluto-steps-relay-test-none-{}",
        std::process::id()
    );
    let mut relay = start_relay(&pipe);
    let mut stdout = relay.stdout.take().unwrap();
    assert_eq!(
        read_message(&mut stdout).as_deref(),
        Some(r#"{"type":"unavailable","reason":"notRunning"}"#)
    );
    assert!(relay.wait().unwrap().success());
}

#[test]
fn messages_pass_both_ways_unchanged_until_the_browser_closes() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let pipe = format!(r"\\.\pipe\amluto-steps-relay-test-{}", std::process::id());
    runtime.block_on(async {
        let server = capture::platform::pipe::private_server(&pipe, true).unwrap();
        let mut relay = start_relay(&pipe);
        server.connect().await.unwrap();
        let (mut from_relay, mut to_relay) = tokio::io::split(server);

        let mut stdin = relay.stdin.take().unwrap();
        let mut stdout = relay.stdout.take().unwrap();
        // Browser to app.
        let hello = r#"{"type":"hello","protocol":1,"browser":"chrome","version":"0.4.3"}"#;
        stdin.write_all(&frame(hello)).unwrap();
        stdin.flush().unwrap();
        assert_eq!(
            read_message_async(&mut from_relay).await.as_deref(),
            Some(hello)
        );
        // App to browser, while the browser's side is still open for reading.
        let recording = r#"{"type":"recording","on":true}"#;
        to_relay.write_all(&frame(recording)).await.unwrap();
        let heard = tokio::task::spawn_blocking(move || (read_message(&mut stdout), stdout))
            .await
            .unwrap();
        assert_eq!(heard.0.as_deref(), Some(recording));

        // A message over the limit ends the relay rather than reaching the app.
        stdin
            .write_all(&u32::try_from(64 * 1024 + 1).unwrap().to_ne_bytes())
            .unwrap();
        stdin.flush().unwrap();
        let status = tokio::task::spawn_blocking(move || relay.wait().unwrap())
            .await
            .unwrap();
        assert!(status.success());
        assert_eq!(read_message_async(&mut from_relay).await, None);
    });
}
