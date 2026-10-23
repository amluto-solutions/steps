//! Dictation (docs/spec/02-capture.md#keys, #91): text Windows voice typing (Win+H) put into a
//! text box. Windows hands dictated text straight to an app that takes text through the Text
//! Services Framework (Notepad, Word, Chrome), so no key reaches the keyboard watcher: the key
//! worker reads the text box with focus through UI Automation when a stretch of time with no
//! keys ends (a click, a focus change, a key combination such as Win+H, Pause or Stop), and what
//! was added since the last read is the dictation, kept only when voice typing was evidently in
//! use (`typing/dictation.rs`, 12/10/2026). Text another program typed as Unicode packets (`VK_PACKET`:
//! password-manager auto-type) arrives as keys and never keeps a value (decision of 11/10/2026).

/// The longest text box whose text is compared, in UTF-16 units as UI Automation counts them:
/// a longer document isn't read for dictation, so no read can be costly. Windows only: Linux
/// watches no text box.
#[cfg(windows)]
pub(crate) const MAX_TEXT_BOX: usize = 100_000;

/// The program that draws Windows' voice typing panel (Win+H). It draws the emoji panel (Win+.),
/// clipboard history (Win+V) and the touch keyboard too, and their windows can't be told from the
/// voice typing panel's by the window alone. The TypeScript naming knows it by the same name
/// (`packages/core/test-vectors/click-naming.json`, `inputPanelPrograms`).
const TEXT_INPUT_HOST: &str = "TextInputHost.exe";

/// Whether a program, by its file name in any case, is the text input host: its windows are
/// Windows' input panels, where a clipboard history item can be named after the text it holds
/// (#109).
pub(crate) fn is_text_input_host(exe: &str) -> bool {
    exe.eq_ignore_ascii_case(TEXT_INPUT_HOST)
}

/// The frames of the text input host's windows that show (#91): the voice typing panel, or
/// another panel that program draws. Linux has none.
pub(crate) fn text_input_panels() -> Vec<crate::platform::Rect> {
    text_input_panels_among(
        &crate::platform::window::shown_windows(),
        crate::platform::window::process_exe_name,
    )
}

/// The frames of those of `windows` that are the text input host's: its own, or a frame Windows
/// draws round it (Windows 11 shows the emoji panel in a frame of `explorer.exe`'s round the host's
/// core window: build 26300, 12/10/2026, #109). `program` names the program of a process (asked
/// once for each).
pub(crate) fn text_input_panels_among(
    windows: &[crate::platform::window::ShownWindow],
    mut program: impl FnMut(u32) -> Option<String>,
) -> Vec<crate::platform::Rect> {
    let mut programs = std::collections::HashMap::new();
    let mut is_host = |pid: u32| {
        programs
            .entry(pid)
            .or_insert_with(|| program(pid))
            .as_deref()
            .is_some_and(is_text_input_host)
    };
    windows
        .iter()
        .filter(|shown| is_host(shown.pid) || shown.hosted_pid.is_some_and(&mut is_host))
        .map(|shown| shown.frame)
        .collect()
}

/// What was added to a text box that held `before` and now holds `after`: the text between what
/// the two share at their start and at their end, widened to whole words, trimmed. `None` when
/// nothing was added (text only taken away, or only spaces and new lines added), or when the
/// change took in text that was already there (text put in at two places, with what lay between
/// counted again). Compared by character, so a character beyond the basic plane (an emoji, a
/// surrogate pair in UI Automation's UTF-16) is never split.
pub(crate) fn dictated(before: &str, after: &str) -> Option<String> {
    // Word ends paragraphs with a carriage return, Notepad lines with both.
    let before: Vec<char> = lines(before).chars().collect();
    let after: Vec<char> = lines(after).chars().collect();
    let mut start = before
        .iter()
        .zip(&after)
        .take_while(|(old, new)| old == new)
        .count();
    let mut end = before[start..]
        .iter()
        .rev()
        .zip(after[start..].iter().rev())
        .take_while(|(old, new)| old == new)
        .count();
    // A word spoken over a selected one ("Monday" to "Tuesday") shares letters with it: the
    // change is taken from the start of the word to its end, which the two texts share.
    let word = |at: usize| after.get(at).is_some_and(|ch| ch.is_alphanumeric());
    if start < after.len() - end && word(start) {
        while start > 0 && word(start - 1) {
            start -= 1;
        }
    }
    if start < after.len() - end && after.len() - end > 0 && word(after.len() - end - 1) {
        while end > 0 && word(after.len() - end) {
            end -= 1;
        }
    }
    let removed: String = before[start..before.len() - end].iter().collect();
    let added: String = after[start..after.len() - end].iter().collect();
    let added = added.trim();
    if added.is_empty() || (!removed.trim().is_empty() && added.contains(removed.trim())) {
        return None;
    }
    Some(added.to_string())
}

