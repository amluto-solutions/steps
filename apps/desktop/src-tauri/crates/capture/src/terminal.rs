//! A command and its output, read from what a terminal shows (docs/spec/02-capture.md#terminals).
//!
//! The command line is taken from the screen, not from the keys, so Tab completion, history
//! (Up arrow) and pastes come out as they ran, and what a terminal never shows (a hidden password
//! prompt) is never captured. Enter is only the signal to look.

/// The shell a prompt belongs to, which sets the code block's language.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shell {
    PowerShell,
    Cmd,
    Bash,
    /// No prompt this code recognises: plain monospace.
    Unknown,
}

impl Shell {
    /// The language id stored with the step (packages/core/src/guide.ts, `code.language`).
    #[must_use]
    pub fn language(self) -> &'static str {
        match self {
            Self::PowerShell => "powershell",
            Self::Cmd => "cmd",
            Self::Bash => "bash",
            Self::Unknown => "plain",
        }
    }

    /// From the program running in a classic console window, when its prompt says nothing.
    #[must_use]
    pub fn from_exe(exe: &str) -> Self {
        match exe.to_ascii_lowercase().as_str() {
            "powershell.exe" | "pwsh.exe" => Self::PowerShell,
            "cmd.exe" => Self::Cmd,
            "bash.exe" | "wsl.exe" | "ubuntu.exe" | "debian.exe" => Self::Bash,
            _ => Self::Unknown,
        }
    }
}

/// A prompt at the start of a line: `PS C:\Users\sam> `, `C:\Users\sam>`, `sam@pc:~$ `.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompt {
    pub shell: Shell,
    /// The prompt as shown, including one space after it if there is one.
    pub text: String,
}

/// The prompt a line starts with, and the rest of the line.
#[must_use]
pub fn split_prompt(line: &str) -> Option<(Prompt, &str)> {
    let found = powershell_prompt(line)
        .map(|end| (Shell::PowerShell, end))
        .or_else(|| cmd_prompt(line).map(|end| (Shell::Cmd, end)))
        .or_else(|| bash_prompt(line).map(|end| (Shell::Bash, end)))?;
    let (shell, mut end) = found;
    if line[end..].starts_with(' ') {
        end += 1;
    }
    Some((
        Prompt {
            shell,
            text: line[..end].to_string(),
        },
        &line[end..],
    ))
}

/// `PS <location>>`: the end of the `>`.
fn powershell_prompt(line: &str) -> Option<usize> {
    let rest = line.strip_prefix("PS ")?;
    let close = rest.find('>')?;
    (close > 0).then_some(3 + close + 1)
}

/// `C:\<path>>` (and `\\server\share>`).
fn cmd_prompt(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let drive = bytes.first().is_some_and(u8::is_ascii_alphabetic)
        && bytes.get(1) == Some(&b':')
        && bytes.get(2) == Some(&b'\\');
    let share = line.starts_with(r"\\");
    if !drive && !share {
        return None;
    }
    let close = line.find('>')?;
    // A path has no quotes or pipes; a line of output that happens to start like one does.
    (!line[..close].contains(['"', '|', '<'])).then_some(close + 1)
}

/// `user@host:path$` or `#`, or a bare `$`.
fn bash_prompt(line: &str) -> Option<usize> {
    if line.starts_with("$ ") || line == "$" || line.starts_with("# ") {
        return Some(1);
    }
    let at = line.find('@')?;
    if at == 0 || line[..at].contains(char::is_whitespace) {
        return None;
    }
    let colon = at + line[at..].find(':')?;
    if line[at..colon].contains(char::is_whitespace) {
        return None;
    }
    let tail = &line[colon..];
    let end = tail
        .char_indices()
        .find(|&(index, ch)| {
            (ch == '$' || ch == '#')
                && tail[index + 1..]
                    .chars()
                    .next()
                    .is_none_or(char::is_whitespace)
        })
        .map(|(index, _)| colon + index + 1)?;
    Some(end)
}

