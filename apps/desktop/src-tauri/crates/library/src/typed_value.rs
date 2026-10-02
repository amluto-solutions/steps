//! A hidden typed value taken out of wording: the same rule as `withoutTypedValue` in
//! `packages/core/src/typed-value.ts`, for the places Rust handles wording itself (search, and
//! the `.amlsteps` export). The value is found in full or shortened the way generated wording
//! shortens it (its first 80 characters, then "..."), in any case, standing on its own rather
//! than inside a longer word, and replaced by "…".

/// What a hidden typed value becomes in wording.
pub(crate) const HIDDEN_VALUE: &str = "…";
/// Generated wording shortens a value longer than this, as `shorten` in packages/core does.
const WORDING_VALUE_CHARS: usize = 80;

/// Quotation marks a value can sit between in wording, in any of Steps' languages.
const QUOTES: &[char] = &['"', '“', '”', '„', '«', '»', '「', '」', '『', '』', '\''];
/// A value this long is also found by its first `PREFIX_CHARS`, in case the rest was edited.
const PREFIX_FROM: usize = 24;
const PREFIX_CHARS: usize = 20;

/// Where `form` ends if it starts at `at` in `chars`: letters in any case, and any run of spaces
/// or line breaks in the form matching any run in the text.
fn match_form(chars: &[char], at: usize, form: &[char]) -> Option<usize> {
    let (mut here, mut there) = (at, 0);
    while there < form.len() {
        if form[there].is_whitespace() {
            if !chars.get(here).is_some_and(|c| c.is_whitespace()) {
                return None;
            }
            while chars.get(here).is_some_and(|c| c.is_whitespace()) {
                here += 1;
            }
            while form.get(there).is_some_and(|c| c.is_whitespace()) {
                there += 1;
            }
        } else if chars
            .get(here)
            .is_some_and(|c| same_letter(*c, form[there]))
        {
            here += 1;
            there += 1;
        } else {
            return None;
        }
    }
    Some(here)
}

/// `text` with every stand-alone copy of `value` (in full or shortened, its spaces as they come)
/// replaced by "…"; a long value is also found by its start, up to the quotation mark or line
/// end after it (F028), as `withoutTypedValue` in packages/core does.
pub(crate) fn without_typed_value(text: &str, value: &str) -> String {
    let needle = value.trim();
    if needle.is_empty() {
        return text.to_string();
    }
    let full: Vec<char> = needle.chars().collect();
    let mut forms = Vec::new();
    if full.len() > WORDING_VALUE_CHARS {
        let shortened: String = full[..WORDING_VALUE_CHARS].iter().collect();
        forms.push(
            format!("{}...", shortened.trim_end())
                .chars()
                .collect::<Vec<_>>(),
        );
    }
    let prefix: Option<Vec<char>> =
        (full.len() >= PREFIX_FROM).then(|| full[..PREFIX_CHARS].to_vec());
    forms.push(full);

    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < chars.len() {
        let starts_word = at == 0 || !chars[at - 1].is_alphanumeric();
        let found = starts_word
            .then(|| {
                forms
                    .iter()
                    .find_map(|form| {
                        match_form(&chars, at, form).filter(|end| {
                            chars.get(*end).is_none_or(|next| !next.is_alphanumeric())
                        })
                    })
                    .or_else(|| {
                        prefix.as_ref().and_then(|start| {
                            let mut end = match_form(&chars, at, start)?;
                            while chars
                                .get(end)
                                .is_some_and(|c| !QUOTES.contains(c) && *c != '\n' && *c != '\r')
                            {
                                end += 1;
                            }
                            Some(end)
                        })
                    })
            })
            .flatten();
        if let Some(end) = found {
            out.push_str(HIDDEN_VALUE);
            at = end;
        } else {
            out.push(chars[at]);
            at += 1;
        }
    }
    out
}

fn same_letter(a: char, b: char) -> bool {
    a == b || a.to_lowercase().eq(b.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_value_out_in_any_case() {
        assert_eq!(
            without_typed_value("Type ACME in Name, then check Acme", "acme"),
            "Type … in Name, then check …"
        );
        assert_eq!(without_typed_value("Nothing here", "acme"), "Nothing here");
        assert_eq!(without_typed_value("Keep", "  "), "Keep");
    }

    #[test]
    fn takes_out_the_shortened_form_of_a_long_value() {
        let address =
            "Flat 4, 221 Baker Street, London, NW1 6XE - customer ref ACME-778812 for Mrs J Smith";
        let shortened: String = address.chars().take(80).collect();
        let wording = format!("Type \"{}...\" in \"Address\" field", shortened.trim_end());
        assert_eq!(
            without_typed_value(&wording, address),
            "Type \"…\" in \"Address\" field"
        );
    }

    #[test]
    fn finds_a_value_across_line_breaks_and_by_its_start_when_the_rest_was_edited() {
        let value = r"Hello from Quinn. Test invoice INV-.txtC:\Users\RobinHale\testdata";
        assert_eq!(
            without_typed_value(
                "Type \"Hello from Quinn.\nTest invoice INV-.txtC:\\Users\\RobinHale\\testdata\"",
                value
            ),
            "Type \"…\""
        );
        assert_eq!(
            without_typed_value(
                r#"Type "Hello from Quinn. Test invoice INV-.txtC:\Users\USERNAME\testdata..." in "File name:""#,
                value
            ),
            r#"Type "…" in "File name:""#
        );
        assert_eq!(
            without_typed_value("Acme Ltd and Acme Limited", "Acme Ltd"),
            "… and Acme Limited"
        );
    }

    #[test]
    fn leaves_the_value_inside_longer_words_alone() {
        assert_eq!(
            without_typed_value("Type \"e\" in \"Customer name\"", "e"),
            "Type \"…\" in \"Customer name\""
        );
        assert_eq!(
            without_typed_value("Order 1234 and 12345", "1234"),
            "Order … and 12345"
        );
    }
}
