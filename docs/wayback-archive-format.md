# Blog migration archive format (for Wayback Machine recovery)

This spec defines the exact JSON shape the Site Intelligence Migration Tool
expects for one "archived" blog migration. Build a file matching this shape
from the Wayback Machine snapshot, hand it back, and it drops straight into
the tool's `migration_archives` table — ready to Import from the Migrate
tab's "Archived Migrations" panel with zero extra work on our end.

If your local Claude Code has this repo (`mmw-site-intelligence`) cloned,
the fastest path is to reuse `analyzers/migrate.js` directly instead of
reimplementing this spec:

```js
const migrate = require('./analyzers/migrate');
const { record, events } = await migrate.buildArchivedPost(post, fullHtml, platform, downloadImage);
```

`buildArchivedPost(post, fullHtml, platform, downloadImage)` already does
everything below — extraction, featured-image priority/fallback, dedup,
image byte-fetching — given a `post` object (`{ url, title, pub_date,
author, category, slug }`, any of which can be `null`/empty), the full page
HTML, a platform string (use `'wordpress'` for this site), and an injected
`downloadImage(absoluteUrl) => Promise<{ buf: Buffer, mimeType, filename }>`.
For Wayback pages, `downloadImage` just needs to `fetch()` the resolved
image URL (see "Wayback specifics" below) — no special-casing needed beyond
that. Skip straight to "Delivering the result" if you go this route.

If you don't have the repo, or want to write this fresh, follow the spec
below exactly — the import code does byte-for-byte string matching in a few
places, called out explicitly.

## Top-level shape

One archive = one JSON object:

```json
{
  "name": "hwcoftexas.com blog recovery (from Wayback, 2026-05-09 snapshot)",
  "source_url": "https://hwcoftexas.com/",
  "platform": "wordpress",
  "post_count": 12,
  "image_count": 12,
  "data": {
    "version": 1,
    "source_url": "https://hwcoftexas.com/",
    "platform": "wordpress",
    "exported_at": "2026-07-13T00:00:00.000Z",
    "posts": [ /* array of post objects — see below */ ],
    "errors": [ /* { "url": "...", "error": "..." } for any post that failed */ ]
  }
}
```

- `name` — human-readable label shown in the Migrate tab's archive list.
- `post_count` / `image_count` — just `data.posts.length` and the total
  image count across all posts (inline images + featured image, summed).
  Cosmetic only; get them right but don't stress over it.
- `data.posts` is the part that matters. One entry per blog post, shape below.

## One post object

```json
{
  "url": "https://hwcoftexas.com/why-mens-testosterone-levels-plateau-and-what-that-is-actually-doing-to-your-body/",
  "title": "Why Men's Testosterone Levels Plateau — and What That Is Actually Doing to Your Body",
  "slug": "why-mens-testosterone-levels-plateau-and-what-that-is-actually-doing-to-your-body",
  "pub_date": "2025-07-02T00:00:00.000Z",
  "author": "Hormone Wellness Center of Texas",
  "category": "Low Testosterone",
  "html": "<p>Most men do not notice it happening all at once...</p><h2>What Testosterone Actually Does in the Male Body</h2><p>...</p>",
  "word_count": 1180,
  "featured_image": {
    "original_url": "https://hwcoftexas.com/wp-content/uploads/2025/07/mens-testosterone-plateau.jpg",
    "filename": "mens-testosterone-plateau.jpg",
    "mime_type": "image/jpeg",
    "data_base64": "iVBORw0KGgoAAAANSUhEUgAA..."
  },
  "images": [
    {
      "original_url": "/wp-content/uploads/2025/07/inline-diagram.png",
      "filename": "inline-diagram.png",
      "mime_type": "image/png",
      "data_base64": "iVBORw0KGgoAAAANSUhEUgAA...",
      "alt": "Testosterone decline chart",
      "width": 800,
      "height": 450
    }
  ]
}
```

### Field rules

