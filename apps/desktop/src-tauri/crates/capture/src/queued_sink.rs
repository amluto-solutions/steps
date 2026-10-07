//! A sink that writes on a thread of its own, so the click thread doesn't wait for it.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc::{SyncSender, channel, sync_channel};
use std::thread::JoinHandle;

use image::RgbaImage;

use crate::facts::Record;
use crate::pipeline::Sink;

/// How many records may wait for the writer before `write` waits too. Each screenshot is up to
/// 15 MB unencoded, so a burst is held to about 120 MB.
const WAITING: usize = 8;

type Job = (Record, Option<RgbaImage>);

/// Hands each record to the sink inside on a thread of its own, in the order written. Encoding
/// and saving a screenshot takes long enough that six quick shortcut steps held the clicks after
/// them up to 5 s, and those clicks' screenshots were taken that late (07/10/2026).
pub enum QueuedSink<S: Sink + Send + 'static> {
    Queued {
        jobs: SyncSender<Job>,
        writer: JoinHandle<Option<S>>,
    },
    /// The writer thread couldn't start: records are written on the caller's thread, as before.
    Direct(S),
}

impl<S: Sink + Send + 'static> QueuedSink<S> {
    /// Starts the writer thread.
    #[must_use]
    pub fn new(inner: S) -> Self {
        let (jobs, waiting) = sync_channel::<Job>(WAITING);
        // The sink goes over once the thread has started, so it stays here if it can't start.
        let (hand_over, handed) = channel::<S>();
        let writer = std::thread::Builder::new()
            .name("amluto-journal-writer".into())
            .spawn(move || {
                let mut inner = handed.recv().ok()?;
                for (record, image) in waiting {
                    // One record that can't be written isn't the end of the recording.
                    if catch_unwind(AssertUnwindSafe(|| inner.write(record, image))).is_err() {
                        eprintln!("a record could not be written; carrying on");
                    }
                }
                Some(inner)
            });
        match writer {
            Ok(writer) => match hand_over.send(inner) {
                Ok(()) => Self::Queued { jobs, writer },
                Err(returned) => Self::Direct(returned.0),
            },
            Err(error) => {
                eprintln!("the journal writer didn't start ({error}); writing on this thread");
                Self::Direct(inner)
            }
        }
    }

    /// Waits until every record written so far has reached the sink inside, and gives it back.
    /// `None` only if the writer thread itself failed.
    #[must_use]
    pub fn finish(self) -> Option<S> {
        match self {
            Self::Queued { jobs, writer } => {
                drop(jobs);
                writer.join().ok().flatten()
            }
            Self::Direct(inner) => Some(inner),
        }
    }
}

impl<S: Sink + Send + 'static> Sink for QueuedSink<S> {
    fn write(&mut self, record: Record, image: Option<RgbaImage>) {
        match self {
            Self::Queued { jobs, .. } => {
                if jobs.send((record, image)).is_err() {
                    eprintln!("the journal writer has stopped; a record was lost");
                }
            }
            Self::Direct(inner) => inner.write(record, image),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// Keeps each record's tick, slowly, as encoding a screenshot is slow.
    struct SlowSink {
        written: Arc<Mutex<Vec<u32>>>,
        delay: Duration,
    }

    impl Sink for SlowSink {
        fn write(&mut self, record: Record, _image: Option<RgbaImage>) {
            std::thread::sleep(self.delay);
            if let Record::State { tick_ms, .. } = record {
                assert_ne!(tick_ms, 13, "a record that can't be written");
                self.written.lock().unwrap().push(tick_ms);
            }
        }
    }

    fn state(tick_ms: u32) -> Record {
        Record::State {
            state: "recovered",
            reason: String::new(),
            tick_ms,
        }
    }

    fn slow(delay_ms: u64) -> (SlowSink, Arc<Mutex<Vec<u32>>>) {
        let written = Arc::new(Mutex::new(Vec::new()));
        let sink = SlowSink {
            written: Arc::clone(&written),
            delay: Duration::from_millis(delay_ms),
        };
        (sink, written)
    }

    #[test]
    fn writing_doesnt_wait_for_a_slow_sink() {
        // Six shortcut steps' screenshots held the clicks after them up to 5 s (07/10/2026).
        let (sink, _) = slow(200);
        let mut queued = QueuedSink::new(sink);
        let started = Instant::now();
        for tick in 0..4 {
            queued.write(state(tick), None);
        }
        assert!(started.elapsed() < Duration::from_millis(150));
        let _ = queued.finish();
    }

    #[test]
    fn records_arrive_in_order_and_finish_waits_for_them_all() {
        let (sink, written) = slow(5);
        let mut queued = QueuedSink::new(sink);
        for tick in 100..120 {
            queued.write(state(tick), None);
        }
        let _ = queued.finish();
        assert_eq!(*written.lock().unwrap(), (100..120).collect::<Vec<_>>());
    }

    #[test]
    fn a_record_that_fails_doesnt_stop_the_ones_after_it() {
        let (sink, written) = slow(0);
        let mut queued = QueuedSink::new(sink);
        for tick in 12..15 {
            queued.write(state(tick), None);
        }
        let _ = queued.finish();
        assert_eq!(*written.lock().unwrap(), vec![12, 14]);
    }
}
