//! Keys typed in a terminal (the classic console, Windows Terminal, a VTE terminal on Linux;
//! docs/spec/02-capture.md#keys): Enter is the signal. The command and its output are read from
//! the screen once the output has settled, and one screenshot is taken. Enter at a line with no
//! shell prompt answers a program, which is a typing step unless it's starred or about a
//! password; a line another program typed into as Unicode packets makes no step (11/10/2026).
//! One reason to change: how a terminal's commands and replies become steps.

use std::time::{Duration, Instant};

use crate::facts::{CaptureFacts, CommandRecord, Record, TypingRecord};
use crate::keys::KeyAction;
use crate::platform::window::WindowInfo;
use crate::programs::window_facts;
use crate::screen_text::TerminalKind;
use crate::secrets::{blur_secrets, mask_command, mask_output};
use crate::sensitive::mask_value;
use crate::terminal::{Shell, current_line, fit_output, read_command, split_prompt};

use super::{Desktop, READ_AFTER_KEYS, Worker};

/// How often a terminal is read while its output is still arriving.
const OUTPUT_POLL: Duration = Duration::from_millis(250);

/// The longest a command's output is waited for.
const OUTPUT_LIMIT: Duration = Duration::from_secs(60);

/// Commands typed into one terminal window.
pub(super) struct TerminalSession {
    pub(super) hwnd: isize,
    kind: TerminalKind,
    /// The line the cursor was on with nothing typed yet.
    idle_line: Option<String>,
    /// Characters typed since the last Enter.
    typed: usize,
    /// Another program typed into the line as Unicode packets since the last Enter (#91).
    packets: bool,
    /// The screen read shortly after the latest key.
    screen: Option<String>,
    read_due: Option<Instant>,
    awaiting: Option<Awaiting>,
}

/// A command whose output is being waited for.
struct Awaiting {
    enter_tick: u32,
    before: Option<String>,
    typed: usize,
    /// The line was partly typed by another program: its command or reply makes no step (#91).
    packets: bool,
    idle_line: Option<String>,
    last_screen: Option<String>,
    last_change: Instant,
    next_poll: Instant,
    started: Instant,
}

/// The answer part of a reply line: what follows the program's question (`Name: sam` → `sam`).
fn reply_text(line: &str) -> &str {
    line.rsplit_once(": ")
        .map_or(line, |(_, answer)| answer)
        .trim()
}

/// A reply to a prompt that the terminal shows only as stars (`Password: ********`).
fn looks_like_masked_entry(line: &str) -> bool {
    let entry = line.rsplit(':').next().unwrap_or(line).trim();
    !entry.is_empty() && entry.chars().all(|ch| matches!(ch, '*' | '•' | '●'))
}

impl<D: Desktop> Worker<D> {
    pub(super) fn terminal_key(
        &mut self,
        hwnd: isize,
        kind: TerminalKind,
        action: &KeyAction,
        tick: u32,
        now: Instant,
    ) {
        let awaiting = self
            .terminal
            .get_or_insert(TerminalSession {
                hwnd,
                kind,
                idle_line: None,
                typed: 0,
                packets: false,
                screen: None,
                read_due: Some(now),
                awaiting: None,
            })
            .awaiting
            .is_some();
        // Typing the next command means the last one's output is as complete as it will be.
        if awaiting
            && matches!(
                action,
                KeyAction::Text(_) | KeyAction::Packet | KeyAction::Enter
            )
        {
            self.finish_command();
        }
        let Some(session) = self.terminal.as_mut() else {
            return;
        };
        match action {
            KeyAction::Enter => {
                session.awaiting = Some(Awaiting {
                    enter_tick: tick,
                    before: session.screen.take(),
                    typed: session.typed,
                    packets: session.packets,
                    idle_line: session.idle_line.clone(),
                    last_screen: None,
                    last_change: now,
                    next_poll: now + OUTPUT_POLL,
                    started: now,
                });
                session.typed = 0;
                session.packets = false;
                session.read_due = None;
            }
            KeyAction::Packet => {
                session.packets = true;
                session.read_due.get_or_insert(now + READ_AFTER_KEYS);
            }
            KeyAction::Text(text) => {
                session.typed += text.chars().count();
                session.read_due.get_or_insert(now + READ_AFTER_KEYS);
            }
            _ => {
                session.read_due.get_or_insert(now + READ_AFTER_KEYS);
            }
        }
    }

    /// Reads the terminal's screen and, while a command's output is arriving, checks whether it
    /// has settled.
    pub(super) fn terminal_tick(&mut self, now: Instant) {
        let Some(session) = self.terminal.as_mut() else {
            return;
        };
        let (hwnd, kind) = (session.hwnd, session.kind);
        if session.read_due.is_some_and(|due| now >= due) {
            session.read_due = None;
            let screen = self.desktop.terminal(hwnd, kind);
            if let Some(session) = self.terminal.as_mut() {
                if session.idle_line.is_none() && session.awaiting.is_none() {
                    session.idle_line = screen.as_deref().and_then(current_line);
                }
                session.screen = screen;
            }
        }
        let settle = self.options.settle;
        let Some(awaiting) = self
            .terminal
            .as_mut()
            .and_then(|session| session.awaiting.as_mut())
        else {
            return;
        };
        if now < awaiting.next_poll {
            return;
        }
        awaiting.next_poll = now + OUTPUT_POLL;
        let screen = self.desktop.terminal(hwnd, kind);
        let Some(awaiting) = self
            .terminal
            .as_mut()
            .and_then(|session| session.awaiting.as_mut())
        else {
            return;
        };
        if screen != awaiting.last_screen {
            awaiting.last_screen = screen;
            awaiting.last_change = now;
        }
        let settled =
            awaiting.last_screen.is_some() && now.duration_since(awaiting.last_change) >= settle;
        if settled || now.duration_since(awaiting.started) >= OUTPUT_LIMIT {
            self.finish_command();
        }
    }

