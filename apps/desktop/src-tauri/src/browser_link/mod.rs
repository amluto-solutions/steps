//! Steps for Chrome and Edge and the desktop together
//! (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together). While the app records,
//! the extension on the same PC says what each click in a web page was, and the app words its own
//! step for that click from the page's facts instead of UI Automation's. What the browser says
//! never makes a step: it only rewords a click the app recorded itself.
//!
//! - `host`: the program the browser starts (this one), a relay and nothing else.
//! - `server`: the app's end of the link's pipe.
//! - `protocol`: the messages, the same on both sides of the relay.
//! - `clicks`: the browser's clicks waiting to meet the app's.
//! - `register`: the host's manifest and the browsers' registry keys.
//!
//! Windows only for now, and not in the Microsoft Store package (decisions: Distribution and IT).
#![allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands receive owned values across IPC."
)]
// On Linux the link is compiled (so it keeps building there) but never started: no pipe, no relay.
#![cfg_attr(
    not(windows),
    allow(dead_code, reason = "the link runs on Windows only, for now")
)]
mod clicks;
pub mod host;
mod protocol;
#[cfg(windows)]
mod register;
#[cfg(windows)]
mod server;

use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use capture::facts::{ClickRecord, PageDetails, PageTarget};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use clicks::{PageClick, PageClicks};
pub use protocol::Browser;
use protocol::ToBrowser;

/// How long after the app's press a click from the browser may still arrive. The page reports it
/// as the pointer goes down, but by way of the extension and the relay.
const WAIT_MS: u32 = 250;

/// Tells the Settings screens the link's state changed.
const STATE_EVENT: &str = "browser-link:state";

/// The pipe the relay and the app meet at: one for each person and Windows session.
#[cfg(windows)]
fn pipe_name() -> Option<String> {
    // Development builds can be pointed at another, so tests don't meet a running Steps.
    #[cfg(debug_assertions)]
    if let Ok(name) = std::env::var("AMLUTO_STEPS_LINK_PIPE") {
        return Some(name);
    }
    let sid = capture::platform::pipe::user_sid()?;
    let session = capture::platform::pipe::session_id()?;
    Some(format!(r"\\.\pipe\com.amluto.steps.link.{sid}.{session}"))
}

/// What Settings shows about the link.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    /// Whether this copy can link at all: Windows, and not the Microsoft Store package.
    pub available: bool,
    pub enabled: bool,
    /// The browsers connected now.
    pub connected: Vec<Browser>,
    /// Why it isn't working, when it isn't: `register` (the browsers couldn't be told where
    /// Steps is), `pipeTaken` (another Steps has the link) or `pipe`.
    pub problem: Option<&'static str>,
}

struct Client {
    id: u64,
    /// Known once the extension has said hello.
    browser: Option<Browser>,
    send: tokio::sync::mpsc::UnboundedSender<ToBrowser>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Default)]
struct LinkState {
    enabled: bool,
    recording: bool,
    problem: Option<&'static str>,
    clients: Vec<Client>,
    next_client: u64,
    server: Option<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Default)]
struct Shared {
    state: Mutex<LinkState>,
    clicks: Mutex<PageClicks>,
    /// Signalled as each click arrives, for a press waiting for its own.
    arrived: Condvar,
}