/// Text with every line ending and line break written `\n` (Word's line break is a vertical tab),
/// and without the other control characters a document's text can hold (Word's table cell ends).
fn lines(text: &str) -> String {
    text.replace("\r\n", "\n")
        .chars()
        .map(|ch| {
            if matches!(ch, '\r' | '\u{b}') {
                '\n'
            } else {
                ch
            }
        })
        .filter(|ch| !ch.is_control() || matches!(ch, '\n' | '\t'))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The check on a real desktop (#91), for dictating into: it prints what the recorder sees,
    /// with the milliseconds since it began. Keys as Raw Input gives them (a Unicode packet's
    /// character is never kept, and typing shows only how many characters), the window in front
    /// and whether the voice typing panel (`TextInputHost.exe`) shows, focus changes, UI
    /// Automation's text-changed and value-changed events, and each text box with focus read as
    /// the key worker reads it: its text when focus came and when it left, and what dictation
    /// added. Runs for 60 seconds, or `DICTATION_PROBE_SECONDS`.
    #[cfg(windows)]
    #[test]
    #[ignore = "listens to the keyboard while you dictate: cargo test -p capture dictation_probe -- --ignored --nocapture"]
    #[allow(
        clippy::too_many_lines,
        reason = "a probe that prints one line per thing it sees"
    )]
    fn dictation_probe() {
        use std::sync::atomic::Ordering;
        use std::time::{Duration, Instant};

        use uiautomation::UIAutomation;
        use uiautomation::events::{
            CustomEventHandlerFn, CustomFocusChangedEventHandlerFn,
            CustomPropertyChangedEventHandlerFn, UIEventHandler, UIEventType,
            UIFocusChangedEventHandler, UIPropertyChangedEventHandler,
        };
        use uiautomation::types::{TreeScope, UIProperty};

        use crate::keys::{KeyAction, KeyReader};
        use crate::platform::input::{InputCapture, InputSource};
        use crate::platform::window;
        use crate::screen_text::ScreenText;

        fn short(text: &str) -> String {
            let text = text.replace('\r', "\\r").replace('\n', "\\n");
            match text.char_indices().nth(300) {
                Some((at, _)) => format!("{}…", &text[..at]),
                None => text,
            }
        }
        fn describe(element: &uiautomation::UIElement) -> String {
            format!(
                "{:?} {:?} class {:?} id {:?} framework {:?} pid {:?}",
                element.get_control_type().ok(),
                element.get_name().unwrap_or_default(),
                element.get_classname().unwrap_or_default(),
                element.get_automation_id().unwrap_or_default(),
                element.get_framework_id().unwrap_or_default(),
                element.get_process_id().ok(),
            )
        }

        let seconds = std::env::var("DICTATION_PROBE_SECONDS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(60);
        let start = Instant::now();
        let ms = move || start.elapsed().as_millis();
        println!(
            "Listening for {seconds} s. Click into Notepad, Word or a form field, press Win+H and \
             speak; try a password manager's auto-type too."
        );

        let input = InputCapture::start(InputSource::RawInput).expect("the input thread starts");
        input.shared().enabled.store(true, Ordering::SeqCst);
        input.set_keyboard(true).expect("the keyboard registers");

        let automation = UIAutomation::new().expect("UI Automation starts");
        let root = automation.get_root_element().expect("the desktop element");
        let focus: Box<CustomFocusChangedEventHandlerFn> = Box::new(move |element| {
            println!("{:>6} focus  {}", ms(), describe(element));
            Ok(())
        });
        let focus = UIFocusChangedEventHandler::from(focus);
        automation
            .add_focus_changed_event_handler(None, &focus)
            .expect("focus events");
        let changed: Box<CustomEventHandlerFn> = Box::new(move |element, kind| {
            println!("{:>6} event  {kind:?} from {}", ms(), describe(element));
            Ok(())
        });
        let changed = UIEventHandler::from(changed);
        for kind in [
            UIEventType::Text_TextChanged,
            UIEventType::TextEdit_TextChanged,
        ] {
            automation
                .add_automation_event_handler(kind, &root, TreeScope::Subtree, None, &changed)
                .expect("text events");
        }
        let value: Box<CustomPropertyChangedEventHandlerFn> = Box::new(move |element, _, value| {
            let length = value.get_string().map(|text| text.chars().count()).ok();
            println!(
                "{:>6} value  changed ({length:?} characters) in {}",
                ms(),
                describe(element)
            );
            Ok(())
        });
        let value = UIPropertyChangedEventHandler::from(value);
        automation
            .add_property_changed_event_handler(
                &root,
                TreeScope::Subtree,
                None,
                &value,
                &[UIProperty::ValueValue],
            )
            .expect("value events");

        let mut text = ScreenText::new().expect("the key worker's UI Automation starts");
        let mut reader = KeyReader::new(crate::platform::keyboard::caps_lock_on());
        let mut watched: Option<(String, String)> = None;
        let mut last_focus = String::new();
        let mut last_panel = Vec::new();
        let mut last_front = 0;
        let until = start + Duration::from_secs(seconds);
        while Instant::now() < until {
            while let Some(key) = input.shared().pop_key() {
                let action = reader.read(&key, crate::platform::keyboard::typed_text);
                let action = match action {
                    Some(KeyAction::Text(typed)) => {
                        format!("Text({} chars)", typed.chars().count())
                    }
                    other => format!("{other:?}"),
                };
                let front = window::window_info(key.foreground)
                    .map(|window| format!("{:?} {:?}", window.exe_name(), window.title))
                    .unwrap_or_default();
                println!(
                    "{:>6} key    vkey {:#04x} scan {:#06x} up {} injected {} extended {} -> {action} in {front}",
                    ms(),
                    key.vkey,
                    key.scan,
                    key.up,
                    key.injected,
                    key.extended,
                );
            }
            if let Some(front) = window::foreground_window()
                && front.hwnd != last_front
            {
                last_front = front.hwnd;
                println!(
                    "{:>6} front  {:?} {:?}",
                    ms(),
                    front.exe_name(),
                    front.title
                );
            }
            let panel = text_input_panels();
            if panel != last_panel {
                println!(
                    "{:>6} panel  TextInputHost.exe windows showing: {panel:?}",
                    ms()
                );
                last_panel = panel;
            }
            // The element with focus, as the key worker would watch it.
            let focused = automation.get_focused_element().ok();
            let facts = focused.as_ref().map(describe).unwrap_or_default();
            if facts != last_focus {
                if let Some((name, before)) = watched.take() {
                    let after = text.text_box_text();
                    println!(
                        "{:>6} read   {name} as focus left: {:?}",
                        ms(),
                        after.as_deref().map(short)
                    );
                    println!(
                        "{:>6} added  {:?}",
                        ms(),
                        after.and_then(|after| dictated(&before, &after))
                    );
                }
                text.forget_text_box();
                if let Some(element) = focused.as_ref()
                    && let Some(found) = focused_facts(element)
                {
                    match text.watch_text_box(&found.0, found.1, &[]) {
                        Some(before) => {
                            println!("{:>6} watch  {facts}: {:?}", ms(), short(&before));
                            watched = Some((facts.clone(), before));
                        }
                        None => println!(
                            "{:>6} skip   {facts}: not a text box that can be typed in, a \
                             password or sensitive box, or its text can't be read ({})",
                            ms(),
                            read_only_answers(element)
                        ),
                    }
                }
                last_focus = facts;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        if let Some((name, before)) = watched {
            let after = text.text_box_text();
            println!(
                "{:>6} read   {name} at the end: {:?}",
                ms(),
                after.as_deref().map(short)
            );
            println!(
                "{:>6} added  {:?}",
                ms(),
                after.and_then(|after| dictated(&before, &after))
            );
        }
        println!(
            "Unicode packets counted: {:?}",
            crate::platform::input::unicode_packets()
        );
        let _ = automation.remove_all_event_handlers();
        input.stop();
    }

    /// What an element says of being read-only, which decides whether it's watched: its Text
    /// pattern's `IsReadOnly` attribute and its Value pattern's, and how long its text is.
    #[cfg(windows)]
    fn read_only_answers(element: &uiautomation::UIElement) -> String {
        use uiautomation::patterns::{UITextPattern, UIValuePattern};
        use uiautomation::types::TextAttribute;
        let range = element
            .get_pattern::<UITextPattern>()
            .ok()
            .and_then(|pattern| pattern.get_document_range().ok());
        let text_read_only = range.as_ref().map(|range| {
            range
                .get_attribute_value(TextAttribute::IsReadOnly)
                .map(|value| {
                    TryInto::<bool>::try_into(value)
                        .map_err(|_| "no yes or no: mixed, or not supported")
                })
        });
        let length = range.and_then(|range| {
            range
                .get_text(i32::try_from(MAX_TEXT_BOX + 1).ok()?)
                .ok()
                .map(|text| text.encode_utf16().count())
        });
        let value_read_only = element
            .get_pattern::<UIValuePattern>()
            .ok()
            .map(|pattern| pattern.is_readonly());
        format!(
            "Text pattern IsReadOnly {text_read_only:?}, length {length:?}; Value pattern \
             read-only {value_read_only:?}"
        )
    }

    /// The facts and process of an element, read as the focus handler reads them.
    #[cfg(windows)]
    fn focused_facts(
        element: &uiautomation::UIElement,
    ) -> Option<(crate::facts::ElementFacts, u32)> {
        let automation = uiautomation::UIAutomation::new().ok()?;
        let cache = crate::uia::element_cache(&automation).ok()?;
        let element = element.build_updated_cache(&cache).ok()?;
        let pid = u32::try_from(element.get_cached_process_id().ok()?).ok()?;
        Some((crate::uia::facts_from_cached(&element, &[]), pid))
    }

    #[test]
    fn the_input_panels_program_is_the_one_the_naming_knows() {
        // `packages/core/test-vectors/click-naming.json`: the TypeScript naming leaves a click in
        // one of its windows unnamed by the same program (#109).
        let shared: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../../packages/core/test-vectors/click-naming.json"
        ))
        .unwrap();
        assert_eq!(
            shared["inputPanelPrograms"],
            serde_json::json!([TEXT_INPUT_HOST])
        );
        assert!(is_text_input_host("textinputhost.exe"));
        assert!(is_text_input_host("TEXTINPUTHOST.EXE"));
        assert!(!is_text_input_host("notepad.exe"));
        assert!(!is_text_input_host("TextInputHost.exe.old"));
    }

    #[test]
    fn the_input_panels_are_the_text_input_hosts_windows() {
        let frame = |left: i32| crate::platform::Rect {
            left,
            top: 0,
            right: left + 100,
            bottom: 100,
        };
        let shown = |pid: u32, left: i32| crate::platform::window::ShownWindow {
            hwnd: 0,
            pid,
            frame: frame(left),
            see_through: false,
            click_through: false,
            notification: false,
            hosted_pid: None,
        };
        // Front to back: clipboard history, Notepad under it, the host's other window, and a
        // window whose program can't be named.
        let windows = [shown(9, 0), shown(4, 100), shown(9, 200), shown(5, 300)];
        let mut asked = Vec::new();
        let panels = text_input_panels_among(&windows, |pid| {
            asked.push(pid);
            match pid {
                9 => Some("TextInputHost.exe".to_string()),
                4 => Some("notepad.exe".to_string()),
                _ => None,
            }
        });
        assert_eq!(panels, vec![frame(0), frame(200)]);
        // Each program is named once.
        assert_eq!(asked, vec![9, 4, 5]);
    }

    #[test]
    fn an_input_panel_in_a_frame_of_explorers_is_one_too() {
        // The emoji panel on build 26300 (12/10/2026): a frame of explorer.exe's (program 3)
        // round the text input host's core window (program 9). A store app's frame (Calculator,
        // program 7) shows another program.
        let frame = |left: i32| crate::platform::Rect {
            left,
            top: 313,
            right: left + 360,
            bottom: 713,
        };
        let framed = |pid: u32, hosted: u32, left: i32| crate::platform::window::ShownWindow {
            hwnd: 0,
            pid,
            frame: frame(left),
            see_through: false,
            click_through: false,
            notification: false,
            hosted_pid: Some(hosted),
        };
        let windows = [framed(3, 9, 228), framed(5, 7, 700)];
        let panels = text_input_panels_among(&windows, |pid| match pid {
            3 => Some("explorer.exe".to_string()),
            5 => Some("ApplicationFrameHost.exe".to_string()),
            7 => Some("CalculatorApp.exe".to_string()),
            9 => Some("TextInputHost.exe".to_string()),
            _ => None,
        });
        assert_eq!(panels, vec![frame(228)]);
    }

    #[test]
    fn only_the_added_text_is_taken() {
        // At the end, at the start, in the middle, into an empty box.
        let cases = [
            (
                "Dear Sam,\n",
                "Dear Sam,\nSee you on Monday.",
                "See you on Monday.",
            ),
            ("Kind regards", "Hello. Kind regards", "Hello."),
            (
                "Dear Sam, regards",
                "Dear Sam, see you soon, regards",
                "see you soon,",
            ),
            ("", "Hello world", "Hello world"),
        ];
        for (before, after, added) in cases {
            assert_eq!(dictated(before, after).as_deref(), Some(added), "{after:?}");
        }
    }

    #[test]
    fn dictation_over_selected_text_is_what_replaced_it() {
        // "Monday" selected, then "Tuesday" spoken.
        assert_eq!(
            dictated("See you on Monday.", "See you on Tuesday.").as_deref(),
            Some("Tuesday")
        );
    }

    #[test]
    fn nothing_added_is_no_dictation() {
        for (before, after) in [
            ("Dear Sam", "Dear Sam"),
            ("Dear Sam, see you", "Dear Sam"),
            ("Dear Sam", "Dear Sam \n\n"),
            ("", ""),
        ] {
            assert_eq!(dictated(before, after), None, "{before:?} → {after:?}");
        }
    }

    #[test]
    fn text_put_in_at_two_places_is_no_dictation() {
        // " there" at the end and "Oh, " at the start: the change runs from one to the other, and
        // the text between, already there, would come back as if it were dictated.
        assert_eq!(dictated("Hello world", "Oh, Hello world there"), None);
    }

    #[test]
    fn line_endings_dont_count_as_added() {
        // Word reads paragraphs with a carriage return, Notepad with both.
        assert_eq!(
            dictated("Dear Sam,\r\n", "Dear Sam,\nSee you.").as_deref(),
            Some("See you.")
        );
        assert_eq!(
            dictated("Dear Sam,\r", "Dear Sam,\r\nSee you.\r").as_deref(),
            Some("See you.")
        );
    }

    #[test]
    fn words_line_breaks_are_new_lines_and_its_other_marks_are_left_out() {
        // Word reads a line break (Shift+Enter) as a vertical tab, and a table cell's end as a bell.
        assert_eq!(
            dictated("Agenda\r", "Agenda\rItem one\u{b}item two\u{7}").as_deref(),
            Some("Item one\nitem two")
        );
    }

    #[test]
    fn characters_beyond_the_basic_plane_are_never_split() {
        // Emoji are surrogate pairs in UI Automation's UTF-16: 😀 and 😃 share their first half,
        // which must never be taken as the same, leaving half a character added.
        assert_eq!(dictated("Smile 😀", "Smile 😃").as_deref(), Some("😃"));
        assert_eq!(
            dictated("Done 👍", "Done 👍 and 𝄞 sent").as_deref(),
            Some("and 𝄞 sent")
        );
        assert_eq!(
            dictated("𝄞", "𝄞𝄞").as_deref(),
            Some("𝄞"),
            "the same character twice"
        );
    }
}
