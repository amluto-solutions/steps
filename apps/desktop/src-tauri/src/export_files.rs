//! Exported files and the fonts that go into them (docs/spec/05-export.md#fonts, #saving).
//!
//! Fonts come from the PC (docs/spec/05-export.md#fonts): any family installed in the Windows
//! fonts folder, the per-user fonts folder or Office's cloud-font cache (where files have numbered
//! names, so each file's own name table says which face it is). A font whose embedding permission
//! forbids embedding is never used.
#![allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands receive owned values across IPC."
)]
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;

use crate::recorder::CommandError;

/// Big enough for any guide export; a sanity limit, not a quota.
const MAX_EXPORT_BYTES: usize = 1024 * 1024 * 1024;
const EXPORT_EXTENSIONS: [&str; 4] = ["pdf", "docx", "html", "htm"];

/// One font family's faces as base64, when found and embeddable.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FaceSet {
    pub regular: Option<String>,
    pub bold: Option<String>,
    pub italic: Option<String>,
    pub bold_italic: Option<String>,
}

/// What an uploaded font file says about itself, for the brand profile editor.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FontFileInfo {
    pub family: String,
    pub subfamily: String,
    pub embeddable: bool,
}

fn be16(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]))
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes([
        *bytes.get(at)?,
        *bytes.get(at + 1)?,
        *bytes.get(at + 2)?,
        *bytes.get(at + 3)?,
    ]))
}

/// The offset of a table in a TrueType/OpenType file.
fn table(bytes: &[u8], tag: [u8; 4]) -> Option<usize> {
    let count = usize::from(be16(bytes, 4)?);
    (0..count)
        .find_map(|index| {
            let record = 12 + index * 16;
            (bytes.get(record..record + 4)? == tag.as_slice())
                .then(|| be32(bytes, record + 8))
                .flatten()
        })
        .and_then(|offset| usize::try_from(offset).ok())
}

/// A name from the `name` table (1 = family, 2 = subfamily), in its Windows (UTF-16) form.
/// Fonts carry names in many languages (Century Gothic's bold is "Negreta" in Catalan), so the
/// English (United States) record wins, then any Windows record.
pub fn font_name(bytes: &[u8], name_id: u16) -> Option<String> {
    name_in_table(bytes.get(table(bytes, *b"name")?..)?, name_id)
}

/// `font_name` given only the `name` table itself (so a font file needn't be read whole).
fn name_in_table(bytes: &[u8], name_id: u16) -> Option<String> {
    const ENGLISH_US: u16 = 0x0409;
    let base = 0;
    let count = usize::from(be16(bytes, base + 2)?);
    let strings = base + usize::from(be16(bytes, base + 4)?);
    let read = |record: usize| -> Option<String> {
        let length = usize::from(be16(bytes, record + 8)?);
        let offset = usize::from(be16(bytes, record + 10)?);
        let raw = bytes.get(strings + offset..strings + offset + length)?;
        let (pairs, _) = raw.as_chunks::<2>();
        let units: Vec<u16> = pairs.iter().map(|pair| u16::from_be_bytes(*pair)).collect();
        String::from_utf16(&units).ok()
    };
    let records: Vec<(usize, u16)> = (0..count)
        .filter_map(|index| {
            let record = base + 6 + index * 12;
            (be16(bytes, record)? == 3 && be16(bytes, record + 6)? == name_id)
                .then(|| Some((record, be16(bytes, record + 4)?)))
                .flatten()
        })
        .collect();
    records
        .iter()
        .find(|(_, language)| *language == ENGLISH_US)
        .or_else(|| records.first())
        .and_then(|(record, _)| read(*record))
}

/// The OS/2 `fsType` embedding rules allow putting this font in a document: installable,
/// editable, or preview & print. "Restricted" (bit 1 alone) and bitmap-only (bit 9) are refused.
pub fn embeddable(bytes: &[u8]) -> bool {
    let Some(base) = table(bytes, *b"OS/2") else {
        return true;
    };
    let Some(fs_type) = be16(bytes, base + 8) else {
        return false;
    };
    let restricted = fs_type & 0x000F == 0x0002;
    let bitmap_only = fs_type & 0x0200 != 0;
    !restricted && !bitmap_only
}

