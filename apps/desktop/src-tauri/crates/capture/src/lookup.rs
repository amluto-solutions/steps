//! What the element lookups share on every platform (docs/spec/02-capture.md#on-each-click):
//! how a lookup's reply is waited for, and the rules for reading a field's value. UI Automation
//! (`uia.rs`) and AT-SPI (`atspi.rs`) each find the element; these decide what happens to it.
//!
//! Lookups are asynchronous: the pipeline sends a request, takes the screenshot, then waits for
//! the reply until a deadline. A reply that arrives after the deadline belongs to an old click id
//! and is discarded, so late results can never land on the wrong click.

use std::hash::{BuildHasher, RandomState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::facts::ElementFacts;
use crate::platform::window::WindowInfo;
use crate::state_machine::RecorderStateMachine;

/// How the element lookup for one click ended.
#[allow(
    clippy::large_enum_variant,
    reason = "one per click; boxing buys nothing"
)]
#[derive(Debug, Clone, PartialEq)]
pub enum Lookup {
    Found {
        facts: ElementFacts,
        ms: f64,
        retried: bool,
    },
    Failed {
        error: String,
        ms: f64,
    },
    TimedOut {
        ms: f64,
    },
}

/// Settings for field-value capture on focus-leave.
#[derive(Debug, Clone, Default)]
pub struct FocusOptions {
    /// "Record what's typed". When off, input records carry no value.
    pub record_values: bool,
    /// Where the key worker learns what has focus (only when keys are recorded).
    pub note: Option<crate::typing::SharedFocus>,
    /// Extra sensitive words from IT policy.
    pub extra_sensitive_terms: Vec<String>,
    /// The recording's state machine: fields are only read while it records, and never in an
    /// app it excludes. `None` (the prototype) reads everywhere but our own windows.
    pub machine: Option<Arc<Mutex<RecorderStateMachine>>>,
    /// Where the focus worker leaves word of an editable field gaining focus, for the pipeline to
    /// take its screenshot then, before anything is typed (04/10/2026).
    pub entered: FieldSlot,
}

/// An editable field gained focus: when, and in which window.
#[derive(Debug, Clone)]
pub struct FieldEntered {
    pub tick_ms: u32,
    pub window: WindowInfo,
}

/// The latest field to gain focus, until the pipeline takes it.
pub type FieldSlot = Arc<Mutex<Option<FieldEntered>>>;

/// Leaves word that `focused` gained focus, if it's a field whose value may be recorded.
pub(crate) fn note_entered(slot: &FieldSlot, tick_ms: u32, window: Option<&WindowInfo>) {
    if let Some(window) = window {
        *slot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(FieldEntered {
            tick_ms,
            window: window.clone(),
        });
    }
}

/// One lookup's answer, from the worker thread.
pub(crate) struct Reply {
    pub id: u64,
    pub result: std::result::Result<(ElementFacts, bool), String>,
    pub elapsed: Duration,
}

/// The pipeline's end of the worker's replies.
pub(crate) struct Replies {
    pub receiver: Receiver<Reply>,
}

impl Replies {
    /// Waits for the reply to `id` until `deadline`, discarding replies for older clicks.
    ///
    /// The deadline limits how long the *lookup* may take, not when we look. The pipeline takes
    /// the screenshot before calling this, so a reply that finished in time may already be
    /// waiting after the deadline has passed: that one still counts.
    pub fn wait(&self, id: u64, started: Instant, deadline: Instant, stopped: &str) -> Lookup {
        let allowed = deadline.saturating_duration_since(started);
        loop {
            let now = Instant::now();
            let Some(remaining) = deadline.checked_duration_since(now) else {
                return self.take_ready(id, allowed, started);
            };
            match self.receiver.recv_timeout(remaining) {
                Ok(reply) if reply.id == id => return found(reply),
                Ok(_) => {} // a late reply for an earlier click: discard
                Err(RecvTimeoutError::Timeout) => return self.take_ready(id, allowed, started),
                Err(RecvTimeoutError::Disconnected) => {
                    return Lookup::Failed {
                        error: stopped.into(),
                        ms: millis(started.elapsed()),
                    };
                }
            }
        }
    }

    /// After the deadline: accept a reply for `id` that's already queued and took no longer than
    /// `allowed`; anything else is a timeout.
    fn take_ready(&self, id: u64, allowed: Duration, started: Instant) -> Lookup {
        while let Ok(reply) = self.receiver.try_recv() {
            if reply.id == id && reply.elapsed <= allowed {
                return found(reply);
            }
        }
        Lookup::TimedOut {
            ms: millis(started.elapsed()),
        }
    }
}

