//! Secrets in commands and code (docs/spec/08-privacy-and-security.md#keys).
//!
//! A value that follows a parameter or variable with a sensitive name (`-Password x`,
//! `--token=x`, `$env:API_KEY = "x"`, `export TOKEN=x`, `Password=x;` in a connection string,
//! `?token=x` in an address), and a few places a secret is passed with no name
//! (`ConvertTo-SecureString "x"`, `Bearer x`, `https://user:x@host`), is replaced with `••••`
//! before the command is stored. The values found are returned so the same text can be covered in
//! the step's screenshot, where on-PC text recognition finds it (`blur_secrets`). Card numbers and
//! IBANs are masked too. Like the typed-value masking, it is a safety net, not a guarantee.

use image::{Rgba, RgbaImage};

use crate::screenshot::Shot;
use crate::sensitive::{looks_sensitive, mask_card_numbers};

pub const MASK: &str = "••••";

/// A command with its secrets masked, and the secrets that were taken out.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Masked {
    pub text: String,
    /// The original values, for blurring the screenshot. Never stored.
    pub secrets: Vec<String>,
}

/// Whitespace-separated words as byte ranges. Quotes keep spaces inside a word.
fn words(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    let mut quote: Option<char> = None;
    for (index, ch) in text.char_indices() {
        match quote {
            Some(open) if ch == open => quote = None,
            Some(_) => {}
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
                start.get_or_insert(index);
            }
            None if ch.is_whitespace() => {
                if let Some(from) = start.take() {
                    out.push((from, index));
                }
            }
            None => {
                start.get_or_insert(index);
            }
        }
    }
    if let Some(from) = start {
        out.push((from, text.len()));
    }
    out
}

/// The part of a value to hide: without the quotes and brackets around it, or a separator that
/// belongs to the command.
fn secret_range(text: &str, from: usize, to: usize) -> Option<(usize, usize)> {
    let value = &text[from..to];
    let start = value.len() - value.trim_start_matches(['"', '\'', '(']).len();
    let end = value.trim_end_matches(['"', '\'', ')', ';', ',']).len();
    (end > start).then_some((from + start, from + end))
}

/// Whether a parameter or variable name names a secret. `extra` is IT policy's list.
fn sensitive_name(name: &str, extra: &[String]) -> bool {
    let name = name
        .trim_matches(['"', '\''])
        .trim_start_matches(['-', '/', '$']);
    let name = name
        .get(..4)
        .filter(|prefix| prefix.eq_ignore_ascii_case("env:"))
        .map_or(name, |_| &name[4..]);
    !name.is_empty() && looks_sensitive(&[name], extra)
}

fn is_parameter(word: &str) -> bool {
    let letter_at = |index: usize| {
        word.as_bytes()
            .get(index)
            .is_some_and(u8::is_ascii_alphabetic)
    };
    (word.starts_with("--") && letter_at(2))
        || ((word.starts_with('-') || word.starts_with('/')) && letter_at(1))
}

/// `name=value` pieces of one word: a connection string's `;`, an address's `?` and `&`.
fn pieces(word: &str) -> impl Iterator<Item = (usize, &str)> {
    let mut start = 0;
    let mut out = Vec::new();
    for (index, ch) in word.char_indices() {
        if matches!(ch, ';' | '&' | '?') {
            out.push((start, &word[start..index]));
            start = index + 1;
        }
    }
    out.push((start, &word[start..]));
    out.into_iter()
}

/// Where a secret passed with no name starts in a word: after `Bearer ` or `Basic ` (an
/// Authorization header, often inside a quoted word).
fn after_auth_scheme(word: &str) -> Option<usize> {
    let lower = word.to_ascii_lowercase();
    ["bearer ", "basic "]
        .iter()
        .find_map(|scheme| lower.find(scheme).map(|at| at + scheme.len()))
}