fn encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// A font on the PC: a TrueType file, or one font in a collection (`.ttc`), as Windows ships most of
/// its Japanese, Chinese and Korean fonts.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FontSource {
    path: PathBuf,
    /// Which font in a collection; `None` for a single font file.
    member: Option<u32>,
}

/// The fonts in a collection: where each one's table directory starts.
fn collection_members(header: &[u8]) -> Option<Vec<u32>> {
    if header.get(..4)? != b"ttcf" {
        return None;
    }
    let count = usize::try_from(be32(header, 8)?).ok()?.min(64);
    (0..count)
        .map(|index| be32(header, 12 + index * 4))
        .collect()
}

/// One font of a collection as a font file of its own: its table directory and tables, copied
/// with their offsets made relative to the new file. What a PDF can embed like any other font.
fn collection_member(bytes: &[u8], member: u32) -> Option<Vec<u8>> {
    let start =
        usize::try_from(*collection_members(bytes)?.get(usize::try_from(member).ok()?)?).ok()?;
    let count = usize::from(be16(bytes, start + 4)?);
    let directory = 12 + count * 16;
    let mut out = bytes.get(start..start + directory)?.to_vec();
    for index in 0..count {
        let record = start + 12 + index * 16;
        let offset = usize::try_from(be32(bytes, record + 8)?).ok()?;
        let length = usize::try_from(be32(bytes, record + 12)?).ok()?;
        let table = bytes.get(offset..offset.checked_add(length)?)?;
        let at = u32::try_from(out.len()).ok()?;
        out.get_mut(12 + index * 16 + 8..12 + index * 16 + 12)?
            .copy_from_slice(&at.to_be_bytes());
        out.extend_from_slice(table);
        // Tables start on four-byte boundaries.
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
    Some(out)
}

/// A font's bytes as a single font file, from its file or out of its collection.
fn font_bytes(source: &FontSource) -> Option<Vec<u8>> {
    let bytes = fs::read(&source.path).ok()?;
    match source.member {
        None => Some(bytes),
        Some(member) => collection_member(&bytes, member),
    }
}

/// Sorts fonts into faces by their subfamily name.
fn faces(sources: impl IntoIterator<Item = FontSource>, family: &str) -> FaceSet {
    let mut set = FaceSet::default();
    for source in sources {
        let Some(bytes) = font_bytes(&source) else {
            continue;
        };
        if !embeddable(&bytes) {
            continue;
        }
        let matches_family =
            font_name(&bytes, 1).is_some_and(|name| name.eq_ignore_ascii_case(family));
        if !matches_family {
            continue;
        }
        let slot = match font_name(&bytes, 2)
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "regular" => &mut set.regular,
            "bold" => &mut set.bold,
            "italic" => &mut set.italic,
            "bold italic" => &mut set.bold_italic,
            _ => continue,
        };
        if slot.is_none() {
            *slot = Some(encode(&bytes));
        }
    }
    set
}

/// Font files in `folder` (TrueType files and collections), and in its subfolders to `depth`.
fn ttf_files(folder: &Path, depth: usize) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    for path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
        if path.is_dir() {
            if depth > 0 {
                files.extend(ttf_files(&path, depth - 1));
            }
        } else if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("ttf") || ext.eq_ignore_ascii_case("ttc"))
        {
            files.push(path);
        }
    }
    files
}