| Field | Required | Rules |
|---|---|---|
| `url` | yes | The post's real/original URL (see "Old vs. new URL structure" below). Used only for display and for deriving `slug` if you don't set one — it does **not** control the destination WordPress URL. |
| `title` | yes | Plain text, no HTML. Fall back to the page's `<title>` or `<h1>` if no better source. |
| `slug` | yes | See "Slug algorithm" below. Becomes the actual WordPress post slug. |
| `pub_date` | no (`null` if unknown) | Any string `new Date(...)` can parse — ISO 8601 preferred (`"2025-07-02T00:00:00.000Z"`). If unparseable, the import just leaves the WP post's date unset — not fatal, but try to get real dates from the page (published-time meta tag, visible date near the byline, etc.). |
| `author` | no (`null` if unknown) | Plain text. Not currently written to WP (no author-mapping step exists yet) but kept for the record. |
| `category` | no (`null` if unknown) | Plain text category name. Gets created in WP if it doesn't exist. |
| `html` | yes | The post body content **only** — see "What counts as body content" below. Any well-formed HTML is fine; it gets sanitized to an allowlist automatically on import (headings, paragraphs, lists, links, blockquotes, images, tables, `<br>`/`<hr>` — everything else, e.g. stray `<div>`s or inline `<style>`, is stripped then). You don't need to pre-sanitize. |
| `word_count` | yes | Rough plain-text word count of `html`. Used only to pick 3 "representative" posts for the preview step — doesn't need to be exact. |
| `featured_image` | no (`null` if none found) | See "Featured image" below. |
| `images` | yes (`[]` if none) | Every other image inside `html`, **excluding** whichever one was promoted to `featured_image`. See "Inline images" below. |

### The one hard invariant: `original_url` must match the `<img src>` literally

