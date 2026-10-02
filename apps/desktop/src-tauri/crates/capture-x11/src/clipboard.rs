//! The clipboard's text for a pasted value. X11's clipboard needs a selection owner's answer,
//! which isn't read yet: a paste on Linux makes no typing step.

/// Always `None` on Linux for now.
#[must_use]
pub fn text(_max_chars: usize) -> Option<String> {
    None
}