/// Masks the secrets in one command line, or a script's worth of lines.
#[must_use]
pub fn mask_command(text: &str, extra_terms: &[String]) -> Masked {
    let mut hide: Vec<(usize, usize)> = Vec::new();
    let mut line_start = 0;
    for line in text.split('\n') {
        find_in_line(line, extra_terms, &mut |from, to| {
            hide.push((line_start + from, line_start + to));
        });
        line_start += line.len() + 1;
    }

    hide.sort_unstable();
    let mut out = String::with_capacity(text.len());
    let mut secrets: Vec<String> = Vec::new();
    let mut copied = 0;
    for (from, to) in hide {
        if from < copied {
            continue;
        }
        out.push_str(&text[copied..from]);
        out.push_str(MASK);
        let secret = &text[from..to];
        if !secrets.iter().any(|known| known == secret) {
            secrets.push(secret.to_string());
        }
        copied = to;
    }
    out.push_str(&text[copied..]);
    Masked {
        text: mask_card_numbers(&out),
        secrets,
    }
}

fn find_in_line(line: &str, extra: &[String], hide: &mut dyn FnMut(usize, usize)) {
    let list = words(line);
    let value_of = |index: usize, hide: &mut dyn FnMut(usize, usize)| {
        if let Some(&(from, to)) = list.get(index)
            && !is_parameter(&line[from..to])
            && let Some((from, to)) = secret_range(line, from, to)
        {
            hide(from, to);
        }
    };
    for (index, &(word_from, word_to)) in list.iter().enumerate() {
        let word = &line[word_from..word_to];

        // `-Password:x`, `--token=x`, `NAME=x`, `$env:NAME="x"`, `…;Password=x;…`, `?token=x`.
        let mut found = false;
        for (offset, piece) in pieces(word) {
            let at = if is_parameter(piece) {
                piece.find(['=', ':'])
            } else {
                piece.find('=')
            };
            if let Some(at) = at
                && sensitive_name(&piece[..at], extra)
            {
                let from = word_from + offset + at + 1;
                if let Some((from, to)) = secret_range(line, from, word_from + offset + piece.len())
                {
                    hide(from, to);
                    found = true;
                }
            }
        }
        if found {
            continue;
        }

        // `-Password x`, `--token x`.
        if is_parameter(word) && sensitive_name(word, extra) {
            value_of(index + 1, hide);
            continue;
        }
        // `$env:NAME = "x"`, `$password = "x"`, `set NAME = x`.
        let assigned = list
            .get(index + 1)
            .is_some_and(|&(from, to)| &line[from..to] == "=");
        let variable = word.starts_with('$')
            || (index > 0 && line[..word_from].trim_end().eq_ignore_ascii_case("set"));
        if assigned && variable && sensitive_name(word, extra) {
            value_of(index + 2, hide);
            continue;
        }
        // Secrets passed with no name.
        if word.eq_ignore_ascii_case("ConvertTo-SecureString") {
            value_of(index + 1, hide);
            continue;
        }
        if word.eq_ignore_ascii_case("bearer") || word.eq_ignore_ascii_case("basic") {
            value_of(index + 1, hide);
            continue;
        }
        if let Some(start) = after_auth_scheme(word) {
            let rest = &word[start..];
            let end = rest.find(['"', '\'', ' ']).unwrap_or(rest.len());
            if end > 0 {
                hide(word_from + start, word_from + start + end);
            }
            continue;
        }
        if let Some((from, to)) = url_password(word) {
            hide(word_from + from, word_from + to);
        }
    }
}

/// Masks output (or any text shown with a command): card numbers and IBANs, and any secret already
/// taken out of the command it belongs to.
#[must_use]
pub fn mask_output(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    for secret in secrets.iter().filter(|secret| secret.chars().count() >= 3) {
        out = out.replace(secret.as_str(), MASK);
    }
    mask_card_numbers(&out)
}

/// The password in `scheme://user:password@host`, as a byte range of the word.
fn url_password(word: &str) -> Option<(usize, usize)> {
    let scheme_end = word.find("://")? + 3;
    let rest = &word[scheme_end..];
    let at = rest.find('@')?;
    let credentials = &rest[..at];
    if credentials.contains('/') {
        return None;
    }
    let colon = credentials.find(':')?;
    let from = scheme_end + colon + 1;
    let to = scheme_end + at;
    (to > from).then_some((from, to))
}