/// The lines a terminal shows, trimmed at the end. When every row is padded to the same width
/// (the classic console), a row that fills it right to the edge carries on in the next one, so
/// the two are joined back into the line that was wrapped.
#[must_use]
pub fn screen_lines(text: &str) -> Vec<String> {
    let rows: Vec<&str> = text
        .split('\n')
        .map(|row| row.strip_suffix('\r').unwrap_or(row))
        .collect();
    let width = padded_width(&rows);
    let mut lines: Vec<String> = Vec::new();
    let mut carry = false;
    for row in rows {
        let full = width.is_some_and(|width| {
            row.chars().count() == width && !row.ends_with(char::is_whitespace)
        });
        let trimmed = row.trim_end();
        match lines.last_mut() {
            Some(last) if carry => last.push_str(trimmed),
            _ => lines.push(trimmed.to_string()),
        }
        carry = full;
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    lines
}

/// The row width, when (nearly) every row is padded to one width.
fn padded_width(rows: &[&str]) -> Option<usize> {
    let first = rows.first()?.chars().count();
    if first < 20 || rows.len() < 2 {
        return None;
    }
    let same = rows
        .iter()
        .filter(|row| row.chars().count() == first)
        .count();
    (same * 10 >= rows.len() * 9).then_some(first)
}

/// The line the cursor is on before Enter: the last line with anything on it.
#[must_use]
pub fn current_line(text: &str) -> Option<String> {
    screen_lines(text)
        .into_iter()
        .rev()
        .find(|line| !line.trim().is_empty())
}

/// A command read off the screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub shell: Shell,
    /// As it ran, without the prompt.
    pub command: String,
    pub output: Vec<String>,
    /// The start of the output (or the command's own line) had scrolled out of view.
    pub output_cut: bool,
    /// The next prompt is showing: the command has finished.
    pub finished: bool,
}

/// Reads the command that `before` (the screen just before Enter) was about to run, and its output,
/// from `after` (the screen once the output has settled). `before` gives the prompt to look for;
/// the command itself is taken from `after`, where it is complete even if `before` was read a
/// moment before the last key.
#[must_use]
pub fn read_command(before: Option<&str>, after: &str) -> Option<Command> {
    let lines = screen_lines(after);
    let typed_at = before.and_then(current_line);
    let prompt = typed_at
        .as_deref()
        .and_then(split_prompt)
        .map(|(prompt, _)| prompt);

    let last = lines.iter().rposition(|line| !line.trim().is_empty())?;

    // What had been typed before Enter (perhaps a key short): the command's line starts with it
    // at the same prompt. Finding that first means a next command already begun below isn't taken
    // for it (found live: typing the next command is what ends the wait for this one's output).
    let typed = typed_at
        .as_deref()
        .and_then(split_prompt)
        .map(|(_, rest)| rest.trim().to_string())
        .filter(|rest| !rest.is_empty());
    if let (Some(typed), Some(prompt)) = (&typed, &prompt)
        && let Some(start) = (0..=last).rev().find(|&index| {
            split_prompt(&lines[index]).is_some_and(|(found, rest)| {
                found.text.trim_end() == prompt.text.trim_end()
                    && rest.trim_start().starts_with(typed.as_str())
            })
        })
        && let Some((found, rest)) = split_prompt(&lines[start])
    {
        let next = (start + 1..=last).find(|&index| {
            split_prompt(&lines[index]).is_some_and(|(next, _)| next.shell == found.shell)
        });
        let end = next.unwrap_or(last + 1);
        return Some(tidy(Command {
            shell: found.shell,
            command: rest.trim().to_string(),
            output: lines[start + 1..end].to_vec(),
            output_cut: false,
            finished: next.is_some(),
        }));
    }

    let starts_with_prompt = |line: &str| match &prompt {
        Some(prompt) => line.starts_with(prompt.text.trim_end()),
        None => split_prompt(line).is_some(),
    };
    // The next command's prompt, with nothing typed at it yet.
    let is_next_prompt = |line: &str| {
        split_prompt(line).is_some_and(|(next, rest)| {
            rest.trim().is_empty()
                && prompt
                    .as_ref()
                    .is_none_or(|prompt| prompt.shell == next.shell)
        })
    };
    let (end, finished) = if last > 0 && is_next_prompt(&lines[last]) {
        (last, true)
    } else {
        (last + 1, false)
    };

    let start = (0..end)
        .rev()
        .find(|&index| starts_with_prompt(&lines[index]));
    let (shell, command, output, output_cut) = if let Some(start) = start {
        let line = &lines[start];
        let (shell, command) = match split_prompt(line) {
            Some((found, rest)) => (found.shell, rest.trim().to_string()),
            None => (
                prompt
                    .as_ref()
                    .map_or(Shell::Unknown, |prompt| prompt.shell),
                line.get(
                    prompt
                        .as_ref()
                        .map_or(0, |prompt| prompt.text.trim_end().len())..,
                )
                .unwrap_or("")
                .trim()
                .to_string(),
            ),
        };
        (shell, command, lines[start + 1..end].to_vec(), false)
    } else {
        // The command's line has scrolled away: take it from before Enter, and everything shown.
        let typed = typed_at?;
        let (shell, command) = match split_prompt(&typed) {
            Some((found, rest)) => (found.shell, rest.trim().to_string()),
            None => (Shell::Unknown, typed.trim().to_string()),
        };
        (shell, command, lines[..end].to_vec(), true)
    };

    Some(tidy(Command {
        shell,
        command,
        output,
        output_cut,
        finished,
    }))
}

