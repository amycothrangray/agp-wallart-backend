/* AGP Wall Art backend — receives client designs and emails them to Amy.
   Deploy on DigitalOcean App Platform. Required environment variables:
     SMTP_USER  — the Gmail address that sends the mail (amy@amygray.net)
     SMTP_PASS  — a Google "app password" for that account (SECRET)
     MAIL_TO    — where designs land (defaults to amy@amygray.net)
     ALLOW_ORIGIN — the app's origin (defaults to the GitHub Pages site) */
'use strict';
const express = require('express');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json({ limit: '30mb' }));

const ORIGIN = process.env.ALLOW_ORIGIN || 'https://amycothrangray.github.io';
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', ORIGIN);
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-AGP-Key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/submit', async (req, res) => {
  try {
    const { design, summary, contact, png } = req.body || {};
    if (!design || !contact || !contact.email || !contact.name) {
      return res.status(400).json({ error: 'missing design or contact details' });
    }
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const safeName = String(contact.name).replace(/[^\w\s-]/g, '').trim() || 'client';
    const fileBase = safeName.toLowerCase().replace(/\s+/g, '-');
    const attachments = [{
      filename: fileBase + '.wallart.json',
      content: JSON.stringify(design),
      contentType: 'application/json',
    }];
    if (typeof png === 'string' && png.length > 100 && png.length < 12_000_000) {
      attachments.push({
        filename: fileBase + '-mockup.png',
        content: Buffer.from(png, 'base64'),
        contentType: 'image/png',
      });
    }
    await transporter.sendMail({
      from: `"Wall Art Mock-Up" <${process.env.SMTP_USER}>`,
      to: process.env.MAIL_TO || 'amy@amygray.net',
      replyTo: `"${safeName}" <${contact.email}>`,
      subject: `Wall art design — ${safeName}`,
      text: `${summary || ''}\n\nFrom: ${safeName} <${contact.email}>` +
        (contact.phone ? ` · ${contact.phone}` : '') +
        (contact.note ? `\n\nNote from the client:\n${contact.note}` : '') +
        '\n\nThe -mockup.png shows the design; the .wallart.json opens in the mock-up app with the Open button (photos included).',
      attachments,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('submit failed:', err.message);
    res.status(500).json({ error: 'send failed' });
  }
});

/* ---------------------------------------------------------------------------
   AGP Blog Builder routes — used by https://amycothrangray.github.io/agp-blog-builder/
   Additional environment variables:
     BLOG_APP_KEY      — shared passphrase Hannah enters once in the app (SECRET)
     WP_URL            — https://amygrayphotography.com
     WP_USER           — WordPress username the Application Password belongs to
     WP_APP_PASSWORD   — WordPress Application Password (SECRET)
     ANTHROPIC_API_KEY — for AI suggestions (SECRET)
--------------------------------------------------------------------------- */

const WP_URL = (process.env.WP_URL || 'https://amygrayphotography.com').replace(/\/$/, '');
const wpAuth = () => 'Basic ' + Buffer.from(
  `${process.env.WP_USER}:${process.env.WP_APP_PASSWORD}`).toString('base64');

function requireBlogKey(req, res, next) {
  if (!process.env.BLOG_APP_KEY) return res.status(503).json({ error: 'blog routes not configured' });
  if (req.get('x-agp-key') !== process.env.BLOG_APP_KEY) {
    return res.status(401).json({ error: 'wrong passphrase' });
  }
  next();
}