/// The family and subfamily of each font in a font file (one, or each of a collection's): their
/// table directories and `name` tables, not the whole file.
fn fonts_on_disk(path: &Path) -> Vec<(FontSource, String, String)> {
    use std::io::Read;
    let Ok(mut file) = fs::File::open(path) else {
        return Vec::new();
    };
    let mut header = [0u8; 12 + 64 * 4];
    let Ok(read) = file.read(&mut header) else {
        return Vec::new();
    };
    match collection_members(header.get(..read).unwrap_or_default()) {
        Some(members) => members
            .iter()
            .zip(0u32..)
            .filter_map(|(start, member)| {
                let (family, subfamily) = names_at(&mut file, u64::from(*start))?;
                let source = FontSource {
                    path: path.to_path_buf(),
                    member: Some(member),
                };
                Some((source, family, subfamily))
            })
            .collect(),
        None => names_at(&mut file, 0)
            .map(|(family, subfamily)| {
                let source = FontSource {
                    path: path.to_path_buf(),
                    member: None,
                };
                vec![(source, family, subfamily)]
            })
            .unwrap_or_default(),
    }
}

/// The family and subfamily of the font whose table directory starts at `start`.
fn names_at(file: &mut fs::File, start: u64) -> Option<(String, String)> {
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut header = [0u8; 12];
    file.read_exact(&mut header).ok()?;
    let count = usize::from(be16(&header, 4)?);
    let mut records = vec![0u8; count.min(256) * 16];
    file.read_exact(&mut records).ok()?;
    let (chunks, _) = records.as_chunks::<16>();
    let (offset, length) = chunks.iter().find_map(|record| {
        (&record[..4] == b"name").then(|| Some((be32(record, 8)?, be32(record, 12)?)))?
    })?;
    if length > 1024 * 1024 {
        return None;
    }
    file.seek(SeekFrom::Start(u64::from(offset))).ok()?;
    let mut table = vec![0u8; usize::try_from(length).ok()?];
    file.read_exact(&mut table).ok()?;
    Some((name_in_table(&table, 1)?, name_in_table(&table, 2)?))
}

/// Every TrueType file Windows and Office have installed for this user.
fn installed_font_files() -> Vec<PathBuf> {
    let windows_fonts = std::env::var_os("WINDIR").map_or_else(
        || PathBuf::from(r"C:\Windows\Fonts"),
        |dir| PathBuf::from(dir).join("Fonts"),
    );
    let mut files = ttf_files(&windows_fonts, 0);
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        files.extend(ttf_files(&local.join(r"Microsoft\Windows\Fonts"), 0));
        let cloud = local.join(r"Microsoft\FontCache\4\CloudFonts");
        if let Ok(families) = fs::read_dir(&cloud) {
            for family in families.filter_map(Result::ok) {
                files.extend(ttf_files(&family.path(), 0));
            }
        }
    }
    // Linux: the system's and the person's own fonts, in their family folders.
    for folder in ["/usr/share/fonts", "/usr/local/share/fonts"] {
        files.extend(ttf_files(Path::new(folder), 3));
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        files.extend(ttf_files(&home.join(".local/share/fonts"), 3));
        files.extend(ttf_files(&home.join(".fonts"), 3));
    }
    files
}

/// Installed fonts by family (lower case), built once: reading every font's names takes a moment.
fn font_index() -> &'static std::collections::HashMap<String, Vec<FontSource>> {
    static INDEX: std::sync::OnceLock<std::collections::HashMap<String, Vec<FontSource>>> =
        std::sync::OnceLock::new();
    INDEX.get_or_init(|| {
        let mut index: std::collections::HashMap<String, Vec<FontSource>> =
            std::collections::HashMap::new();
        for path in installed_font_files() {
            for (source, family, _) in fonts_on_disk(&path) {
                index.entry(family.to_lowercase()).or_default().push(source);
            }
        }
        index
    })
}

/// The faces of an installed font family that may be embedded in a PDF (docs/spec/05-export.md).
#[tauri::command(async)]
pub fn fonts_family(family: String) -> FaceSet {
    let files = font_index()
        .get(&family.trim().to_lowercase())
        .cloned()
        .unwrap_or_default();
    faces(files, family.trim())
}