Both `featured_image.original_url` and every `images[].original_url` are
matched against the **literal, unmodified `src` attribute value** found in
`html` — exact string match, no normalization. This is how the import step
knows which `<img>` tag to rewrite to the new WordPress media URL and which
one to strip (the featured image, so it doesn't render twice).

So: whatever string is inside `<img src="...">` in your extracted `html` —
relative, absolute, Wayback-rewritten, whatever — copy that exact string
into the image record's `original_url`. Don't clean it up, don't resolve it
to absolute first. If you need an absolute URL to actually *download* the
image bytes, resolve it separately for the fetch — but keep the field value
identical to what's in the HTML.

The one exception is `featured_image` when it comes from an `og:image` meta
tag that has **no** matching `<img>` in the body (see below) — there,
`original_url` can just be the resolved absolute image URL, since there's
no HTML string it needs to match against.

### Featured image: priority order + fallback

Try these in order; use whichever succeeds first (a failed download falls
through to the next):

1. **`og:image` meta tag** (or `twitter:image`, or `<link rel="image_src">` as further fallbacks) — resolve it to an absolute URL, download it. If the resolved absolute URL happens to equal the resolved absolute URL of some `<img>` already in the body, note that `<img>`'s raw `src` — you'll need it in step 3.
2. **First `<img>` inside the body content**, if no meta-tag image was found or it failed to download.

If neither works, `featured_image` is `null` and the post just imports
without one — that's fine, not an error.

### Inline images: dedup against the featured image

Once you know the featured image:

- If it came from a body `<img>` (either directly, or because it matched an
  `og:image`), **remove that exact `<img>` tag from `html`** (so it doesn't
  render twice — once as WP's featured image, once inline) and **do not**
  include it again in `images[]`.
- Every other `<img>` in the body goes into `images[]`, with `original_url`
  set to its literal (unmodified) `src` attribute value, plus `alt`,
  `width`, `height` (`null` if unknown/absent).

### `images[]` / `featured_image` byte fields

- `filename` — a short filename with an extension matching `mime_type`
  (e.g. `photo.jpg`, not `photo`). Gets used as the WordPress media library
  filename. Keep it ≤100 characters.
- `mime_type` — a real image MIME type: `image/jpeg`, `image/png`,
  `image/webp`, `image/gif`. Read it from the actual HTTP response's
  `Content-Type` header when you download the image, don't guess from the
  extension.
- `data_base64` — **raw base64 of the image bytes, no `data:` URL prefix.**
  Just `Buffer.from(bytes).toString('base64')` — don't wrap it in
  `data:image/jpeg;base64,...`. The import code does
  `Buffer.from(data_base64, 'base64')` directly; a prefix would corrupt it.

### What counts as "body content"

Extract only the actual article — not the surrounding page template. This
site runs WordPress + Elementor, so the article body lives inside:

```
.elementor-widget-theme-post-content .elementor-widget-container
```

(fall back to `.entry-content` if that selector isn't present on a given
capture). Everything **outside** that container should be excluded, and if
any of the following sneak in *inside* that container on some page,
strip them too:

- Site nav / header / footer
- Post title, category tags, date/comment-count row (these live in
  separate Elementor widgets above the content widget, not inside it —
  should already be excluded if you use the selector above)
- Share buttons, author box, comments
- "Categories" widget, newsletter signup form
- "Latest Post" / related-posts sidebar

Keep: paragraphs, headings, lists, blockquotes, tables, inline images,
links — the actual writing.

### Slug algorithm

Match this exactly so slugs stay stable and predictable (this is also what
prevents duplicate WordPress posts on re-import — the tool checks for an
existing post with the same slug and skips it if found):

1. Take the **last non-empty path segment** of the post's original URL
   (before any `/blog/` prefix was added on the new site — see below).
   E.g. `https://hwcoftexas.com/why-mens-testosterone-levels-plateau.../` →
   `why-mens-testosterone-levels-plateau...`.
2. Lowercase it.
3. Normalize accented characters to plain ASCII (NFKD normalize, strip
   combining marks) and strip curly quotes.
4. Replace every run of non-`[a-z0-9]` characters with a single `-`.
5. Trim leading/trailing `-`.
6. Truncate to 80 characters.
7. If the result is empty, use `"post"`.

If you can't cleanly derive this, a reasonable slugified version of the
title works too — just be consistent so re-imports don't create duplicates.

### Old vs. new URL structure

You mentioned the live site now serves posts under `/blog/...` while the
old (archived) site didn't have that prefix. This **does not matter** for
the import — WordPress decides the final published URL itself, from its own
permalink settings plus whatever `slug` you send; the `url` field here is
just a provenance/display string, never used to construct the destination
URL. Simplest: just set `url` to the real historical URL as found in the
Wayback capture. (You're welcome to rewrite it to the anticipated new
`/blog/...` form instead if you'd rather the archive list read that way —
purely cosmetic either way.)

## Wayback Machine specifics

- Use the **CDX API** to enumerate captured URLs:
  `http://web.archive.org/cdx/search/cdx?url=hwcoftexas.com/*&output=json&filter=statuscode:200&collapse=urlkey&from=20260101&to=20260601`
  — filter the results to blog-post-shaped paths (exclude `/category/`,
  `/tag/`, `/page/`, `/wp-json/`, static assets, etc.).
- Fetch each page's clean HTML with the `id_` modifier (no Wayback
  toolbar/banner injected): `https://web.archive.org/web/<timestamp>id_/<original-url>`.
- Resolve any relative `<img src>` / meta tag URLs against the **Wayback
  page URL you fetched**, not the original site's domain — Wayback rewrites
  most asset references to `/web/<timestamp>im_/<original-absolute-url>`
  relative paths, and those only resolve correctly against
  `https://web.archive.org/...`.
- Fetching an image URL that already has the `im_` suffix returns the raw
  image bytes directly (no extra rewriting needed) — that's your
  `downloadImage()`.
- Some posts may have multiple captures in the window; pick the capture
  closest to the timestamp you're targeting, or the most complete one if an
  early capture is truncated/incomplete.
- If a given post has no capture at all, or every image download fails, add
  `{ "url": "...", "error": "..." }` to the top-level `data.errors` array
  and move on — a partial archive (some posts, some errors) is still fully
  usable; it doesn't need to be all-or-nothing.

## Delivering the result

Once you have the JSON, send it back in this conversation (paste it,
attach the file, or point me at where it lives) and I'll insert it directly
into the `migration_archives` table here — at that point it shows up in the
Migrate tab's "Archived Migrations" panel exactly like an archive built by
the live tool, ready for you to click **Import this archive** and push to
WordPress.

If the resulting JSON is large (base64 images add up), a plain `.json` file
is fine — no need to gzip or split it, but let me know if it's over
~20&nbsp;MB and we can figure out chunking.
