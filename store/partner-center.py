"""Builds store/partner-center/: the Microsoft Store listings for Partner Center's "Import listings >
Import folder", in every language, from store/listings/*.md and the images in store/.

    python store/partner-center.py <the CSV exported from Partner Center>

Partner Center's own export is the template: its rows (fields) and columns (languages) are kept, and
only the cells Steps fills are written. "What's new" is left empty for the first public release.
Image paths start with the folder's own name, as Partner Center requires.
"""
import csv
import re
import shutil
import sys
from pathlib import Path

STORE = Path(__file__).parent
OUT = STORE / "partner-center"
LISTINGS = STORE / "listings"

# Partner Center's language codes, and the listing file each one comes from.
FILES = {
    "default": "en", "en-gb": "en", "pt-br": "pt-BR", "pt-pt": "pt-PT", "zh-hans": "zh-Hans",
    "zh-hant": "zh-Hant", "sr-latn-rs": "sr-Latn", "sr-cyrl-rs": "sr-Cyrl",
}
SCREENSHOTS = ["01-editor.png", "02-library.png", "03-export-review.png", "04-web-export.png",
               "05-brand-editor.png", "06-start-dialog.png"]
LIMITS = {"Description": 10000, "Feature": 200, "Caption": 200, "SearchTerm": 30}


def blocks(code):
    text = (LISTINGS / f"{FILES.get(code, code)}.md").read_text(encoding="utf-8")
    store = re.split(r"^## ", text, flags=re.M)[1]
    found = [b.strip() for b in re.findall(r"```\n(.*?)```", store, flags=re.S)]
    assert len(found) == 5, (code, len(found))
    description, _whats_new, features, captions, terms = found
    return description, features.split("\n"), captions.split("\n"), terms.split("\n")


def check(kind, code, value):
    if len(value) > LIMITS[kind]:
        raise SystemExit(f"{code}: a {kind} is {len(value)} characters, over {LIMITS[kind]}: {value[:60]}")


def main(template):
    rows = list(csv.reader(open(template, encoding="utf-8-sig", newline="")))
    header = rows[0]
    languages = header[3:]
    by_field = {row[0]: row for row in rows[1:] if row and row[0]}

    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "screenshots").mkdir(parents=True)
    (OUT / "art").mkdir()
    for name in SCREENSHOTS:
        shutil.copy(STORE / "screenshots" / name, OUT / "screenshots" / name)
    for name in ["box-art-2160.png", "poster-art-1440x2160.png", "store-logo-300.png"]:
        shutil.copy(STORE / "art" / name, OUT / "art" / name)

    def put(field, column, value):
        by_field[field][3 + column] = value

    for column, code in enumerate(languages):
        description, features, captions, terms = blocks(code)
        check("Description", code, description)
        put("Description", column, description)
        put("ReleaseNotes", column, "")
        put("Title", column, "Steps by Amluto")
        put("DevStudio", column, "Amluto Solutions Ltd")
        put("CopyrightTrademarkInformation", column, "© 2026 Amluto Solutions Ltd")
        put("AdditionalLicenseTerms", column,
            "Steps is free software under the GNU General Public License, version 3 or later. "
            "Its source code is at https://github.com/amluto-solutions/steps")
        for index, name in enumerate(SCREENSHOTS, 1):
            put(f"DesktopScreenshot{index}", column, f"{OUT.name}/screenshots/{name}")
        assert len(captions) == len(SCREENSHOTS), (code, len(captions))
        for index, caption in enumerate(captions, 1):
            check("Caption", code, caption)
            put(f"DesktopScreenshotCaption{index}", column, caption)
        put("StoreLogo720x1080", column, f"{OUT.name}/art/poster-art-1440x2160.png")
        put("StoreLogo1080x1080", column, f"{OUT.name}/art/box-art-2160.png")
        put("StoreLogo300x300", column, f"{OUT.name}/art/store-logo-300.png")
        for index, feature in enumerate(features, 1):
            check("Feature", code, feature)
            put(f"Feature{index}", column, feature)
        # At most 21 words across a language's search terms: the last ones go first (Vietnamese,
        # whose words are syllables, Portuguese and Romanian ran over).
        while sum(len(term.split()) for term in terms) > 21:
            terms = terms[:-1]
        for index in range(1, 8):
            put(f"SearchTerm{index}", column, "")
        for index, term in enumerate(terms, 1):
            check("SearchTerm", code, term)
            put(f"SearchTerm{index}", column, term)

    name = "listingData-9P6K3W69FX1J.csv"
    with open(OUT / name, "w", encoding="utf-8-sig", newline="") as out:
        csv.writer(out, quoting=csv.QUOTE_MINIMAL).writerows(rows)
    print(f"{OUT}: {name}, {len(languages)} languages, {len(SCREENSHOTS)} screenshots, 3 logos")


if __name__ == "__main__":
    main(sys.argv[1])
