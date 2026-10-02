# Amluto Steps website

The Amluto Steps privacy policy ([index.html](index.html)), published at **https://privacy.amluto.com/**, the address that goes in the Store listing's privacy policy field.

- Plain HTML and one stylesheet. No build, no scripts, no cookies, and nothing loaded from other sites (each page's CSP says so).
- Colours are the app's brand tokens from `packages/ui/src/styles.css`, with the dark ones under `prefers-color-scheme: dark`. The logo is a copy of `packages/ui/src/assets/logo-horizontal-white.svg`.
- **Keep the privacy policy true.** When the app starts reading, keeping or sending something new, update `index.html` and its date in the same commit. Its content follows what Steps reads, keeps and sends.

## Publishing

It's published to `privacy.amluto.com` on **SiteGround**, where Amluto already has hosting (27/09/2026):

1. Site Tools → Domain → Subdomains: create `privacy.amluto.com`. It gets its own folder, `privacy.amluto.com/public_html`.
2. Site Tools → Site → File Manager (or SFTP): upload `index.html`, `style.css`, `logo.svg`, `favicon.svg` and `favicon.png` from this folder into that `public_html`, replacing SiteGround's placeholder page. Not this README.
3. Site Tools → Security → SSL Manager: a free Let's Encrypt certificate for the subdomain, then HTTPS Enforce on.
4. Open https://privacy.amluto.com/ and check the logo and styling load.

After any change to the policy, upload `index.html` again.

The contact address is **steps@amluto.com** (also where the app's support email goes); security reports go to security@amluto.com, as in `SECURITY.md`.
