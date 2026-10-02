//! Fields whose values are never read (docs/spec/08-privacy-and-security.md#input-rules).
//!
//! `IsPassword` isn't enough on its own: apps put secrets in ordinary edit boxes. A field is also
//! sensitive when its name, label, help text or automation id contains one of these words.

/// Whole words or phrases, matched case-insensitively after splitting camelCase and punctuation.
const SENSITIVE_TERMS: &[&str] = &[
    "password",
    "passcode",
    "passwd",
    "pwd",
    "pw",
    "pin",
    "secret",
    "token",
    "otp",
    "one time",
    "cvv",
    "cvc",
    "security code",
    "memorable",
    "sort code",
    "account number",
    "card number",
    "card no",
    "passphrase",
    "security key",
    "access key",
    "private key",
    "api key",
    "apikey",
    "verification code",
    "auth code",
    "recovery code",
    "backup code",
    // "Password" in Steps' other languages, as apps in them label their fields (01/10/2026).
    "passwort",
    "kennwort",
    "mot de passe",
    "contraseña",
    "contrasena",
    "contrasenya",
    "senha",
    "palavra passe",
    "wachtwoord",
    "hasło",
    "haslo",
    "heslo",
    "jelszó",
    "jelszo",
    "salasana",
    "lösenord",
    "losenord",
    "adgangskode",
    "passord",
    "parola",
    "пароль",
    "парола",
    "лозинка",
    "şifre",
    "sifre",
    "mật khẩu",
    "mat khau",
    "κωδικός",
    "κωδικος",
    "kata sandi",
    "geslo",
    "lozinka",
    "slaptažodis",
    "slaptazodis",
    "salasõna",
    "pasfhocal",
];

/// Words in scripts written without spaces: matched anywhere in the text, not as whole words.
const SENSITIVE_SUBSTRINGS: &[&str] = &["密码", "密碼", "パスワード", "暗証", "비밀번호", "암호"];

/// Lower-cases, splits camelCase (`cardPin` → `card pin`) and an acronym from the word after it
/// (`OTPCode` → `otp code`, `APIToken` → `api token`), and turns punctuation into spaces, so
/// matching works on whole words ("pin" matches `PIN` and `user_pin`, but not "spinner"). A
/// plural acronym stays whole (`PINs` → `pins`).
fn normalise(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 8);
    for (index, &ch) in chars.iter().enumerate() {
        if ch.is_alphanumeric() {
            let previous = index.checked_sub(1).and_then(|at| chars.get(at)).copied();
            let next = chars.get(index + 1).copied();
            let camel = ch.is_uppercase() && previous.is_some_and(char::is_lowercase);
            let plural = next == Some('s')
                && chars
                    .get(index + 2)
                    .is_none_or(|after| !after.is_alphanumeric());
            let acronym_ends = ch.is_uppercase()
                && previous.is_some_and(char::is_uppercase)
                && next.is_some_and(char::is_lowercase)
                && !plural;
            if camel || acronym_ends {
                out.push(' ');
            }
            out.extend(ch.to_lowercase());
        } else {
            out.push(' ');
        }
    }
    format!(" {} ", out.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// Whether any of `texts` names a sensitive field. `extra_terms` come from IT policy.
#[must_use]
pub fn looks_sensitive(texts: &[&str], extra_terms: &[String]) -> bool {
    let haystacks: Vec<String> = texts
        .iter()
        .filter(|text| !text.is_empty())
        .map(|text| normalise(text))
        .collect();
    let matches = |term: &str| {
        let needle = normalise(term);
        haystacks.iter().any(|haystack| haystack.contains(&needle))
    };
    SENSITIVE_TERMS.iter().any(|term| matches(term))
        || extra_terms.iter().any(|term| matches(term))
        || texts
            .iter()
            .any(|text| SENSITIVE_SUBSTRINGS.iter().any(|word| text.contains(word)))
}

// ---------- masking typed values ----------

/** The most words one card, phone, NI or IBAN value is spread over ("GB82 WEST 1234 …" is 6). */
const MAX_WORDS: usize = 9;

/// Luhn check for card numbers.
fn luhn(digits: &[u32]) -> bool {
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(index, &digit)| {
            if index % 2 == 1 {
                let doubled = digit * 2;
                if doubled > 9 { doubled - 9 } else { doubled }
            } else {
                digit
            }
        })
        .sum();
    sum.is_multiple_of(10)
}

fn is_card(compact: &str) -> bool {
    let digits: Option<Vec<u32>> = compact.chars().map(|ch| ch.to_digit(10)).collect();
    digits.is_some_and(|digits| (13..=19).contains(&digits.len()) && luhn(&digits))
}

/// UK numbers: 0 and 9–10 more digits, or +44 / 0044 and 9–10 digits.
fn is_uk_phone(compact: &str) -> bool {
    let rest = compact
        .strip_prefix("+44")
        .or_else(|| compact.strip_prefix("0044"))
        .map(|rest| rest.strip_prefix("0").unwrap_or(rest))
        .or_else(|| compact.strip_prefix("0"));
    rest.is_some_and(|rest| {
        (9..=10).contains(&rest.len()) && rest.chars().all(|ch| ch.is_ascii_digit())
    })
}