    /// Makes the step for the command being waited for, from the screen as it is now.
    fn finish_command(&mut self) {
        let Some(session) = self.terminal.as_mut() else {
            return;
        };
        let Some(awaiting) = session.awaiting.take() else {
            return;
        };
        let (hwnd, kind) = (session.hwnd, session.kind);
        let screen = self.desktop.terminal(hwnd, kind).or(awaiting.last_screen);
        let Some(screen) = screen else {
            return;
        };
        if let Some(session) = self.terminal.as_mut() {
            session.idle_line = current_line(&screen);
            session.screen = None;
        }
        // What another program typed keeps no value, and a command or reply is all value: no step
        // (decision of 11/10/2026, #91).
        if awaiting.packets {
            return;
        }
        let Some(command) = read_command(awaiting.before.as_deref(), &screen) else {
            return;
        };
        if command.command.trim().is_empty() {
            return;
        }
        // A hidden prompt (a password being typed) shows nothing of what was typed: the line
        // before Enter is the line before typing.
        let before_line = awaiting.before.as_deref().and_then(current_line);
        if awaiting.typed >= 2 && before_line.is_some() && before_line == awaiting.idle_line {
            return;
        }
        if looks_like_masked_entry(&command.command) {
            return;
        }
        let Some((window, _)) = self.window(hwnd) else {
            return;
        };
        // Enter at a line with no shell prompt answers a program ("Name: sam", "PIN: ****"): not
        // a new command. A starred answer is dropped; a visible one reads as typing.
        if let Some(line) = before_line.as_deref()
            && split_prompt(line).is_none()
        {
            // Nor one to a question about a password or key ("Enter password: hunter2", from
            // Read-Host or input()): shown on screen, but never kept as text in the guide.
            if !looks_like_masked_entry(line) && !crate::sensitive::looks_sensitive(&[line], &[]) {
                self.reply_step(&window, line, awaiting.enter_tick);
            }
            return;
        }
        let shell = match command.shell {
            Shell::Unknown if kind == TerminalKind::Console => {
                window.exe_name().map_or(Shell::Unknown, Shell::from_exe)
            }
            shell => shell,
        };
        let masked = mask_command(&command.command, &self.options.extra_terms);
        let (output, shortened) = if self.options.output {
            let (text, cut) = fit_output(&command.output);
            (
                Some(mask_output(&text, &masked.secrets)),
                cut || command.output_cut,
            )
        } else {
            (None, false)
        };
        let mut shot = self.shoot(&window);
        let check_screenshot = shot
            .as_mut()
            .is_some_and(|shot| !blur_secrets(shot, &masked.secrets));
        let id = self.next_id();
        let capture = shot
            .as_ref()
            .map(|shot| CaptureFacts::of(shot, self.options.mode));
        let record = Record::Command(CommandRecord {
            id,
            tick_ms: awaiting.enter_tick,
            window: window_facts(&window),
            capture,
            terminal: kind.as_str(),
            language: shell.language(),
            command: masked.text,
            output,
            output_shortened: shortened,
            check_screenshot,
        });
        let _ = self.out.send((record, shot.map(|shot| shot.image)));
    }

    /// An answer typed at a program's own prompt in a terminal, as a typing step: `Type "sam"`.
    fn reply_step(&mut self, window: &WindowInfo, line: &str, tick: u32) {
        let answer = reply_text(line);
        if answer.is_empty() {
            return;
        }
        let shot = self.shoot(window);
        let id = self.next_id();
        let capture = shot
            .as_ref()
            .map(|shot| CaptureFacts::of(shot, self.options.mode));
        let record = Record::Typing(TypingRecord {
            id,
            tick_ms: tick,
            window: window_facts(window),
            capture,
            element: None,
            text: mask_value(answer),
            form: "text",
            language: "plain",
            cell: None,
            approximate: false,
            check_screenshot: false,
        });
        let _ = self.out.send((record, shot.map(|shot| shot.image)));
    }

    pub(super) fn end_terminal(&mut self) {
        self.finish_command();
        self.terminal = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starred_replies_are_not_commands() {
        assert!(looks_like_masked_entry("Password: ********"));
        assert!(looks_like_masked_entry("Enter PIN: ••••"));
        assert!(!looks_like_masked_entry("Get-Date"));
        assert!(!looks_like_masked_entry("Get-ChildItem *"));
        assert!(!looks_like_masked_entry("Password:"));
    }

    #[test]
    fn replies_to_a_program_keep_just_the_answer() {
        assert_eq!(reply_text("Name: sam"), "sam");
        assert_eq!(reply_text("Continue? [Y] Yes  [N] No: Y"), "Y");
        assert_eq!(reply_text("yes"), "yes");
    }
}