fn found(reply: Reply) -> Lookup {
    let ms = millis(reply.elapsed);
    match reply.result {
        Ok((facts, retried)) => Lookup::Found { facts, ms, retried },
        Err(error) => Lookup::Failed { error, ms },
    }
}

/// Waits for a worker thread to say it's ready. A worker that fails, or is too slow, is told to
/// stop through `cancelled`.
pub(crate) fn await_worker_ready(
    ready: &Receiver<Result<(), String>>,
    cancelled: &AtomicBool,
    timeout: Duration,
    too_slow: &str,
) -> Result<(), String> {
    let result = match ready.recv_timeout(timeout) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err(too_slow.into()),
        Err(RecvTimeoutError::Disconnected) => {
            Err("the lookup worker stopped before it was ready".into())
        }
    };
    if result.is_err() {
        cancelled.store(true, Ordering::SeqCst);
    }
    result
}

pub(crate) fn millis(duration: Duration) -> f64 {
    (duration.as_secs_f64() * 1000.0 * 10.0).round() / 10.0
}

/// Whether a field's value must not be read at all: in Steps' own windows, in an excluded app
/// (by the field's process or the window in front, since a web-view host such as the new Outlook
/// runs its fields in `msedgewebview2.exe`), when neither app can be named, or while the
/// recording isn't running.
pub(crate) fn reading_blocked(
    options: &FocusOptions,
    field_pid: u32,
    window: Option<&WindowInfo>,
) -> bool {
    let own = crate::platform::window::own_process_id();
    if field_pid == own || window.is_some_and(|window| window.pid == own) {
        return true;
    }
    let Some(machine) = &options.machine else {
        return false;
    };
    let field_exe = crate::platform::window::process_exe_name(field_pid);
    let window_exe = window.and_then(WindowInfo::exe_name);
    if field_exe.is_none() && window_exe.is_none() {
        return true;
    }
    let machine = machine
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    !machine.is_active()
        || field_exe.is_some_and(|name| machine.is_app_excluded(&name))
        || window_exe.is_some_and(|name| machine.is_app_excluded(name))
}

/// Whether an element (by its UI Automation control type, which AT-SPI roles are mapped to) is a
/// field whose value can be typed.
pub(crate) fn is_editable(facts: &ElementFacts) -> bool {
    matches!(facts.control_type.as_str(), "Edit" | "ComboBox")
        || (facts.control_type == "Document"
            && facts.aria_role.eq_ignore_ascii_case("textbox")
            && !facts.aria_properties.contains("readonly=true"))
}

/// The longest typed value a step holds (`textParts.value` in packages/core/src/guide.ts).
pub(crate) const MAX_VALUE_CHARS: usize = 2_000;

/// A value cut to what a step can hold. Masking runs first, on the whole value.
pub(crate) fn fit_value(value: String) -> String {
    if value.chars().count() <= MAX_VALUE_CHARS {
        value
    } else {
        value.chars().take(MAX_VALUE_CHARS).collect()
    }
}

/// A one-way fingerprint of a field's value, keyed afresh each run, so an unchanged field can be
/// told from a typed-in one without keeping what it holds.
pub(crate) fn fingerprint(value: &str) -> u64 {
    static KEY: std::sync::OnceLock<RandomState> = std::sync::OnceLock::new();
    KEY.get_or_init(RandomState::new).hash_one(value)
}