/// National Insurance: two letters, six digits, A–D.
fn is_ni(compact: &str) -> bool {
    let chars: Vec<char> = compact.chars().collect();
    chars.len() == 9
        && chars[..2].iter().all(char::is_ascii_alphabetic)
        && chars[2..8].iter().all(char::is_ascii_digit)
        && matches!(chars[8].to_ascii_uppercase(), 'A'..='D')
}

/// IBAN: country, check digits, up to 30 more letters or digits, and the mod-97 check.
fn is_iban(compact: &str) -> bool {
    let upper = compact.to_ascii_uppercase();
    let bytes = upper.as_bytes();
    if !(15..=34).contains(&bytes.len())
        || !bytes[..2].iter().all(u8::is_ascii_alphabetic)
        || !bytes[2..4].iter().all(u8::is_ascii_digit)
        || !bytes.iter().all(u8::is_ascii_alphanumeric)
    {
        return false;
    }
    let rearranged = upper[4..].chars().chain(upper[..4].chars());
    let mut remainder: u32 = 0;
    for ch in rearranged {
        let value = ch.to_digit(36).unwrap_or(0);
        remainder = if value >= 10 {
            (remainder * 100 + value) % 97
        } else {
            (remainder * 10 + value) % 97
        };
    }
    remainder == 1
}

fn is_email(word: &str) -> bool {
    let word = word.trim_matches(|ch: char| !ch.is_alphanumeric());
    word.split_once('@').is_some_and(|(local, domain)| {
        !local.is_empty()
            && domain.contains('.')
            && !domain.starts_with('.')
            && !domain.ends_with('.')
    })
}

fn masked(compact: &str) -> String {
    let tail: String = compact
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("••••{tail}")
}

/// Masks card numbers, National Insurance numbers, IBANs, email addresses and UK phone numbers in
/// a typed value, keeping the last four characters (`••••1234`), before the value leaves the
/// capture worker. The unmasked value is never saved (docs/spec/04-editor.md). It is a safety net,
/// not a guarantee: anything it doesn't recognise is kept as typed.
#[must_use]
pub fn mask_value(value: &str) -> String {
    mask_matching(value, true, |compact| {
        is_card(compact) || is_uk_phone(compact) || is_ni(compact) || is_iban(compact)
    })
}

/// Masks card numbers and IBANs only, for commands, their output and code
/// (docs/spec/08-privacy-and-security.md#keys). Email addresses, phone numbers and the like stay:
/// in a command they are usually the point ("give anna@… access to sales@…").
#[must_use]
pub fn mask_card_numbers(value: &str) -> String {
    mask_matching(value, false, |compact| is_card(compact) || is_iban(compact))
}