/// Hides each secret in the screenshot where on-PC text recognition finds it. Returns `false` if
/// any secret couldn't be found (the step is then flagged "check this screenshot"). The text read
/// is used only here and forgotten.
pub(crate) fn blur_secrets(shot: &mut Shot, secrets: &[String]) -> bool {
    let secrets: Vec<String> = secrets
        .iter()
        .map(|secret| secret.split_whitespace().collect::<String>())
        .filter(|secret| !secret.is_empty())
        .collect();
    if secrets.is_empty() {
        return true;
    }
    let (width, height) = (shot.image.width(), shot.image.height());
    let mut bgra = shot.image.as_raw().clone();
    for pixel in bgra.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    let Ok(lines) = crate::platform::ocr::recognize(&bgra, width, height) else {
        return false;
    };
    let mut all_found = true;
    for secret in &secrets {
        let mut found = false;
        for line in &lines {
            // The line's words run together, so a secret OCR splits into two words still matches.
            let mut joined = String::new();
            let mut spans = Vec::with_capacity(line.len());
            for word in line {
                let start = joined.len();
                joined.push_str(&word.text);
                spans.push((start, joined.len()));
            }
            let mut from = 0;
            while let Some(at) = joined[from..].find(secret.as_str()) {
                let start = from + at;
                let end = start + secret.len();
                for (word, (word_start, word_end)) in line.iter().zip(&spans) {
                    if *word_end > start && *word_start < end {
                        cover(&mut shot.image, word.x, word.y, word.width, word.height);
                    }
                }
                found = true;
                from = end;
            }
        }
        all_found &= found;
    }
    all_found
}

