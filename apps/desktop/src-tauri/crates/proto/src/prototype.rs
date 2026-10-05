//! Phase 1 capture prototype (docs/spec/02-capture.md, Phase 1).
//!
//! Records clicks and focus-leave field values into a folder: one PNG per click plus
//! `events.jsonl` and `session.json`. Stops after `--seconds`, when a `STOP` file appears in the
//! output folder, or when Enter is pressed.
//!
//! ```text
//! proto [--source hook|raw] [--mode window|monitor] [--values on|off]
//!       [--seconds N] [--stall-ms N] [--queue N] [--out DIR]
//! ```

use std::fs::{self, File};
use std::io::{BufRead, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use capture::facts::Record;
use capture::pipeline::{self, PipelineConfig, Sink, Stats, percentile};
use capture::screenshot::CaptureMode;
use capture::uia::{FocusOptions, UiaClient};
use capture_win32::display::enable_per_monitor_dpi_awareness;
use capture_win32::input::{InputCapture, InputSource};
use image::RgbaImage;
use serde_json::json;

struct Options {
    source: InputSource,
    mode: CaptureMode,
    record_values: bool,
    seconds: Option<u64>,
    stall_ms: u64,
    queue: Option<usize>,
    out: PathBuf,
}

fn parse_options() -> Result<Options, String> {
    let mut options = Options {
        source: InputSource::Hook,
        mode: CaptureMode::Window,
        record_values: true,
        seconds: None,
        stall_ms: 0,
        queue: None,
        out: default_out_dir(),
    };
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--source" => {
                options.source = match value()?.as_str() {
                    "hook" => InputSource::Hook,
                    "raw" => InputSource::RawInput,
                    other => return Err(format!("unknown source {other}")),
                };
            }
            "--mode" => {
                options.mode = match value()?.as_str() {
                    "window" => CaptureMode::Window,
                    "monitor" => CaptureMode::Monitor,
                    other => return Err(format!("unknown mode {other}")),
                };
            }
            "--values" => options.record_values = value()? == "on",
            "--seconds" => options.seconds = Some(value()?.parse().map_err(|_| "bad --seconds")?),
            "--stall-ms" => options.stall_ms = value()?.parse().map_err(|_| "bad --stall-ms")?,
            "--queue" => options.queue = Some(value()?.parse().map_err(|_| "bad --queue")?),
            "--out" => options.out = PathBuf::from(value()?),
            other => return Err(format!("unknown flag {other}")),
        }
    }
    Ok(options)
}

fn default_out_dir() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    std::env::temp_dir()
        .join("amluto-proto")
        .join(stamp.to_string())
}

/// Writes records to `events.jsonl` and images to PNG files on a separate thread, so encoding
/// never slows the pipeline.
struct FileSink {
    sender: mpsc::Sender<(Record, Option<RgbaImage>)>,
}

impl Sink for FileSink {
    fn write(&mut self, record: Record, image: Option<RgbaImage>) {
        let _ = self.sender.send((record, image));
    }
}

fn start_writer(out: &Path) -> Result<(FileSink, std::thread::JoinHandle<()>), String> {
    let (sender, receiver) = mpsc::channel::<(Record, Option<RgbaImage>)>();
    let events = File::create(out.join("events.jsonl")).map_err(|e| e.to_string())?;
    let out = out.to_path_buf();
    let handle = std::thread::spawn(move || {
        let mut events = BufWriter::new(events);
        for (mut record, image) in receiver {
            if let (Record::Click(click), Some(image)) = (&mut record, image) {
                let name = format!("click-{:04}.png", click.id);
                match image.save(out.join(&name)) {
                    Ok(()) => click.capture.image = Some(name),
                    Err(error) => eprintln!("could not save {name}: {error}"),
                }
            }
            if let Ok(line) = serde_json::to_string(&record) {
                let _ = writeln!(events, "{line}");
                let _ = events.flush();
            }
            print_record(&record);
        }
    });
    Ok((FileSink { sender }, handle))
}

fn print_record(record: &Record) {
    match record {
        Record::Click(click) => {
            let element = click.element.as_ref().map_or_else(
                || "(no element)".to_string(),
                |e| format!("{} \"{}\"", e.control_type, e.name),
            );
            println!(
                "click #{:<4} {:<11} {:<40} shot {:>6.1} ms  uia {:<7} {:>6.1} ms  delay {:>4} ms{}",
                click.id,
                click.window.exe.as_deref().unwrap_or("?"),
                truncate(&element, 40),
                click.screenshot_ms,
                click.uia.status,
                click.uia.ms,
                click.queue_delay_ms,
                if click.injected { "  (injected)" } else { "" },
            );
        }
        Record::Input(input) => println!(
            "input        {} \"{}\" value={:?} withheld={:?}",
            input.element.control_type, input.element.name, input.value, input.withheld
        ),
        Record::Manual(manual) => println!(
            "manual      {} in {}",
            manual.action_text, manual.window.title
        ),
        Record::AppSwitch(change) => {
            println!("app switch   {}", change.window.title);
        }
        // The prototype never reads keys; these come only from the app with "Record what's typed".
        Record::Command(command) => println!("command      {}", command.command),
        Record::Typing(typing) => println!("typing       {:?}", typing.text),
        Record::Keys(keys) => println!("keys         vkey {}", keys.vkey),
        Record::Navigation(change) => {
            println!("navigation   {}", change.origin);
        }
        Record::Double { of, .. } => println!("double       of #{of}"),
        Record::Drag(drag) => println!(
            "drag         {} to {} (of #{})",
            drag.from, drag.to, drag.of
        ),
        Record::Missed { count, after_id } => {
            println!("MISSED       {count} click(s) after #{after_id}");
        }
        Record::Touch { count, .. } => println!("TOUCH        {count} report(s) not recorded"),
        Record::State { state, reason, .. } => println!("STATE        {state}: {reason}"),
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(max - 1).collect::<String>())
    }
}