/// Blank lines at the start and end of the output are dropped.
fn tidy(mut command: Command) -> Command {
    let output = &mut command.output;
    while output.first().is_some_and(|line| line.trim().is_empty()) {
        output.remove(0);
    }
    while output.last().is_some_and(|line| line.trim().is_empty()) {
        output.pop();
    }
    command
}

/// The most output a step keeps (docs/spec/02-capture.md#terminals).
pub const MAX_OUTPUT_LINES: usize = 200;
pub const MAX_OUTPUT_BYTES: usize = 16 * 1024;

/// Output cut to what a step keeps: the first 200 lines, at most 16 KB. `true` when anything was
/// cut, shown as "…shortened".
#[must_use]
pub fn fit_output(lines: &[String]) -> (String, bool) {
    let mut out = String::new();
    let mut cut = lines.len() > MAX_OUTPUT_LINES;
    for line in lines.iter().take(MAX_OUTPUT_LINES) {
        let needed = line.len() + usize::from(!out.is_empty());
        if out.len() + needed > MAX_OUTPUT_BYTES {
            cut = true;
            break;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
    }
    (out, cut)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_are_recognised_by_shell() {
        let (prompt, rest) = split_prompt(r"PS C:\Users\sam> Get-Date").unwrap();
        assert_eq!(prompt.shell, Shell::PowerShell);
        assert_eq!(prompt.text, r"PS C:\Users\sam> ");
        assert_eq!(rest, "Get-Date");

        let (prompt, rest) = split_prompt(r"C:\Users\sam>dir /s").unwrap();
        assert_eq!(prompt.shell, Shell::Cmd);
        assert_eq!(rest, "dir /s");

        let (prompt, rest) = split_prompt("sam@PC-20:~/my dir$ ls -la").unwrap();
        assert_eq!(prompt.shell, Shell::Bash);
        assert_eq!(prompt.text, "sam@PC-20:~/my dir$ ");
        assert_eq!(rest, "ls -la");

        let (prompt, rest) = split_prompt("root@web:/etc# systemctl restart nginx").unwrap();
        assert_eq!(prompt.shell, Shell::Bash);
        assert_eq!(rest, "systemctl restart nginx");

        for text in [
            "Identity   User   AccessRights",
            "Directory: C:\\Temp",
            "anna@contoso.co.uk has full access",
            "",
            "PS>",
        ] {
            assert!(split_prompt(text).is_none(), "{text}");
        }
    }

    const WIDTH: usize = 40;

    /// A classic-console screen: every row padded to the width.
    fn console(rows: &[&str]) -> String {
        rows.iter()
            .map(|row| format!("{row:<WIDTH$}"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn a_finished_command_and_its_output() {
        let before = console(&[r"PS C:\> Get-Thing -Name", ""]);
        let after = console(&[
            r"PS C:\> Get-Thing -Name sales",
            "",
            "Name   Size",
            "sales  12",
            "",
            r"PS C:\> ",
            "",
        ]);
        let command = read_command(Some(&before), &after).unwrap();
        assert_eq!(command.shell, Shell::PowerShell);
        assert_eq!(
            command.command, "Get-Thing -Name sales",
            "complete, though read late"
        );
        assert_eq!(command.output, ["Name   Size", "sales  12"]);
        assert!(command.finished);
        assert!(!command.output_cut);
    }

    #[test]
    fn a_command_still_running_takes_what_it_has_printed() {
        let before = console(&["C:\\>ping -t 10.0.0.1"]);
        let after = console(&[
            "C:\\>ping -t 10.0.0.1",
            "",
            "Pinging 10.0.0.1 with 32 bytes of data:",
            "Reply from 10.0.0.1: time<1ms",
        ]);
        let command = read_command(Some(&before), &after).unwrap();
        assert_eq!(command.shell, Shell::Cmd);
        assert_eq!(command.command, "ping -t 10.0.0.1");
        assert_eq!(command.output.len(), 2);
        assert!(!command.finished);
    }

    #[test]
    fn the_next_command_already_begun_below_is_not_taken() {
        // Found live: the first key of the next command ends the wait, and is on screen by then.
        let before = r"PS C:\> Write-Output -Pass";
        let after = "PS C:\\> Write-Output -Password x\nx\nPS C:\\> $n = Re";
        let command = read_command(Some(before), after).unwrap();
        assert_eq!(command.command, "Write-Output -Password x");
        assert_eq!(command.output, ["x"]);
        assert!(command.finished);
    }

    #[test]
    fn earlier_commands_on_screen_are_not_taken() {
        let after = console(&[
            r"PS C:\> first",
            "one",
            r"PS C:\> second",
            "two",
            r"PS C:\>",
        ]);
        let command = read_command(Some(&console(&[r"PS C:\> second"])), &after).unwrap();
        assert_eq!(command.command, "second");
        assert_eq!(command.output, ["two"]);
    }

    #[test]
    fn a_wrapped_command_is_joined_back_up() {
        // 40 columns: the command runs on into the next row, which starts with a space.
        let full = r"PS C:\> Set-Thing -Identity sales -Users anna@contoso.co.uk";
        let after = console(&[&full[..WIDTH], &full[WIDTH..], r"PS C:\>"]);
        let command = read_command(None, &after).unwrap();
        assert_eq!(
            command.command,
            "Set-Thing -Identity sales -Users anna@contoso.co.uk"
        );
    }

    #[test]
    fn cleared_screens_and_long_output_fall_back_to_the_line_before_enter() {
        let before = console(&[r"PS C:\> Get-Process"]);
        let after = console(&["svchost 12", "explorer 3", r"PS C:\>"]);
        let command = read_command(Some(&before), &after).unwrap();
        assert_eq!(command.command, "Get-Process");
        assert_eq!(command.output, ["svchost 12", "explorer 3"]);
        assert!(command.output_cut);
    }

    #[test]
    fn unpadded_screens_work_too() {
        // Windows Terminal doesn't pad its rows.
        let after = "sam@pc:~$ uname -a\nLinux pc 6.1\nsam@pc:~$ ";
        let command = read_command(Some("sam@pc:~$ uname -a"), after).unwrap();
        assert_eq!(command.shell, Shell::Bash);
        assert_eq!(command.command, "uname -a");
        assert_eq!(command.output, ["Linux pc 6.1"]);
        assert!(command.finished);
    }

    #[test]
    fn output_is_cut_to_what_a_step_keeps() {
        let many: Vec<String> = (0..300).map(|index| format!("line {index}")).collect();
        let (text, cut) = fit_output(&many);
        assert!(cut);
        assert_eq!(text.lines().count(), MAX_OUTPUT_LINES);
        let wide = vec!["x".repeat(10_000), "y".repeat(10_000)];
        let (text, cut) = fit_output(&wide);
        assert!(cut);
        assert_eq!(text.len(), 10_000);
        let (text, cut) = fit_output(&["a".to_string(), "b".to_string()]);
        assert_eq!((text.as_str(), cut), ("a\nb", false));
    }

    #[test]
    fn the_shell_can_come_from_the_program() {
        assert_eq!(Shell::from_exe("PowerShell.exe"), Shell::PowerShell);
        assert_eq!(Shell::from_exe("pwsh.exe"), Shell::PowerShell);
        assert_eq!(Shell::from_exe("cmd.exe"), Shell::Cmd);
        assert_eq!(Shell::from_exe("wsl.exe"), Shell::Bash);
        assert_eq!(Shell::from_exe("python.exe"), Shell::Unknown);
    }
}