/// The link, kept as the app's state.
#[derive(Default, Clone)]
pub struct BrowserLink {
    shared: Arc<Shared>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Whether this copy can link: Windows, outside the Microsoft Store package, and once Steps for
/// Chrome's store id is known (until then no browser would start the host, so Settings doesn't
/// offer it and nothing is registered).
fn available() -> bool {
    #[cfg(windows)]
    {
        !register::EXTENSION_IDS.is_empty() && capture::platform::package_full_name().is_none()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn now_tick() -> u32 {
    capture::platform::display::now_tick()
}

impl BrowserLink {
    #[must_use]
    pub fn status(&self) -> LinkStatus {
        let state = lock(&self.shared.state);
        let mut connected: Vec<Browser> = state
            .clients
            .iter()
            .filter_map(|client| client.browser)
            .collect();
        connected.sort_by_key(|browser| *browser as u8);
        connected.dedup();
        LinkStatus {
            available: available(),
            enabled: state.enabled,
            connected,
            problem: state.problem,
        }
    }

    fn changed(&self, app: &AppHandle) {
        let _ = app.emit(STATE_EVENT, self.status());
    }

    /// Switches the link on or off: tells the browsers where Steps is and listens, or stops and
    /// takes the registration back.
    #[must_use]
    pub fn set(&self, app: &AppHandle, on: bool) -> LinkStatus {
        if !available() {
            return self.status();
        }
        #[cfg(windows)]
        if on {
            self.switch_on(app);
        } else {
            self.switch_off(app);
        }
        #[cfg(not(windows))]
        let _ = (app, on);
        self.changed(app);
        self.status()
    }

    #[cfg(windows)]
    fn manifest_path(app: &AppHandle) -> Option<std::path::PathBuf> {
        crate::app_folder::local_folder(app).ok().map(|folder| {
            folder
                .join("browser-link")
                .join(format!("{}.json", register::HOST_NAME))
        })
    }

    #[cfg(windows)]
    fn switch_on(&self, app: &AppHandle) {
        // Written each time: the portable program may have moved since.
        let registered = Self::manifest_path(app)
            .zip(std::env::current_exe().ok())
            .ok_or_else(|| "no folder for the manifest".to_string())
            .and_then(|(manifest, program)| {
                register::register(
                    &manifest,
                    &program,
                    register::EXTENSION_IDS,
                    &register::BROWSER_KEYS,
                )
                .map_err(|error| error.to_string())
            });
        let mut state = lock(&self.shared.state);
        if let Err(error) = registered {
            log::warn!("the browser link couldn't be registered: {error}");
            state.problem = Some("register");
            return;
        }
        state.enabled = true;
        if state.server.is_none() {
            state.problem = None;
            state.server = Some(server::start(app.clone(), self.clone()));
        }
    }

    #[cfg(windows)]
    fn switch_off(&self, app: &AppHandle) {
        {
            let mut state = lock(&self.shared.state);
            state.enabled = false;
            state.problem = None;
            if let Some(server) = state.server.take() {
                server.abort();
            }
            // Each connection's task holds its pipe; the writer ends as its sender goes.
            for client in state.clients.drain(..) {
                if let Some(task) = client.task {
                    task.abort();
                }
            }
        }
        if let Some(manifest) = Self::manifest_path(app) {
            register::unregister(&manifest, &register::BROWSER_KEYS);
        }
    }

    #[cfg(windows)]
    fn set_problem(&self, app: &AppHandle, problem: &'static str) {
        {
            let mut state = lock(&self.shared.state);
            state.problem = Some(problem);
            state.server = None;
        }
        self.changed(app);
    }

    /// A browser opened the pipe: its own task, until it closes.
    #[cfg(windows)]
    fn accept(&self, app: &AppHandle, pipe: tokio::net::windows::named_pipe::NamedPipeServer) {
        let (send, outbox) = tokio::sync::mpsc::unbounded_channel();
        let mut state = lock(&self.shared.state);
        state.next_client += 1;
        let id = state.next_client;
        let task = tauri::async_runtime::spawn(server::client(
            app.clone(),
            self.clone(),
            id,
            pipe,
            outbox,
        ));
        state.clients.push(Client {
            id,
            browser: None,
            send,
            task: Some(task),
        });
    }

    fn send(&self, id: u64, message: ToBrowser) {
        let state = lock(&self.shared.state);
        if let Some(client) = state.clients.iter().find(|client| client.id == id) {
            let _ = client.send.send(message);
        }
    }

    /// The extension said hello: it's told whether the app is recording.
    fn hello(&self, app: &AppHandle, id: u64, browser: Browser) {
        {
            let mut state = lock(&self.shared.state);
            let on = state.recording;
            if let Some(client) = state.clients.iter_mut().find(|client| client.id == id) {
                client.browser = Some(browser);
                let _ = client.send.send(ToBrowser::Recording { on });
            }
        }
        log::info!("the browser link is connected to {browser:?}");
        self.changed(app);
    }

    fn drop_client(&self, app: &AppHandle, id: u64) {
        let dropped = {
            let mut state = lock(&self.shared.state);
            let before = state.clients.len();
            state.clients.retain(|client| client.id != id);
            before != state.clients.len()
        };
        if dropped {
            self.changed(app);
        }
    }

    /// Tells the connected browsers whether the app is recording.
    fn recording(&self, on: bool) {
        let mut state = lock(&self.shared.state);
        if state.recording == on {
            return;
        }
        state.recording = on;
        for client in state
            .clients
            .iter()
            .filter(|client| client.browser.is_some())
        {
            let _ = client.send.send(ToBrowser::Recording { on });
        }
        if !on {
            *lock(&self.shared.clicks) = PageClicks::default();
        }
    }

    /// A click the browser reported, kept to meet the app's own.
    fn add_click(&self, browser: Browser, age_ms: u32, title: String, target: Option<PageTarget>) {
        let now = now_tick();
        lock(&self.shared.clicks).add(
            PageClick {
                at: now.wrapping_sub(age_ms),
                browser,
                title,
                target,
            },
            now,
        );
        self.shared.arrived.notify_all();
    }

    /// The page's facts for the app's press at tick `pressed` in a window of `browser` titled
    /// `window_title`, waiting a moment for them if that browser is connected and was told the
    /// app is recording.
    fn page_target(
        &self,
        browser: Browser,
        pressed: u32,
        window_title: &str,
    ) -> Option<PageTarget> {
        {
            let state = lock(&self.shared.state);
            let listening = state
                .clients
                .iter()
                .any(|client| client.browser == Some(browser));
            if !state.recording || !listening {
                return None;
            }
        }
        let mut clicks = lock(&self.shared.clicks);
        loop {
            let now = now_tick();
            if let Some(click) = clicks.take(browser, pressed, window_title, now) {
                return click.target;
            }
            let waited = now.wrapping_sub(pressed);
            if waited >= WAIT_MS || waited > clicks::MATCH_MS * 4 {
                return None;
            }
            let left = Duration::from_millis(u64::from(WAIT_MS - waited));
            clicks = self
                .shared
                .arrived
                .wait_timeout(clicks, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }
}

/// The recorder's state changed: the browsers hear whether it's recording (paused counts as not).
pub fn recording_changed(app: &AppHandle, state: &str) {
    if let Some(link) = app.try_state::<BrowserLink>() {
        link.recording(matches!(state, "recording" | "degraded"));
    }
}

/// Adds what the browser said about a click in Chrome or Edge, when it said anything.
pub fn attach_page(app: &AppHandle, click: &mut ClickRecord) {
    let Some(browser) = Browser::of_program(click.window.exe.as_deref()) else {
        return;
    };
    let Some(link) = app.try_state::<BrowserLink>() else {
        return;
    };
    if let Some(target) = link.page_target(browser, click.tick_ms, &click.window.title) {
        click.page = Some(PageDetails { target });
    }
}

/// The link's state, for Settings.
#[tauri::command]
#[must_use]
pub fn browser_link_get(link: State<'_, BrowserLink>) -> LinkStatus {
    link.status()
}

/// Switches the link on or off; `None` is this copy's default: on, except in the portable
/// program, which writes nothing outside its folder unless asked.
#[tauri::command]
#[must_use]
pub fn browser_link_set(
    app: AppHandle,
    link: State<'_, BrowserLink>,
    on: Option<bool>,
) -> LinkStatus {
    let on = on.unwrap_or_else(|| !crate::updates::is_portable());
    link.set(&app, on)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connected(link: &BrowserLink, browser: Browser) {
        let (send, _outbox) = tokio::sync::mpsc::unbounded_channel();
        let mut state = lock(&link.shared.state);
        state.clients.push(Client {
            id: 1,
            browser: Some(browser),
            send,
            task: None,
        });
    }

    fn button(text: &str) -> PageTarget {
        PageTarget {
            tag_name: Some("BUTTON".into()),
            inner_text: Some(text.into()),
            ..PageTarget::default()
        }
    }

    #[test]
    fn a_press_takes_the_page_facts_only_while_recording_with_that_browser_connected() {
        let link = BrowserLink::default();
        let pressed = now_tick();
        link.add_click(
            Browser::Chrome,
            0,
            "Invoices".into(),
            Some(button("Approve")),
        );
        // Not recording, and nothing connected: no wait, nothing taken.
        assert_eq!(
            link.page_target(Browser::Chrome, pressed, "Invoices - Google Chrome"),
            None
        );
        connected(&link, Browser::Chrome);
        link.recording(true);
        // Stopping throws the waiting clicks away.
        link.recording(false);
        link.recording(true);
        link.add_click(
            Browser::Chrome,
            0,
            "Invoices".into(),
            Some(button("Approve")),
        );
        assert_eq!(
            link.page_target(Browser::Edge, pressed, "Invoices - Microsoft Edge"),
            None
        );
        let target = link.page_target(Browser::Chrome, pressed, "Invoices - Google Chrome");
        assert_eq!(
            target.and_then(|target| target.inner_text).as_deref(),
            Some("Approve")
        );
    }

    #[test]
    fn a_press_waits_a_moment_for_its_click_and_no_longer() {
        let link = BrowserLink::default();
        connected(&link, Browser::Edge);
        link.recording(true);
        let pressed = now_tick();
        let late = link.clone();
        let sender = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            late.add_click(Browser::Edge, 40, "Mail".into(), Some(button("Send")));
        });
        let target = link.page_target(Browser::Edge, pressed, "Mail - Microsoft Edge");
        sender.join().unwrap();
        assert_eq!(
            target.and_then(|target| target.inner_text).as_deref(),
            Some("Send")
        );

        let started = std::time::Instant::now();
        assert_eq!(
            link.page_target(Browser::Edge, now_tick(), "Mail - Microsoft Edge"),
            None
        );
        assert!(started.elapsed() < Duration::from_millis(u64::from(WAIT_MS) + 150));
    }

    #[test]
    fn the_status_names_each_connected_browser_once() {
        let link = BrowserLink::default();
        connected(&link, Browser::Edge);
        connected(&link, Browser::Chrome);
        connected(&link, Browser::Edge);
        assert_eq!(
            link.status().connected,
            vec![Browser::Chrome, Browser::Edge]
        );
    }
}