/// Whether an uploaded font file (the raw request body) is a TrueType font, which family it is,
/// and whether its licence allows embedding it in a PDF.
#[tauri::command(async)]
pub fn fonts_check(request: tauri::ipc::Request<'_>) -> Result<FontFileInfo, CommandError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(CommandError::new(
            "invalidRequest",
            "The font arrived in the wrong form.",
        ));
    };
    check_font(bytes)
}

fn check_font(bytes: &[u8]) -> Result<FontFileInfo, CommandError> {
    let not_font = || CommandError::new("notFont", "That isn't a TrueType font file (.ttf).");
    // TrueType fonts start with version 1.0 (or "true" on older Macs).
    if bytes.len() > 4 * 1024 * 1024
        || !(bytes.starts_with(&[0, 1, 0, 0]) || bytes.starts_with(b"true"))
    {
        return Err(not_font());
    }
    Ok(FontFileInfo {
        family: font_name(bytes, 1).ok_or_else(not_font)?,
        subfamily: font_name(bytes, 2).unwrap_or_default(),
        embeddable: embeddable(bytes),
    })
}

#[cfg(windows)]
fn path_prefix(path: &Path) -> Option<std::path::Prefix<'_>> {
    match path.components().next() {
        Some(std::path::Component::Prefix(prefix)) => Some(prefix.kind()),
        _ => None,
    }
}

/// Whether a path is an ordinary drive or share path, not a Windows device path (`\\.\…`) or a
/// raw `\\?\` path other than a drive's or share's: exports never go to those.
#[cfg(windows)]
pub(crate) fn ordinary_path(path: &Path) -> bool {
    use std::path::Prefix;
    matches!(
        path_prefix(path),
        Some(Prefix::Disk(_) | Prefix::VerbatimDisk(_) | Prefix::UNC(..) | Prefix::VerbatimUNC(..))
    )
}

/// Whether a path is on one of this PC's drives (a mapped drive letter counts). The export folder
/// is used without a dialog, so it must be one: a `\\server\share` there could only have come
/// from a restored or imported file, and would send every export (and this PC's sign-in, to
/// reach it) to that server without anyone seeing where. A share chosen in the save dialog is fine.
#[cfg(windows)]
pub(crate) fn local_drive(path: &Path) -> bool {
    use std::path::Prefix;
    matches!(
        path_prefix(path),
        Some(Prefix::Disk(_) | Prefix::VerbatimDisk(_))
    )
}

/// Linux: an absolute path outside the kernel's own folders (`/dev`, `/proc`, `/sys`), which hold
/// devices and process state, never documents.
#[cfg(not(windows))]
pub(crate) fn ordinary_path(path: &Path) -> bool {
    path.is_absolute()
        && !["/dev", "/proc", "/sys"]
            .iter()
            .any(|root| path.starts_with(root))
}

/// Linux: any ordinary absolute path. A network folder there is mounted by the computer's owner,
/// with its own credentials, so an export folder on one sends nothing new anywhere.
#[cfg(not(windows))]
pub(crate) fn local_drive(path: &Path) -> bool {
    ordinary_path(path)
}

fn checked_export_path(path: &str) -> Result<&Path, CommandError> {
    let path = Path::new(path);
    let allowed = path.is_absolute()
        && ordinary_path(path)
        && path.extension().is_some_and(|extension| {
            EXPORT_EXTENSIONS
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        });
    if allowed {
        Ok(path)
    } else {
        Err(CommandError::new(
            "notExportFile",
            "Exports can only be saved as PDF, Word or web page files.",
        ))
    }
}

/// Writes an export where the user chose in the save dialog (which already asked before
/// replacing a file), through a temporary file so a failure never leaves half a document.
fn write_export(path: &str, bytes: &[u8]) -> Result<(), CommandError> {
    let path = checked_export_path(path)?;
    if bytes.len() > MAX_EXPORT_BYTES {
        return Err(CommandError::new(
            "tooLarge",
            "The export is too large to save.",
        ));
    }
    library::write_atomic(path, bytes)
        .map_err(|error| CommandError::new("storage", error.to_string()))
}