fn monitors_json() -> serde_json::Value {
    xcap::Monitor::all().map_or_else(
        |_| json!([]),
        |monitors| {
            monitors
                .iter()
                .map(|m| {
                    json!({
                        "name": m.friendly_name().unwrap_or_default(),
                        "x": m.x().unwrap_or(0),
                        "y": m.y().unwrap_or(0),
                        "width": m.width().unwrap_or(0),
                        "height": m.height().unwrap_or(0),
                        "scale": m.scale_factor().unwrap_or(1.0),
                        "primary": m.is_primary().unwrap_or(false),
                    })
                })
                .collect()
        },
    )
}

fn summary(stats: &Stats) -> serde_json::Value {
    let p = |values: &[f64], at: f64| percentile(values, at);
    json!({
        "clicks": stats.clicks,
        "doubles": stats.doubles,
        "inputs": stats.inputs,
        "missed": stats.missed,
        "degraded": stats.degraded,
        "ignoredOwnWindow": stats.ignored_own,
        "uiaTimeouts": stats.uia_timeouts,
        "uiaErrors": stats.uia_errors,
        "uiaRetries": stats.uia_retries,
        "screenshotMs": { "p50": p(&stats.screenshot_ms, 50.0), "p95": p(&stats.screenshot_ms, 95.0) },
        "uiaMs": { "p50": p(&stats.uia_ms, 50.0), "p95": p(&stats.uia_ms, 95.0) },
        "queueDelayMs": { "p50": p(&stats.queue_delay_ms, 50.0), "p95": p(&stats.queue_delay_ms, 95.0) },
    })
}

fn watch_for_stop(stop: &Arc<AtomicBool>, out: &Path, seconds: Option<u64>) {
    let stop_file = out.join("STOP");
    let deadline = seconds.map(|s| Instant::now() + Duration::from_secs(s));
    {
        let stop = Arc::clone(stop);
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = std::io::stdin().lock().read_line(&mut line);
            stop.store(true, Ordering::SeqCst);
        });
    }
    let stop = Arc::clone(stop);
    std::thread::spawn(move || {
        loop {
            if stop_file.exists() || deadline.is_some_and(|d| Instant::now() >= d) {
                stop.store(true, Ordering::SeqCst);
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
}

fn run() -> Result<(), String> {
    let options = parse_options()?;
    fs::create_dir_all(&options.out).map_err(|e| e.to_string())?;
    let dpi_set = enable_per_monitor_dpi_awareness();

    if let Some(capacity) = options.queue {
        capture_win32::input::set_queue_capacity_before_start(capacity);
    }
    let input = InputCapture::start(options.source).map_err(|e| e.to_string())?;
    let (input_tx, input_rx) = mpsc::channel();
    let uia = UiaClient::start(Some((
        input_tx,
        FocusOptions {
            record_values: options.record_values,
            note: None,
            extra_sensitive_terms: Vec::new(),
            machine: None,
            entered: capture::lookup::FieldSlot::default(),
        },
    )))?;
    let (mut sink, writer) = start_writer(&options.out)?;

    let config = PipelineConfig {
        mode: options.mode,
        target_monitor: None,
        stall_per_event: Duration::from_millis(options.stall_ms),
        ..PipelineConfig::default()
    };
    let stop = Arc::new(AtomicBool::new(false));
    watch_for_stop(&stop, &options.out, options.seconds);

    println!(
        "Recording ({:?}, {} mode, values {}). Output: {}",
        options.source,
        options.mode.as_str(),
        if options.record_values { "on" } else { "off" },
        options.out.display()
    );
    println!("Stop with Enter, a STOP file in the output folder, or --seconds.");

    let started = SystemTime::now();
    let input_capacity = input.shared().capacity();
    input.shared().enabled.store(true, Ordering::SeqCst);
    let stats = pipeline::run(
        input.shared(),
        &uia,
        Some(&input_rx),
        &config,
        &stop,
        &mut sink,
    );
    input.shared().enabled.store(false, Ordering::SeqCst);
    let input_alive = input.is_alive();
    input.stop();
    drop(uia);
    drop(sink);
    let _ = writer.join();

    let session = json!({
        "source": format!("{:?}", options.source),
        "mode": options.mode.as_str(),
        "recordValues": options.record_values,
        "stallMs": options.stall_ms,
        "queueCapacity": input_capacity,
        "dpiAwarenessSetByUs": dpi_set,
        "packageFullName": capture_win32::package_full_name(),
        "inputThreadAliveAtEnd": input_alive,
        "startedUnix": started.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()),
        "durationSeconds": started.elapsed().map_or(0.0, |d| d.as_secs_f64()),
        "monitors": monitors_json(),
        "summary": summary(&stats),
    });
    let text = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    fs::write(options.out.join("session.json"), &text).map_err(|e| e.to_string())?;
    println!("\n{text}");
    Ok(())
}

pub fn main() {
    if let Err(error) = run() {
        eprintln!("proto: {error}");
        std::process::exit(1);
    }
}