/// Covers a box (with a small margin) in its average colour: nothing of the text is left.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "OCR boxes are small, non-negative pixel positions inside the image"
)]
fn cover(image: &mut RgbaImage, x: f32, y: f32, width: f32, height: f32) {
    const MARGIN: f32 = 3.0;
    let left = (x - MARGIN).max(0.0) as u32;
    let top = (y - MARGIN).max(0.0) as u32;
    let right = ((x + width + MARGIN) as u32).min(image.width());
    let bottom = ((y + height + MARGIN) as u32).min(image.height());
    if right <= left || bottom <= top {
        return;
    }
    let mut sum = [0u64; 3];
    let mut count = 0u64;
    for py in top..bottom {
        for px in left..right {
            let pixel = image.get_pixel(px, py);
            for (total, channel) in sum.iter_mut().zip(pixel.0) {
                *total += u64::from(channel);
            }
            count += 1;
        }
    }
    let average = |total: u64| u8::try_from(total / count.max(1)).unwrap_or(0);
    let fill = Rgba([average(sum[0]), average(sum[1]), average(sum[2]), 255]);
    for py in top..bottom {
        for px in left..right {
            image.put_pixel(px, py, fill);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masked(text: &str) -> String {
        mask_command(text, &[]).text
    }

    #[test]
    fn values_after_sensitive_parameters_are_masked() {
        assert_eq!(
            masked("New-LocalUser -Name sam -Password $pw"),
            "New-LocalUser -Name sam -Password ••••"
        );
        assert_eq!(
            masked(r#"Connect-Thing -ClientSecret "abc 123" -TenantId x"#),
            r#"Connect-Thing -ClientSecret "••••" -TenantId x"#
        );
        assert_eq!(
            masked("curl --token=abc123 https://x.test"),
            "curl --token=•••• https://x.test"
        );
        assert_eq!(masked("tool --api-key abc123"), "tool --api-key ••••");
        assert_eq!(masked("run -Password:hunter2"), "run -Password:••••");
    }

    #[test]
    fn a_switch_after_the_name_is_not_taken_for_its_value() {
        assert_eq!(
            masked("Get-Secret -Token -AsPlainText"),
            "Get-Secret -Token -AsPlainText"
        );
    }

    #[test]
    fn variables_holding_secrets_are_masked() {
        assert_eq!(
            masked(r#"$env:API_KEY = "sk-live-1""#),
            r#"$env:API_KEY = "••••""#
        );
        assert_eq!(
            masked(r#"$env:API_KEY="sk-live-1""#),
            r#"$env:API_KEY="••••""#
        );
        assert_eq!(masked("$password = 'x y'"), "$password = '••••'");
        // Found live: a short name for a password.
        assert_eq!(masked(r#"$pw = "hunter22""#), r#"$pw = "••••""#);
        assert_eq!(
            masked("export GITHUB_TOKEN=ghp_123"),
            "export GITHUB_TOKEN=••••"
        );
        assert_eq!(masked("set DB_PASSWORD=abc"), "set DB_PASSWORD=••••");
        assert_eq!(masked("set DB_PASSWORD = abc"), "set DB_PASSWORD = ••••");
        assert_eq!(
            masked("CLIENT_SECRET=abc ./deploy.sh"),
            "CLIENT_SECRET=•••• ./deploy.sh"
        );
    }

    #[test]
    fn secrets_inside_connection_strings_and_addresses_are_masked() {
        assert_eq!(
            masked(r#"sqlcmd -C "Server=db;User Id=sa;Password=Hunter2;""#),
            r#"sqlcmd -C "Server=db;User Id=sa;Password=••••;""#
        );
        assert_eq!(
            masked("curl https://x.test/cb?code=1&access_token=abc&x=1"),
            "curl https://x.test/cb?code=1&access_token=••••&x=1"
        );
    }

    #[test]
    fn secrets_passed_without_a_name_are_masked() {
        assert_eq!(
            masked(r#"$s = ConvertTo-SecureString "P@ss w0rd" -AsPlainText -Force"#),
            r#"$s = ConvertTo-SecureString "••••" -AsPlainText -Force"#
        );
        assert_eq!(
            masked(r#"curl -H "Authorization: Bearer eyJhbGci" https://api.test"#),
            r#"curl -H "Authorization: Bearer ••••" https://api.test"#
        );
        assert_eq!(
            masked("http --auth-type Bearer eyJhbGci"),
            "http --auth-type Bearer ••••"
        );
        assert_eq!(
            masked("git clone https://sam:ghp_abc@github.test/x.git"),
            "git clone https://sam:••••@github.test/x.git"
        );
    }

    #[test]
    fn ordinary_commands_are_left_alone() {
        for command in [
            r#"Add-MailboxPermission -Identity "sales@contoso.co.uk" -User "anna@contoso.co.uk" -AccessRights FullAccess"#,
            r"Get-ChildItem -Path C:\Temp -Recurse",
            "git commit -m 'fix the token parser'",
            "ping -t 10.0.0.1",
            "$items = Get-Process",
            "dir /s",
            "=SUM(B2:B3)",
        ] {
            assert_eq!(masked(command), command);
        }
    }

    #[test]
    fn the_secrets_found_are_returned_for_the_screenshot() {
        let result = mask_command(
            "run -Password hunter2 -Token 'a b'\n$env:API_KEY = \"k1\"",
            &[],
        );
        assert_eq!(result.secrets, ["hunter2", "a b", "k1"]);
        assert_eq!(
            result.text,
            "run -Password •••• -Token '••••'\n$env:API_KEY = \"••••\""
        );
        assert_eq!(
            mask_output(
                "token a b and hunter2, card 4111 1111 1111 1111",
                &result.secrets
            ),
            "token •••• and ••••, card ••••1111"
        );
    }

    #[test]
    fn policy_words_extend_the_names() {
        assert_eq!(
            mask_command("deploy -Falcon abc", &["falcon".to_string()]).text,
            "deploy -Falcon ••••"
        );
    }

    #[test]
    fn card_numbers_in_commands_are_masked() {
        assert_eq!(
            masked("Set-Card -Number 4111111111111111"),
            "Set-Card -Number ••••1111"
        );
    }

    #[test]
    fn a_covered_box_keeps_nothing_of_the_text() {
        let mut image = RgbaImage::from_pixel(40, 20, Rgba([255, 255, 255, 255]));
        image.put_pixel(10, 10, Rgba([0, 0, 0, 255]));
        cover(&mut image, 8.0, 8.0, 4.0, 4.0);
        let covered = image.get_pixel(10, 10);
        assert_eq!(covered, image.get_pixel(6, 6), "one flat colour");
        assert_eq!(
            image.get_pixel(0, 0),
            &Rgba([255, 255, 255, 255]),
            "outside untouched"
        );
    }
}