/// The origin in a browser's address bar, and nothing else of it: never the path or query.
pub(crate) fn origin_from_address(address: &str) -> Option<String> {
    let address = address.trim();
    if address.is_empty() || address.chars().any(char::is_whitespace) {
        return None;
    }
    if address.contains("://") {
        let url = url::Url::parse(address).ok()?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return None;
        }
        return Some(url.origin().ascii_serialization());
    }
    let url = url::Url::parse(&format!("https://{address}")).ok()?;
    let host = match url.host()? {
        url::Host::Domain(domain) if domain == "localhost" || domain.contains('.') => {
            domain.to_string()
        }
        url::Host::Domain(_) => return None,
        url::Host::Ipv4(ip) => ip.to_string(),
        url::Host::Ipv6(ip) => format!("[{ip}]"),
    };
    // A bare word before a colon is some other kind of address ("mailto:…"), not host:port.
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{self, Sender};

    use super::*;

    #[test]
    fn fingerprints_tell_changed_values_apart() {
        assert_eq!(
            fingerprint("https://www.google.com/"),
            fingerprint("https://www.google.com/")
        );
        assert_ne!(
            fingerprint("https://www.google.com/"),
            fingerprint("amluto steps")
        );
        assert_ne!(fingerprint(""), fingerprint("a"));
    }

    #[test]
    fn a_very_long_value_is_cut_to_what_a_step_holds() {
        let long = "é".repeat(MAX_VALUE_CHARS + 50);
        assert_eq!(fit_value(long).chars().count(), MAX_VALUE_CHARS);
        assert_eq!(fit_value("short".into()), "short");
    }

    #[test]
    fn late_worker_reply_is_discarded_after_startup_timeout() {
        let (ready_tx, ready_rx) = mpsc::channel();
        let cancelled = AtomicBool::new(false);
        assert_eq!(
            await_worker_ready(&ready_rx, &cancelled, Duration::from_millis(1), "too slow"),
            Err("too slow".into())
        );
        assert!(cancelled.load(Ordering::SeqCst));
        drop(ready_rx);
        assert!(ready_tx.send(Ok(())).is_err());
    }

    /// Canned replies. The sender is returned so the channel stays open, like a live worker's.
    fn replies_with(replies: Vec<Reply>) -> (Replies, Sender<Reply>) {
        let (reply_tx, reply_rx) = mpsc::channel();
        for reply in replies {
            reply_tx.send(reply).unwrap();
        }
        (Replies { receiver: reply_rx }, reply_tx)
    }

    fn reply(id: u64, elapsed_ms: u64) -> Reply {
        Reply {
            id,
            result: Ok((ElementFacts::default(), false)),
            elapsed: Duration::from_millis(elapsed_ms),
        }
    }

    #[test]
    fn a_fast_reply_read_after_the_deadline_still_counts() {
        // The screenshot took 200 ms; the lookup itself finished in 10 ms.
        let (replies, _sender) = replies_with(vec![reply(5, 10)]);
        let started = Instant::now()
            .checked_sub(Duration::from_millis(200))
            .unwrap();
        let lookup = replies.wait(5, started, started + Duration::from_millis(150), "gone");
        assert!(matches!(lookup, Lookup::Found { .. }), "{lookup:?}");
    }

    #[test]
    fn a_slow_lookup_is_a_timeout_even_if_it_is_queued() {
        let (replies, _sender) = replies_with(vec![reply(5, 400)]);
        let started = Instant::now()
            .checked_sub(Duration::from_millis(500))
            .unwrap();
        let lookup = replies.wait(5, started, started + Duration::from_millis(150), "gone");
        assert!(matches!(lookup, Lookup::TimedOut { .. }), "{lookup:?}");
    }

    #[test]
    fn replies_for_earlier_clicks_are_discarded() {
        let (replies, _sender) = replies_with(vec![reply(3, 5), reply(4, 5)]);
        let started = Instant::now();
        let lookup = replies.wait(5, started, started + Duration::from_millis(30), "gone");
        assert!(matches!(lookup, Lookup::TimedOut { .. }), "{lookup:?}");
    }

    #[test]
    fn only_text_like_controls_are_editable() {
        let facts = |control_type: &str, aria_role: &str, aria_properties: &str| ElementFacts {
            control_type: control_type.into(),
            aria_role: aria_role.into(),
            aria_properties: aria_properties.into(),
            ..ElementFacts::default()
        };
        assert!(is_editable(&facts("Edit", "", "")));
        assert!(is_editable(&facts("ComboBox", "", "")));
        assert!(is_editable(&facts("Document", "textbox", "readonly=false")));
        assert!(!is_editable(&facts(
            "Document",
            "document",
            "readonly=true"
        )));
        assert!(!is_editable(&facts("Document", "textbox", "readonly=true")));
        assert!(!is_editable(&facts("Button", "", "")));
    }

    #[test]
    fn navigation_facts_keep_only_a_valid_http_origin() {
        assert_eq!(
            origin_from_address("https://user:secret@example.test:8443/path?q=secret#part"),
            Some("https://example.test:8443".into())
        );
        assert_eq!(
            origin_from_address("https://example.test:8443/path?q=secret#part"),
            Some("https://example.test:8443".into())
        );
        assert_eq!(origin_from_address("file:///C:/private.docx"), None);
        assert_eq!(origin_from_address("javascript:alert(1)"), None);
        // What Edge and Chrome actually show: the scheme hidden.
        assert_eq!(
            origin_from_address("127.0.0.1:8124/b.html"),
            Some("127.0.0.1:8124".into())
        );
        assert_eq!(
            origin_from_address("www.example.test/path?q=secret"),
            Some("www.example.test".into())
        );
        assert_eq!(
            origin_from_address("localhost:3000"),
            Some("localhost:3000".into())
        );
        // Searches and other text are never taken for a site.
        for text in [
            "holiday request form",
            "payroll",
            "mailto:a@b.test",
            "user@example.test",
            "",
        ] {
            assert_eq!(origin_from_address(text), None, "{text}");
        }
    }
}