fn mask_matching(value: &str, emails: bool, sensitive: impl Fn(&str) -> bool) -> String {
    // Words with their byte ranges, so the text between them is kept as it was. Punctuation
    // that ends a sentence or a list item isn't part of a word ("4111…1111, thanks").
    let mut words: Vec<(usize, usize)> = Vec::new();
    let mut start: Option<usize> = None;
    let mut push = |from: usize, to: usize| {
        let word = value[from..to].trim_end_matches([',', ';', ':', '!', '?', '.', '"', '\'']);
        if !word.is_empty() {
            words.push((from, from + word.len()));
        }
    };
    for (index, ch) in value.char_indices() {
        if ch.is_whitespace() {
            if let Some(from) = start.take() {
                push(from, index);
            }
        } else if start.is_none() {
            start = Some(index);
        }
    }
    if let Some(from) = start {
        push(from, value.len());
    }

    let mut out = String::with_capacity(value.len());
    let mut copied = 0;
    let mut index = 0;
    while index < words.len() {
        let (from, to) = words[index];
        if emails && is_email(&value[from..to]) {
            out.push_str(&value[copied..from]);
            out.push_str(&masked(
                value[from..to].trim_end_matches(|ch: char| !ch.is_alphanumeric()),
            ));
            copied = to;
            index += 1;
            continue;
        }
        // The longest run of words starting here that reads as one sensitive number.
        let mut best: Option<(usize, String)> = None;
        let mut compact = String::new();
        for (offset, &(word_from, word_to)) in words[index..].iter().take(MAX_WORDS).enumerate() {
            let word = &value[word_from..word_to];
            if !word
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || "+-().".contains(ch))
            {
                break;
            }
            compact.extend(
                word.chars()
                    .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '+'),
            );
            if sensitive(&compact) {
                best = Some((index + offset, compact.clone()));
            }
        }
        if let Some((last, compact)) = best {
            out.push_str(&value[copied..from]);
            out.push_str(&masked(&compact));
            copied = words[last].1;
            index = last + 1;
        } else {
            index += 1;
        }
    }
    out.push_str(&value[copied..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cases the Chrome edition's TypeScript copy is checked against too
    /// (packages/core/src/sensitive.ts), so the two can't drift apart.
    #[test]
    fn agrees_with_the_shared_test_vectors() {
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../../packages/core/test-vectors/sensitive.json"
        ))
        .unwrap();
        let strings = |key: &str| -> Vec<String> {
            vectors[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap().to_string())
                .collect()
        };
        let pairs = |key: &str| -> Vec<(String, String)> {
            vectors[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|pair| {
                    (
                        pair[0].as_str().unwrap().to_string(),
                        pair[1].as_str().unwrap().to_string(),
                    )
                })
                .collect()
        };
        for field in strings("sensitiveFields") {
            assert!(
                looks_sensitive(&[&field], &[]),
                "{field} should be sensitive"
            );
        }
        for field in strings("ordinaryFields") {
            assert!(
                !looks_sensitive(&[&field], &[]),
                "{field} should not be sensitive"
            );
        }
        let policy = &vectors["policyTerm"];
        let field = policy["field"].as_str().unwrap();
        let term = policy["term"].as_str().unwrap().to_string();
        assert!(!looks_sensitive(&[field], &[]));
        assert!(looks_sensitive(&[field], &[term]));
        for (value, expected) in pairs("masked") {
            assert_eq!(mask_value(&value), expected);
        }
        for value in strings("unmasked") {
            assert_eq!(mask_value(&value), value);
        }
        for (value, expected) in pairs("cardNumbersOnly") {
            assert_eq!(mask_card_numbers(&value), expected);
        }
    }

    #[test]
    fn masks_sensitive_values_keeping_the_last_four() {
        assert_eq!(mask_value("4111 1111 1111 1111"), "••••1111");
        assert_eq!(
            mask_value("card 4111-1111-1111-1111 please"),
            "card ••••1111 please"
        );
        assert_eq!(mask_value("AB 12 34 56 C"), "••••456C");
        assert_eq!(mask_value("GB82 WEST 1234 5698 7654 32"), "••••5432");
        assert_eq!(mask_value("robin@example.com"), "••••.com");
        assert_eq!(mask_value("Call 07700 900123 today"), "Call ••••0123 today");
        assert_eq!(mask_value("+44 20 7946 0958"), "••••0958");
        // Punctuation after a value is kept, and doesn't hide it.
        assert_eq!(mask_value("4111111111111111, thanks"), "••••1111, thanks");
        assert_eq!(mask_value("Ring (020) 7946 0958."), "Ring ••••0958.");
        assert_eq!(mask_value("NI: AB123456C;"), "NI: ••••456C;");
    }

    #[test]
    fn commands_keep_their_addresses_but_not_card_numbers() {
        let command =
            "Set-Card -Owner anna@contoso.co.uk -Number 4111111111111111 -Phone 07700900123";
        assert_eq!(
            mask_card_numbers(command),
            "Set-Card -Owner anna@contoso.co.uk -Number ••••1111 -Phone 07700900123"
        );
        assert_eq!(
            mask_card_numbers("IBAN GB82 WEST 1234 5698 7654 32"),
            "IBAN ••••5432"
        );
    }

    #[test]
    fn leaves_ordinary_values_alone() {
        for value in [
            "Acme Supplies Ltd",
            "4111 1111 1111 1112",
            "Invoice 12345",
            "GB82 WEST 1234 5698 7654 33",
            "@handle",
            "2026-09-26",
            "",
        ] {
            assert_eq!(mask_value(value), value);
        }
    }

    fn sensitive(text: &str) -> bool {
        looks_sensitive(&[text], &[])
    }

    #[test]
    fn catches_common_secret_fields() {
        for text in [
            "Password",
            "Confirm password",
            "PIN",
            "cardPin",
            "user_pin",
            "One-time code",
            "otpCode",
            "CVV",
            "Security code",
            "Memorable word",
            "Sort code",
            "Account number",
            "Card number",
            "cardNo",
            "Network security key",
            "Passphrase",
            "Verification code",
            "Recovery code",
            "backupCode",
            "AWS access key",
            "API_KEY",
            "apikey",
            "API token",
            "client-secret",
            "OTPCode",
            "PINField",
            "APIToken",
            "txtCVV",
            "pw",
            "$pw",
        ] {
            assert!(sensitive(text), "{text} should be sensitive");
        }
    }

    #[test]
    fn leaves_ordinary_fields_alone() {
        for text in [
            "Email",
            "Spinner",
            "Shipping address",
            "Opinion",
            "Pinned items",
            "Tokenise",
            "Search",
            "PINsAndNeedles",
            "SPINNER",
            "HTMLPage",
            "",
        ] {
            assert!(!sensitive(text), "{text} should not be sensitive");
        }
    }

    #[test]
    fn policy_terms_extend_the_list() {
        assert!(!sensitive("Project Falcon code"));
        assert!(looks_sensitive(
            &["Project Falcon code"],
            &["falcon".to_string()]
        ));
    }

    #[test]
    fn any_of_the_texts_can_match() {
        assert!(looks_sensitive(&["Code", "", "txtPassword"], &[]));
    }
}
