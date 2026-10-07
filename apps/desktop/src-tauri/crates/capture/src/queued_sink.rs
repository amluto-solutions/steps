//! A sink that writes on a thread of its own, so the click thread doesn't wait for it.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc::{SyncSender, channel, sync_channel};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use image::RgbaImage;

use crate::facts::Record;
use crate::pipeline::Sink;

/// How many records may wait in the queue before `write` waits too. With the one being written
/// and the one the click thread is holding, at most ten screenshots of up to 15 MB each are in
/// memory at once: a burst is held to about 150 MB.
const WAITING: usize = 8;

type Job = (Record, Option<RgbaImage>);

/// How many records were handed to a `QueuedSink` and aren't written yet. A step journalled
/// another way (Capture now, Add shortcut) waits for it to empty first, so a click made before
/// it isn't numbered after it (07/10/2026: the journal's sequence orders the steps).
#[derive(Debug, Default)]
pub struct Backlog {
    waiting: Mutex<usize>,
    emptied: Condvar,
}

impl Backlog {
    /// Waits until everything handed over so far is written, for `limit` at most. `false` if
    /// the limit came first.
    pub fn wait_until_written(&self, limit: Duration) -> bool {
        let waiting = self
            .waiting
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (waiting, _) = self
            .emptied
            .wait_timeout_while(waiting, limit, |waiting| *waiting > 0)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *waiting == 0
    }

    fn add(&self) {
        *self
            .waiting
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) += 1;
    }

    fn done(&self) {
        let mut waiting = self
            .waiting
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *waiting = waiting.saturating_sub(1);
        if *waiting == 0 {
            self.emptied.notify_all();
        }
    }
}

/// Hands each record to the sink inside on a thread of its own, in the order written. Encoding
/// and saving a screenshot takes long enough that six quick shortcut steps held the clicks after
/// them up to 5 s, and those clicks' screenshots were taken that late (07/10/2026).
pub struct QueuedSink<S: Sink + Send + 'static> {
    mode: Mode<S>,
    backlog: Arc<Backlog>,
}

enum Mode<S> {
    /// The writer thread, and the queue to it.
    Queued {
        jobs: SyncSender<Job>,
        writer: JoinHandle<Option<S>>,
    },
    /// The writer thread couldn't start: records are written on the caller's thread, as before.
    Direct(S),
}

impl<S: Sink + Send + 'static> QueuedSink<S> {
    /// Starts the writer thread. `backlog` counts what's waiting, for other writers of the same
    /// journal to wait on.
    #[must_use]
    pub fn new(inner: S, backlog: Arc<Backlog>) -> Self {
        let (jobs, waiting) = sync_channel::<Job>(WAITING);
        // The sink goes over once the thread has started, so it stays here if it can't start.
        let (hand_over, handed) = channel::<S>();
        let for_writer = Arc::clone(&backlog);
        let writer = std::thread::Builder::new()
            .name("amluto-journal-writer".into())
            .spawn(move || {
                let mut inner = handed.recv().ok()?;
                let mut last_id = 0;
                for (record, image) in waiting {
                    let id = step_id(&record);
                    if catch_unwind(AssertUnwindSafe(|| inner.write(record, image))).is_ok() {
                        last_id = id.unwrap_or(last_id);
                    } else {
                        // Never silent loss (docs/engineering.md): the step that couldn't be
                        // written is marked where it was, and the recording carries on.
                        let missed = Record::Missed {
                            count: 1,
                            after_id: last_id,
                        };
                        let _ = catch_unwind(AssertUnwindSafe(|| inner.write(missed, None)));
                    }
                    for_writer.done();
                }
                Some(inner)
            });
        let mode = match writer {
            Ok(writer) => match hand_over.send(inner) {
                Ok(()) => Mode::Queued { jobs, writer },
                Err(returned) => Mode::Direct(returned.0),
            },
            Err(_) => Mode::Direct(inner),
        };
        Self { mode, backlog }
    }

    /// Waits until every record written so far has reached the sink inside, and gives it back.
    /// `None` only if the writer thread itself failed.
    #[must_use]
    pub fn finish(self) -> Option<S> {
        match self.mode {
            Mode::Queued { jobs, writer } => {
                drop(jobs);
                writer.join().ok().flatten()
            }
            Mode::Direct(inner) => Some(inner),
        }
    }
}