fn header(request: &tauri::ipc::Request<'_>, name: &str) -> Option<String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| base64::engine::general_purpose::STANDARD.decode(value).ok())
        .and_then(|value| String::from_utf8(value).ok())
}

/// `Guide.pdf`, else `Guide (2).pdf`, `Guide (3).pdf`… in `folder`: an existing file is never
/// replaced silently (docs/spec/05-export.md#saving).
fn unique_path(folder: &Path, name: &str) -> Result<PathBuf, CommandError> {
    let file = Path::new(name);
    let valid = file
        .file_name()
        .is_some_and(|only| only == file.as_os_str())
        && !name.contains(['\\', '/', ':']);
    if !valid {
        return Err(CommandError::new(
            "notExportFile",
            "The file name isn't valid.",
        ));
    }
    let stem = file
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let extension = file
        .extension()
        .map(|ext| ext.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut candidate = folder.join(name);
    let mut number = 2;
    while candidate.exists() {
        candidate = folder.join(format!("{stem} ({number}).{extension}"));
        number += 1;
        if number > 999 {
            return Err(CommandError::new(
                "storage",
                "Too many files with that name already.",
            ));
        }
    }
    Ok(candidate)
}

/// Takes the file as the raw request body (not a JSON array of numbers, which is slow for a
/// large PDF). The destination comes base64-encoded in headers: `x-path` for a place the user
/// chose in the save dialog (which already asked about replacing), or `x-folder` + `x-name` for
/// the default export folder, where a new name is picked rather than replacing anything.
/// Returns where the file went.
#[tauri::command(async)]
pub fn export_write_file(request: tauri::ipc::Request<'_>) -> Result<String, CommandError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(CommandError::new(
            "invalidRequest",
            "The export arrived in the wrong form.",
        ));
    };
    let path = if let Some(path) = header(&request, "x-path") {
        path
    } else {
        let folder = header(&request, "x-folder")
            .ok_or_else(|| CommandError::new("invalidRequest", "The export has no destination."))?;
        let name = header(&request, "x-name")
            .ok_or_else(|| CommandError::new("invalidRequest", "The export has no file name."))?;
        let folder = PathBuf::from(folder);
        if !folder.is_absolute() || !local_drive(&folder) || !folder.is_dir() {
            return Err(CommandError::new(
                "folderMissing",
                "The export folder isn't available. Choose another in Settings.",
            ));
        }
        unique_path(&folder, &name)?.to_string_lossy().into_owned()
    };
    write_export(&path, bytes)?;
    Ok(path)
}

/// Removes the last walkthrough preview. Run at start: the preview is a copy of a guide in app
/// data, and it shouldn't outlive the session it was made in (docs/spec/08, data inventory).
pub fn remove_previews(app: &tauri::AppHandle) {
    if let Ok(folder) = crate::app_folder::local_folder(app) {
        let _ = fs::remove_dir_all(folder.join("preview"));
    }
}

/// "Preview in your browser" for the interactive walkthrough. The app's own content security
/// policy stops the walkthrough's player running inside the app, so the file is written to app
/// data (one preview at a time, replaced each time) and opened in the default browser, which is
/// exactly how a recipient sees it. Only a walkthrough page is accepted.
#[tauri::command(async)]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands take owned arguments"
)]
pub fn export_preview(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), CommandError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(CommandError::new(
            "invalidRequest",
            "The preview arrived in the wrong form.",
        ));
    };
    if !bytes.starts_with(b"<!DOCTYPE html>") {
        return Err(CommandError::new(
            "invalidRequest",
            "Only a walkthrough can be previewed.",
        ));
    }
    let folder = crate::app_folder::local_folder(&app)
        .map_err(|error| CommandError::new("storage", error))?
        .join("preview");
    fs::create_dir_all(&folder).map_err(|error| CommandError::new("storage", error.to_string()))?;
    let file = folder.join("Walkthrough preview.html");
    fs::write(&file, bytes).map_err(|error| CommandError::new("storage", error.to_string()))?;
    crate::open::open_path(&file)
}