async function wpFetch(path, opts = {}) {
  const r = await fetch(WP_URL + path, {
    ...opts,
    headers: { Authorization: wpAuth(), ...(opts.headers || {}) },
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, ok: r.ok, body };
}

/* Site data for the link picker & category dropdown (cached 10 min). */
let siteCache = { at: 0, data: null };
app.get('/api/blog/site', requireBlogKey, async (req, res) => {
  try {
    if (siteCache.data && Date.now() - siteCache.at < 10 * 60 * 1000) {
      return res.json(siteCache.data);
    }
    const [cats, posts, pages] = await Promise.all([
      wpFetch('/wp-json/wp/v2/categories?per_page=100&orderby=count&order=desc&_fields=id,name,count'),
      wpFetch('/wp-json/wp/v2/posts?per_page=60&_fields=id,title,link,date'),
      wpFetch('/wp-json/wp/v2/pages?per_page=60&_fields=id,title,link'),
    ]);
    const data = {
      categories: (cats.body || []).map(c => ({ id: c.id, name: c.name, count: c.count })),
      posts: (posts.body || []).map(p => ({ title: p.title?.rendered || '', url: p.link, date: p.date })),
      pages: (pages.body || []).map(p => ({ title: p.title?.rendered || '', url: p.link })),
    };
    siteCache = { at: Date.now(), data };
    res.json(data);
  } catch (err) {
    console.error('site fetch failed:', err.message);
    res.status(502).json({ error: 'could not reach the website' });
  }
});

/* Upload one resized photo to the WordPress media library. */
app.post('/api/blog/media', requireBlogKey, async (req, res) => {
  try {
    const { filename, dataBase64, alt, title, caption, description } = req.body || {};
    if (!filename || !dataBase64) return res.status(400).json({ error: 'missing file' });
    const buf = Buffer.from(dataBase64, 'base64');
    if (buf.length > 12_000_000) return res.status(413).json({ error: 'image too large' });
    const safe = String(filename).replace(/[^\w.-]/g, '-').toLowerCase();
    const up = await wpFetch('/wp-json/wp/v2/media', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Disposition': `attachment; filename="${safe}"`,
      },
      body: buf,
    });
    if (!up.ok) {
      console.error('media upload failed:', up.status, JSON.stringify(up.body).slice(0, 300));
      return res.status(502).json({ error: 'WordPress rejected the upload' });
    }
    const id = up.body.id;
    if (alt || title || caption || description) {
      await wpFetch(`/wp-json/wp/v2/media/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alt_text: alt || '',
          title: title || safe,
          ...(caption ? { caption } : {}),
          ...(description ? { description } : {}),
        }),
      });
    }
    res.json({ id, url: up.body.source_url });
  } catch (err) {
    console.error('media failed:', err.message);
    res.status(500).json({ error: 'upload failed' });
  }
});

/* Create the post itself. Tries to set Yoast fields; falls back gracefully
   if the site doesn't have the tiny agp-blog-meta plugin installed. */
app.post('/api/blog/publish', requireBlogKey, async (req, res) => {
  try {
    const { title, slug, contentHtml, excerpt, categories, featuredMediaId,
            status, metaDesc, focusKeyword } = req.body || {};
    if (!title || !contentHtml) return res.status(400).json({ error: 'missing title or content' });
    const base = {
      title, slug: slug || undefined, content: contentHtml,
      excerpt: excerpt || metaDesc || '',
      categories: Array.isArray(categories) ? categories : [],
      featured_media: featuredMediaId || undefined,
      status: status === 'draft' ? 'draft' : 'publish',
    };
    const meta = {};
    if (metaDesc) meta._yoast_wpseo_metadesc = metaDesc;
    if (focusKeyword) meta._yoast_wpseo_focuskw = focusKeyword;
    let r = await wpFetch('/wp-json/wp/v2/posts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.keys(meta).length ? { ...base, meta } : base),
    });
    let yoastMetaApplied = Object.keys(meta).length > 0;
    if (!r.ok && Object.keys(meta).length) {
      yoastMetaApplied = false;
      r = await wpFetch('/wp-json/wp/v2/posts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(base),
      });
    }
    if (!r.ok) {
      console.error('publish failed:', r.status, JSON.stringify(r.body).slice(0, 300));
      return res.status(502).json({ error: 'WordPress rejected the post' });
    }
    siteCache = { at: 0, data: null };
    res.json({ id: r.body.id, link: r.body.link, yoastMetaApplied });
  } catch (err) {
    console.error('publish failed:', err.message);
    res.status(500).json({ error: 'publish failed' });
  }
});

/* AI suggestions: titles, meta description, per-photo alt text, link ideas.
   Thumbnails are sent so the model can actually see the photos. */
app.post('/api/blog/suggest', requireBlogKey, async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI not configured' });
    const { title, location, text, thumbs, keywords } = req.body || {};
    let site = siteCache.data;
    if (!site) {
      try {
        const posts = await wpFetch('/wp-json/wp/v2/posts?per_page=40&_fields=title,link');
        const pages = await wpFetch('/wp-json/wp/v2/pages?per_page=40&_fields=title,link');
        site = {
          posts: (posts.body || []).map(p => ({ title: p.title?.rendered, url: p.link })),
          pages: (pages.body || []).map(p => ({ title: p.title?.rendered, url: p.link })),
        };
      } catch { site = { posts: [], pages: [] }; }
    }
    const internalList = [...(site.pages || []), ...(site.posts || [])]
      .map(p => `- ${p.title}: ${p.url}`).join('\n');

    const content = [];
    (Array.isArray(thumbs) ? thumbs.slice(0, 20) : []).forEach((t, i) => {
      content.push({ type: 'text', text: `Photo ${i + 1} (${t.filename || 'photo'}):` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: t.dataBase64 } });
    });
    content.push({
      type: 'text',
      text:
`You are the SEO assistant for Amy Gray Photography, a family/beach photographer in San Diego (amygrayphotography.com). A blog post is being prepared.

Working title: ${title || '(none yet)'}
Location: ${location || '(unknown)'}
Post text:
${(text || '(no text yet)').slice(0, 6000)}

Existing pages and posts on the site (for internal links — use ONLY these URLs):
${internalList.slice(0, 8000)}

Keywords Amy is actively trying to rank for. Work the relevant ones in naturally —
never stuff them, and never use one that doesn't genuinely fit this session:
${(Array.isArray(keywords) && keywords.length ? keywords : ['san diego family photographer']).join(', ')}

Return ONLY a JSON object, no markdown fences, with keys:
"titleOptions": 3 SEO title options in Amy's style "Location Type Photos | Emotional Hook" (e.g. "Hotel del Coronado Family Photos | Before the Next Chapter Begins")
"slug": url slug for the best title
"metaDescription": max 155 chars, warm, includes location + the most relevant target keyword
"excerpt": 1-2 sentence excerpt
"focusKeyword": short focus keyphrase — pick from Amy's keyword list above when one fits
"secondaryKeywords": 2-4 more from her list that this post can realistically support
"inlineLinks": THE MOST IMPORTANT FIELD. Links to weave into the body text itself.
   3-6 items {"phrase","url","title","kind","why"} where:
     - "phrase" MUST be a short word-for-word quote (2-6 words) copied EXACTLY from the post text above, including its exact capitalisation. Never invent a phrase that is not in the text. Pick natural anchor text (a place name, an activity, a phrase like "beach family session").
     - "url" is either one of Amy's URLs listed above (kind: "internal") or an official outside site for a venue/attraction/location mentioned in the text, e.g. SeaWorld, Hotel del Coronado, Balboa Park (kind: "external"). Only well-known official URLs.
     - Prefer a mix: at least one internal and at least one external when the text supports it.
     - Each phrase must be distinct and appear only once in your list.
"internalLinks": 2-4 items {"title","url","why"} for the "keep exploring" list at the end (do not duplicate inlineLinks)
"externalLinks": 1-2 items {"title","url","why"} — official venue/location pages, for the end list
"categoryHints": array of likely category names`,
    });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        // Roomy: a 20-photo post needs alt text + filenames + links for each.
        // Too low and the JSON comes back truncated and unparseable.
        max_tokens: 8000,
        messages: [{ role: 'user', content }],
      }),
    });
    const body = await r.json();
    if (!r.ok) {
      console.error('anthropic failed:', r.status, JSON.stringify(body).slice(0, 300));
      return res.status(502).json({ error: 'AI request failed' });
    }
    if (body.stop_reason === 'max_tokens') {
      console.error('anthropic response hit max_tokens — reply was truncated');
    }
    let textOut = (body.content || []).map(c => c.text || '').join('');
    textOut = textOut.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim();
    const first = textOut.indexOf('{');
    const last = textOut.lastIndexOf('}');
    let parsed;
    try {
      parsed = JSON.parse(textOut.slice(first, last + 1));
    } catch (parseErr) {
      console.error('suggest JSON parse failed (%s), stop_reason=%s, chars=%d',
        parseErr.message, body.stop_reason, textOut.length);
      return res.status(502).json({ error: 'the AI reply was cut short — try again' });
    }
    res.json(parsed);
  } catch (err) {
    console.error('suggest failed:', err.message);
    res.status(500).json({ error: 'suggestions failed' });
  }
});

/* Alt text + filenames for a batch of photos. Kept separate from /suggest so a
   post with 30+ photos works: the frontend sends them in small batches instead
   of one giant request that would overflow the reply limit. */
app.post('/api/blog/alt', requireBlogKey, async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI not configured' });
    const { title, location, keywords, thumbs, startIndex } = req.body || {};
    const list = Array.isArray(thumbs) ? thumbs.slice(0, 10) : [];
    if (!list.length) return res.json({ altTexts: [], imageFilenames: [] });

    const content = [];
    list.forEach((t, i) => {
      content.push({ type: 'text', text: `Photo ${i + 1}:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: t.dataBase64 } });
    });
    content.push({
      type: 'text',
      text:
`These are photos from a blog post for Amy Gray Photography, a San Diego family photographer.

Post title: ${title || '(untitled)'}
Location: ${location || '(unknown)'}
Keywords Amy wants to rank for: ${(Array.isArray(keywords) && keywords.length ? keywords : ['San Diego family photographer']).join(', ')}

For EACH of the ${list.length} photos, in order, write:
- alt text: describe what is actually happening in that specific photo (who, what, where) in at most 14 words. Every one must be different from the others — never repeat a generic line. Mention the location naturally in some of them. Work a keyword in ONLY where it honestly describes the picture.
- a filename: kebab-case, descriptive, includes the location, no extension.

Return ONLY JSON, no markdown fences:
{"altTexts":["...", ...], "imageFilenames":["...", ...]}
Both arrays must have exactly ${list.length} entries, in the same order as the photos.`,
    });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 3000, messages: [{ role: 'user', content }] }),
    });
    const body = await r.json();
    if (!r.ok) {
      console.error('alt anthropic failed:', r.status, JSON.stringify(body).slice(0, 300));
      return res.status(502).json({ error: 'AI request failed' });
    }
    let out = (body.content || []).map(c => c.text || '').join('');
    out = out.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim();
    const a = out.indexOf('{'), b = out.lastIndexOf('}');
    let parsed;
    try { parsed = JSON.parse(out.slice(a, b + 1)); }
    catch (e) {
      console.error('alt parse failed:', e.message, 'stop_reason=', body.stop_reason);
      return res.status(502).json({ error: 'the AI reply was cut short — try again' });
    }
    res.json({
      altTexts: parsed.altTexts || [],
      imageFilenames: parsed.imageFilenames || [],
      startIndex: startIndex || 0,
    });
  } catch (err) {
    console.error('alt failed:', err.message);
    res.status(500).json({ error: 'alt text failed' });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('agp-wallart-backend listening on ' + port));