/// The id a missed marker after this record points at: a click's or a screenshot step's.
fn step_id(record: &Record) -> Option<u64> {
    match record {
        Record::Click(click) => Some(click.id),
        Record::Manual(manual) => Some(manual.id),
        _ => None,
    }
}

impl<S: Sink + Send + 'static> Sink for QueuedSink<S> {
    fn write(&mut self, record: Record, image: Option<RgbaImage>) {
        match &mut self.mode {
            Mode::Queued { jobs, .. } => {
                self.backlog.add();
                // Only if the writer thread itself has gone, which `finish` then reports.
                if jobs.send((record, image)).is_err() {
                    self.backlog.done();
                }
            }
            Mode::Direct(inner) => inner.write(record, image),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Instant;

    /// Keeps what it was given, slowly, as encoding a screenshot is slow.
    struct SlowSink {
        written: Arc<Mutex<Vec<String>>>,
        delay: Duration,
    }

    impl Sink for SlowSink {
        fn write(&mut self, record: Record, _image: Option<RgbaImage>) {
            std::thread::sleep(self.delay);
            let line = match record {
                Record::State { tick_ms, .. } => {
                    assert_ne!(tick_ms, 13, "a record that can't be written");
                    format!("state {tick_ms}")
                }
                Record::Missed { count, after_id } => format!("missed {count} after {after_id}"),
                _ => "other".into(),
            };
            self.written.lock().unwrap().push(line);
        }
    }

    fn state(tick_ms: u32) -> Record {
        Record::State {
            state: "recovered",
            reason: String::new(),
            tick_ms,
        }
    }

    fn slow(delay_ms: u64) -> (QueuedSink<SlowSink>, Arc<Backlog>, Arc<Mutex<Vec<String>>>) {
        let written = Arc::new(Mutex::new(Vec::new()));
        let sink = SlowSink {
            written: Arc::clone(&written),
            delay: Duration::from_millis(delay_ms),
        };
        let backlog = Arc::new(Backlog::default());
        (
            QueuedSink::new(sink, Arc::clone(&backlog)),
            backlog,
            written,
        )
    }

    fn states(range: std::ops::Range<u32>) -> Vec<String> {
        range.map(|tick| format!("state {tick}")).collect()
    }

    #[test]
    fn writing_doesnt_wait_for_a_slow_sink() {
        // Six shortcut steps' screenshots held the clicks after them up to 5 s (07/10/2026).
        let (mut queued, _, _) = slow(200);
        let started = Instant::now();
        for tick in 0..4 {
            queued.write(state(tick), None);
        }
        assert!(started.elapsed() < Duration::from_millis(150));
        let _ = queued.finish();
    }

    #[test]
    fn records_arrive_in_order_and_finish_waits_for_them_all() {
        let (mut queued, _, written) = slow(5);
        for tick in 100..120 {
            queued.write(state(tick), None);
        }
        let _ = queued.finish();
        assert_eq!(*written.lock().unwrap(), states(100..120));
    }

    #[test]
    fn a_record_that_fails_leaves_a_missed_marker_where_it_was() {
        // Never silent loss (docs/engineering.md): the step that couldn't be written is marked.
        let (mut queued, _, written) = slow(0);
        for tick in 12..15 {
            queued.write(state(tick), None);
        }
        let _ = queued.finish();
        assert_eq!(
            *written.lock().unwrap(),
            vec!["state 12", "missed 1 after 0", "state 14"]
        );
    }

    #[test]
    fn the_backlog_empties_once_everything_waiting_is_written() {
        // Capture now waits for it, so its step comes after the clicks made before it.
        let (mut queued, backlog, written) = slow(30);
        for tick in 0..5 {
            queued.write(state(tick), None);
        }
        assert!(backlog.wait_until_written(Duration::from_secs(2)));
        assert_eq!(*written.lock().unwrap(), states(0..5));
        let _ = queued.finish();
    }

    #[test]
    fn waiting_for_the_backlog_gives_up_at_its_limit() {
        let (mut queued, backlog, _) = slow(300);
        queued.write(state(1), None);
        queued.write(state(2), None);
        let started = Instant::now();
        assert!(!backlog.wait_until_written(Duration::from_millis(50)));
        assert!(started.elapsed() < Duration::from_millis(250));
        let _ = queued.finish();
    }
}