/// The Downloads folder, the default place for exports.
#[tauri::command]
pub fn export_default_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    app.path()
        .download_dir()
        .ok()
        .or_else(|| crate::app_folder::home_folder(&app, "Downloads"))
        .map(|path| path.to_string_lossy().into_owned())
}

/// "Open" and "Show in folder" after an export. Only an existing export file (PDF, Word or web
/// page) can be opened this way, with its default app, through Explorer.
#[tauri::command(async)]
pub fn export_show(path: String, reveal: bool) -> Result<(), CommandError> {
    let file = checked_export_path(&path)?;
    if !file.is_file() {
        return Err(CommandError::new(
            "notFound",
            "The exported file isn't there any more.",
        ));
    }
    if reveal {
        crate::open::reveal(file)
    } else {
        crate::open::open_path(file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_folder_exports_never_replace_a_file() {
        let folder = tempfile::tempdir().expect("temp dir");
        let first = unique_path(folder.path(), "Guide - 26-09-2026.pdf").expect("name");
        fs::write(&first, b"one").expect("write");
        let second = unique_path(folder.path(), "Guide - 26-09-2026.pdf").expect("name");
        assert_eq!(
            second.file_name().and_then(|name| name.to_str()),
            Some("Guide - 26-09-2026 (2).pdf")
        );
        for bad in ["..\\escape.pdf", "sub/dir.pdf", "C:evil.pdf"] {
            assert_eq!(
                unique_path(folder.path(), bad).unwrap_err().code(),
                "notExportFile"
            );
        }
    }

    #[test]
    fn only_export_files_are_written() {
        let folder = tempfile::tempdir().expect("temp dir");
        let pdf = folder.path().join("Guide.pdf");
        write_export(&pdf.to_string_lossy(), b"%PDF-1.3").expect("write");
        assert_eq!(fs::read(&pdf).expect("read"), b"%PDF-1.3");
        #[cfg(windows)]
        let bad = [
            "relative.pdf",
            r"C:\Windows\evil.exe",
            r"C:\temp\notes.txt",
            r"\\.\PhysicalDrive0\x.pdf",
        ];
        #[cfg(not(windows))]
        let bad = [
            "relative.pdf",
            "/usr/bin/evil",
            "/tmp/notes.txt",
            "/dev/sda/x.pdf",
            "/proc/self/x.pdf",
        ];
        for bad in bad {
            assert_eq!(write_export(bad, b"x").unwrap_err().code(), "notExportFile");
        }
    }

    #[test]
    #[cfg(windows)]
    fn the_export_folder_must_be_on_this_pcs_drives() {
        assert!(local_drive(Path::new(r"C:\Users\me\Downloads")));
        assert!(local_drive(Path::new(r"Z:\Mapped")));
        assert!(local_drive(Path::new(r"\\?\C:\Users\me")));
        assert!(!local_drive(Path::new(r"\\server\share\exports")));
        assert!(!local_drive(Path::new(r"\\?\UNC\server\share")));
        // A share is still fine when chosen in the save dialog; a device path never is.
        assert!(ordinary_path(Path::new(r"\\server\share\Guide.pdf")));
        assert!(!ordinary_path(Path::new(r"\\.\pipe\x.pdf")));
    }

    #[test]
    #[cfg(not(windows))]
    fn linux_export_folders_are_ordinary_absolute_paths() {
        assert!(local_drive(Path::new("/home/me/Downloads")));
        assert!(local_drive(Path::new("/mnt/team/exports")));
        assert!(!local_drive(Path::new("exports")));
        assert!(!ordinary_path(Path::new("/dev/null.pdf")));
        assert!(!ordinary_path(Path::new("/sys/kernel/x.pdf")));
    }

    #[test]
    fn century_gothic_faces_are_recognised_when_installed() {
        let bold = PathBuf::from(r"C:\Windows\Fonts\GOTHICB.TTF");
        let Ok(bytes) = fs::read(&bold) else {
            return; // Not installed on this machine.
        };
        assert_eq!(font_name(&bytes, 1).as_deref(), Some("Century Gothic"));
        assert_eq!(font_name(&bytes, 2).as_deref(), Some("Bold"));
        assert!(embeddable(&bytes));
    }

    #[test]
    fn installed_families_are_found_by_name_without_reading_whole_files() {
        let bold = PathBuf::from(r"C:\Windows\Fonts\GOTHICB.TTF");
        if !bold.is_file() {
            return; // Not installed on this machine.
        }
        let found = fonts_on_disk(&bold);
        assert_eq!(found.len(), 1);
        assert_eq!(
            (found[0].0.member, found[0].1.as_str(), found[0].2.as_str()),
            (None, "Century Gothic", "Bold")
        );
        let set = fonts_family(" century gothic ".to_string());
        assert!(set.bold.is_some());
        assert_eq!(
            fonts_family("No Such Font 123".to_string()),
            FaceSet::default()
        );
    }

    /// Windows ships its Chinese and Japanese fonts as collections; each font in one comes out as a
    /// font file of its own, which a PDF can embed (docs/spec/05-export.md#languages).
    #[test]
    fn fonts_in_collections_are_found_and_come_out_whole() {
        let collection = PathBuf::from(r"C:\Windows\Fonts\msyh.ttc");
        if !collection.is_file() {
            return; // Not installed on this machine.
        }
        let found = fonts_on_disk(&collection);
        assert!(found.len() >= 2, "Microsoft YaHei and YaHei UI");
        assert!(
            found
                .iter()
                .any(|(source, family, _)| family == "Microsoft YaHei" && source.member.is_some())
        );
        let set = fonts_family("Microsoft YaHei".to_string());
        let regular = base64::engine::general_purpose::STANDARD
            .decode(set.regular.expect("a regular face"))
            .expect("base64");
        // A single font file now: TrueType's version number, and its own names and tables.
        assert_eq!(&regular[..4], &[0, 1, 0, 0]);
        assert_eq!(font_name(&regular, 1).as_deref(), Some("Microsoft YaHei"));
        assert!(table(&regular, *b"glyf").is_some());
        assert!(set.bold.is_some());
        // A font that isn't a collection reads as before.
        assert!(collection_member(&regular, 0).is_none());
    }

    #[test]
    fn uploaded_fonts_are_checked() {
        assert_eq!(check_font(b"not a font").unwrap_err().code(), "notFont");
        assert_eq!(
            check_font(&[0, 1, 0, 0, 0, 0]).unwrap_err().code(),
            "notFont"
        );
        if let Ok(bytes) = fs::read(r"C:\Windows\Fonts\GOTHICB.TTF") {
            assert_eq!(
                check_font(&bytes).unwrap(),
                FontFileInfo {
                    family: "Century Gothic".into(),
                    subfamily: "Bold".into(),
                    embeddable: true
                }
            );
        }
    }

    #[test]
    fn restricted_fonts_are_refused_and_junk_is_ignored() {
        // A minimal font: one OS/2 table whose fsType is 0x0002 (restricted licence).
        let mut font = vec![0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
        font.extend_from_slice(b"OS/2");
        font.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 28, 0, 0, 0, 10]);
        font.extend_from_slice(&[0, 4, 0, 0, 0, 0, 0, 0, 0, 2]);
        assert!(!embeddable(&font));
        assert_eq!(font_name(&font, 1), None);
        assert_eq!(font_name(b"not a font", 1), None);
        let set = faces(
            [FontSource {
                path: PathBuf::from("missing.ttf"),
                member: None,
            }],
            "Aptos",
        );
        assert_eq!(set, FaceSet::default());
    }
}
