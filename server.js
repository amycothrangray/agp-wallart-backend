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
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-AGP-Key, X-CU-Key');
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
   Blog Builder routes — one engine, mounted once per website.

     /api/blog/*     Amy Gray Photography   → https://amycothrangray.github.io/agp-blog-builder/
     /api/cu/blog/*  Christian Unified      → https://amycothrangray.github.io/cu-blog-builder/

   Each site brings its own passphrase, WordPress credentials and AI briefing;
   everything else (media upload, publish, alt text) is shared code.

   Environment variables — Amy Gray Photography:
     BLOG_APP_KEY      — passphrase Hannah enters once in the app (SECRET)
     WP_URL            — https://amygrayphotography.com (this is the default)
     WP_USER           — WordPress username the Application Password belongs to
     WP_APP_PASSWORD   — WordPress Application Password (SECRET)

   Environment variables — Christian Unified:
     CU_BLOG_APP_KEY   — passphrase for the school's app (SECRET)
     CU_WP_URL         — https://christianunified.org (this is the default)
     CU_BRIDGE_SECRET  — shared secret shown by the cu-blog-bridge plugin at
                         Settings -> CU Blog Bridge (SECRET). Used instead of an
                         application password: Wordfence disables those on that
                         site, so the plugin exposes its own guarded routes.

   Shared:
     ANTHROPIC_API_KEY — for AI suggestions (SECRET)
--------------------------------------------------------------------------- */

function mountBlogRoutes(app, cfg) {
  const base = cfg.base;
  const wpUrl = () => (process.env[cfg.env.url] || cfg.defaultUrl).replace(/\/$/, '');
  const wpAuth = () => 'Basic ' + Buffer.from(
    `${process.env[cfg.env.user]}:${process.env[cfg.env.pass]}`).toString('base64');

  function requireKey(req, res, next) {
    const expected = process.env[cfg.env.key];
    if (!expected) return res.status(503).json({ error: 'blog routes not configured' });
    if (req.get(cfg.header) !== expected) {
      return res.status(401).json({ error: 'wrong passphrase' });
    }
    next();
  }

  /* Two ways to talk to a WordPress site:
       - stock wp/v2 REST + an application password (Amy Gray Photography), or
       - the cu-blog-bridge plugin + a shared secret (Christian Unified, where
         Wordfence disables application passwords site-wide).
     Reads are the same either way: categories, posts and pages are public, so
     a bridge site needs no WordPress login at all. */
  const useBridge = !!cfg.bridge;

  async function wpFetch(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (!useBridge) headers.Authorization = wpAuth();
    const r = await fetch(wpUrl() + path, { ...opts, headers });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, ok: r.ok, body };
  }

  async function bridgeFetch(path, payload) {
    const r = await fetch(wpUrl() + '/wp-json/cu-blog/v1' + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CU-Bridge-Secret': process.env[cfg.bridge.secretEnv] || '',
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, ok: r.ok, body };
  }

  /* Walk WordPress pagination. christianunified.org has 263 pages — one
     per_page=100 call silently hid Campus Tours and Admission, the two pages
     the link picker most wants, so collect a few pages' worth. */
  async function collect(path, maxRequests) {
    const out = [];
    for (let page = 1; page <= maxRequests; page++) {
      const r = await wpFetch(`${path}&per_page=100&page=${page}`);
      if (!r.ok || !Array.isArray(r.body)) break;
      out.push(...r.body);
      if (r.body.length < 100) break;
    }
    return out;
  }

  /* Site data for the link picker & category chips (cached 10 min, per site). */
  let siteCache = { at: 0, data: null };
  app.get(base + '/site', requireKey, async (req, res) => {
    try {
      if (siteCache.data && Date.now() - siteCache.at < 10 * 60 * 1000) {
        return res.json(siteCache.data);
      }
      const [cats, posts, pages, root] = await Promise.all([
        wpFetch('/wp-json/wp/v2/categories?per_page=100&orderby=count&order=desc&_fields=id,name,count'),
        collect('/wp-json/wp/v2/posts?_fields=id,title,link,date', 1),
        collect('/wp-json/wp/v2/pages?_fields=id,title,link', 4),
        wpFetch('/wp-json/'),
      ]);
      // The site's own timezone drives scheduling: the app sends plain local
      // times and WordPress interprets them in this zone, so what the writer
      // picks is what readers see. Restored here — it was added for scheduled
      // posts and then dropped by a later refactor, which broke back-dating.
      const tz = (root.body && root.body.timezone_string) || cfg.defaultTimezone;
      const data = {
        categories: (cats.body || []).map(c => ({ id: c.id, name: c.name, count: c.count })),
        posts: posts.map(p => ({ title: p.title?.rendered || '', url: p.link, date: p.date })),
        pages: pages.map(p => ({ title: p.title?.rendered || '', url: p.link })),
        timezone: tz,
        siteTimeNow: new Date().toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T').slice(0, 16),
      };
      siteCache = { at: Date.now(), data };
      res.json(data);
    } catch (err) {
      console.error(base, 'site fetch failed:', err.message);
      res.status(502).json({ error: 'could not reach the website' });
    }
  });

  /* Upload one resized photo to the WordPress media library. */
  app.post(base + '/media', requireKey, async (req, res) => {
    try {
      const { filename, dataBase64, alt, title, caption, description } = req.body || {};
      if (!filename || !dataBase64) return res.status(400).json({ error: 'missing file' });
      const buf = Buffer.from(dataBase64, 'base64');
      if (buf.length > 12_000_000) return res.status(413).json({ error: 'image too large' });
      const safe = String(filename).replace(/[^\w.-]/g, '-').toLowerCase();

      if (useBridge) {
        const b = await bridgeFetch('/media', {
          filename: safe, dataBase64,
          alt: alt || '', title: title || safe,
          caption: caption || '', description: description || '',
        });
        if (!b.ok) {
          console.error(base, 'bridge media failed:', b.status, JSON.stringify(b.body).slice(0, 300));
          return res.status(502).json({ error: 'WordPress rejected the upload' });
        }
        return res.json({ id: b.body.id, url: b.body.url });
      }

      const up = await wpFetch('/wp-json/wp/v2/media', {
        method: 'POST',
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Disposition': `attachment; filename="${safe}"`,
        },
        body: buf,
      });
      if (!up.ok) {
        console.error(base, 'media upload failed:', up.status, JSON.stringify(up.body).slice(0, 300));
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
      console.error(base, 'media failed:', err.message);
      res.status(500).json({ error: 'upload failed' });
    }
  });

  /* Create the post itself. Tries to set Yoast fields; falls back gracefully
     if the site doesn't have the tiny blog-meta bridge plugin installed. */
  app.post(base + '/publish', requireKey, async (req, res) => {
    try {
      const { title, slug, contentHtml, excerpt, categories, featuredMediaId,
              status, metaDesc, focusKeyword, date } = req.body || {};
      if (!title || !contentHtml) return res.status(400).json({ error: 'missing title or content' });
      if (useBridge) {
        const b = await bridgeFetch('/publish', {
          title, slug: slug || '', contentHtml,
          excerpt: excerpt || metaDesc || '',
          categories: Array.isArray(categories) ? categories : [],
          featuredMediaId: featuredMediaId || 0,
          status: status === 'draft' ? 'draft' : 'publish',
          metaDesc: metaDesc || '', focusKeyword: focusKeyword || '',
          date: date || '',
        });
        if (!b.ok) {
          console.error(base, 'bridge publish failed:', b.status, JSON.stringify(b.body).slice(0, 300));
          return res.status(502).json({ error: 'WordPress rejected the post' });
        }
        siteCache = { at: 0, data: null };
        return res.json({
          id: b.body.id, link: b.body.link,
          yoastMetaApplied: !!b.body.yoastMetaApplied,
        });
      }

      const post = {
        title, slug: slug || undefined, content: contentHtml,
        excerpt: excerpt || metaDesc || '',
        categories: Array.isArray(categories) ? categories : [],
        featured_media: featuredMediaId || undefined,
        status: status === 'draft' ? 'draft' : 'publish',
      };
      if (date) {
        post.date = date;
        // WordPress only queues a post when the status says 'future'; without
        // this a scheduled post goes live at once, dated in the future.
        if (post.status === 'publish' && new Date(date) > new Date()) post.status = 'future';
      }
      const meta = {};
      if (metaDesc) meta._yoast_wpseo_metadesc = metaDesc;
      if (focusKeyword) meta._yoast_wpseo_focuskw = focusKeyword;
      let r = await wpFetch('/wp-json/wp/v2/posts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.keys(meta).length ? { ...post, meta } : post),
      });
      let yoastMetaApplied = Object.keys(meta).length > 0;
      if (!r.ok && Object.keys(meta).length) {
        yoastMetaApplied = false;
        r = await wpFetch('/wp-json/wp/v2/posts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(post),
        });
      }
      if (!r.ok) {
        console.error(base, 'publish failed:', r.status, JSON.stringify(r.body).slice(0, 300));
        return res.status(502).json({ error: 'WordPress rejected the post' });
      }
      siteCache = { at: 0, data: null };
      res.json({ id: r.body.id, link: r.body.link, yoastMetaApplied });
    } catch (err) {
      console.error(base, 'publish failed:', err.message);
      res.status(500).json({ error: 'publish failed' });
    }
  });

  /* AI suggestions: titles, meta description, link ideas.
     Thumbnails are sent so the model can actually see the photos. */
  app.post(base + '/suggest', requireKey, async (req, res) => {
    try {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI not configured' });
      const { title, location, text, thumbs, keywords } = req.body || {};
      let site = siteCache.data;
      if (!site) {
        try {
          const posts = await collect('/wp-json/wp/v2/posts?_fields=title,link', 1);
          const pages = await collect('/wp-json/wp/v2/pages?_fields=title,link', 4);
          site = {
            posts: posts.map(p => ({ title: p.title?.rendered, url: p.link })),
            pages: pages.map(p => ({ title: p.title?.rendered, url: p.link })),
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
      const { facts } = req.body || {};
      let promptText = cfg.suggestPrompt({
        title, location, text,
        internalList,
        keywords: (Array.isArray(keywords) && keywords.length ? keywords : [cfg.defaultKeyword]).join(', '),
      });
      if (facts && typeof facts === 'object' && Object.keys(facts).length) {
        promptText +=
`\n\nFacts already extracted from the event's own source documents (flyer, program, press release). Treat these as authoritative for names, dates and places:\n${JSON.stringify(facts).slice(0, 3000)}`;
      }
      content.push({ type: 'text', text: promptText });

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          // Roomy: the richer prompt overflows a small budget and comes back
          // truncated and unparseable.
          max_tokens: 8000,
          messages: [{ role: 'user', content }],
        }),
      });
      const body = await r.json();
      if (!r.ok) {
        console.error(base, 'anthropic failed:', r.status, JSON.stringify(body).slice(0, 300));
        return res.status(502).json({ error: 'AI request failed' });
      }
      if (body.stop_reason === 'max_tokens') {
        console.error(base, 'anthropic response hit max_tokens — reply was truncated');
      }
      let textOut = (body.content || []).map(c => c.text || '').join('');
      textOut = textOut.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim();
      const first = textOut.indexOf('{');
      const last = textOut.lastIndexOf('}');
      let parsed;
      try {
        parsed = JSON.parse(textOut.slice(first, last + 1));
      } catch (parseErr) {
        console.error(base, 'suggest JSON parse failed (%s), stop_reason=%s, chars=%d',
          parseErr.message, body.stop_reason, textOut.length);
        return res.status(502).json({ error: 'the AI reply was cut short — try again' });
      }
      res.json(parsed);
    } catch (err) {
      console.error(base, 'suggest failed:', err.message);
      res.status(500).json({ error: 'suggestions failed' });
    }
  });

  /* Draft the opening paragraph from source material — a flyer, program, press
     release or email, as PDF or images. Separate from the post photos: this is
     the who/what/when/where/why the writer would otherwise have to type. */

  /* Write the body copy of the post from raw notes — a questionnaire, an email,
     scribbled details. Separate from /intro, which drafts only an opening. */
  app.post(base + '/words', requireKey, async (req, res) => {
    try {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI not configured' });
      if (!cfg.wordsPrompt) return res.status(501).json({ error: 'not available for this site' });
      const { notes, docs, title, location, keywords } = req.body || {};
      const raw = typeof notes === 'string' ? notes.trim().slice(0, 12000) : '';
      const list = Array.isArray(docs) ? docs.slice(0, 6) : [];
      if (!raw && !list.length) return res.status(400).json({ error: 'nothing to work from' });

      const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
      const content = [];
      for (const [i, d] of list.entries()) {
        if (!d || !allowed.has(d.mediaType) || !d.dataBase64) continue;
        content.push({ type: 'text', text: `Source document ${i + 1} (${d.name || d.mediaType}):` });
        if (d.mediaType === 'application/pdf') {
          content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.dataBase64 } });
        } else {
          content.push({ type: 'image', source: { type: 'base64', media_type: d.mediaType, data: d.dataBase64 } });
        }
      }
      if (raw) content.push({ type: 'text', text: `Notes about the session:\n\n${raw}` });
      content.push({
        type: 'text',
        text: cfg.wordsPrompt({
          title, location,
          keywords: (Array.isArray(keywords) && keywords.length ? keywords : [cfg.defaultKeyword]).join(', '),
        }),
      });

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 2000, messages: [{ role: 'user', content }] }),
      });
      const body = await r.json();
      if (!r.ok) {
        console.error(base, 'words anthropic failed:', r.status, JSON.stringify(body).slice(0, 300));
        return res.status(502).json({ error: 'AI request failed' });
      }
      let out = (body.content || []).map(c => c.text || '').join('');
      out = out.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim();
      const a = out.indexOf('{'), b = out.lastIndexOf('}');
      let parsed;
      try { parsed = JSON.parse(out.slice(a, b + 1)); }
      catch (e) {
        console.error(base, 'words parse failed:', e.message, 'stop_reason=', body.stop_reason);
        return res.status(502).json({ error: 'the AI reply was cut short — try again' });
      }
      res.json({
        words: String(parsed.words || '').trim(),
        suggestedTitle: String(parsed.suggestedTitle || '').trim(),
        suggestedLocation: String(parsed.suggestedLocation || '').trim(),
        unsure: Array.isArray(parsed.unsure) ? parsed.unsure : [],
      });
    } catch (err) {
      console.error(base, 'words failed:', err.message);
      res.status(500).json({ error: 'writing failed' });
    }
  });

  app.post(base + '/intro', requireKey, async (req, res) => {
    try {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI not configured' });
      const { docs, notes, title, location, text, keywords } = req.body || {};
      const list = Array.isArray(docs) ? docs.slice(0, 6) : [];
      // Source material can be documents, pasted notes, or both — sometimes
      // there's no flyer at all, just what someone typed in an email.
      const raw = typeof notes === 'string' ? notes.trim().slice(0, 12000) : '';
      if (!list.length && !raw) return res.status(400).json({ error: 'no source material' });
      const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
      let bytes = 0;
      const content = [];
      for (const [i, d] of list.entries()) {
        if (!d || !allowed.has(d.mediaType) || !d.dataBase64) continue;
        bytes += d.dataBase64.length * 0.75;
        content.push({ type: 'text', text: `Source document ${i + 1} (${d.name || d.mediaType}):` });
        if (d.mediaType === 'application/pdf') {
          content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.dataBase64 } });
        } else {
          content.push({ type: 'image', source: { type: 'base64', media_type: d.mediaType, data: d.dataBase64 } });
        }
      }
      if (raw) {
        content.push({ type: 'text', text: `Source notes (pasted in — treat these as the raw facts):\n\n${raw}` });
      }
      if (!content.length) return res.status(400).json({ error: 'no usable source material' });
      if (bytes > 24_000_000) return res.status(413).json({ error: 'source documents too large — keep it under ~20 MB total' });
      content.push({
        type: 'text',
        text: cfg.introPrompt({
          title, location,
          text: (text || '').slice(0, 4000),
          keywords: (Array.isArray(keywords) && keywords.length ? keywords : [cfg.defaultKeyword]).join(', '),
        }),
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
        console.error(base, 'intro anthropic failed:', r.status, JSON.stringify(body).slice(0, 300));
        return res.status(502).json({ error: 'AI request failed' });
      }
      let out = (body.content || []).map(c => c.text || '').join('');
      out = out.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim();
      const a = out.indexOf('{'), b = out.lastIndexOf('}');
      let parsed;
      try { parsed = JSON.parse(out.slice(a, b + 1)); }
      catch (e) {
        console.error(base, 'intro parse failed:', e.message, 'stop_reason=', body.stop_reason);
        return res.status(502).json({ error: 'the AI reply was cut short — try again' });
      }
      res.json({
        intro: String(parsed.intro || '').trim(),
        facts: parsed.facts && typeof parsed.facts === 'object' ? parsed.facts : {},
        suggestedTitle: parsed.suggestedTitle || '',
        suggestedLocation: parsed.suggestedLocation || '',
        unsure: Array.isArray(parsed.unsure) ? parsed.unsure : [],
      });
    } catch (err) {
      console.error(base, 'intro failed:', err.message);
      res.status(500).json({ error: 'intro failed' });
    }
  });

  /* Alt text + filenames for a batch of photos. Kept separate from /suggest so a
     post with 30+ photos works: the frontend sends them in small batches instead
     of one giant request that would overflow the reply limit. */
  app.post(base + '/alt', requireKey, async (req, res) => {
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
        text: cfg.altPrompt({
          title, location, count: list.length,
          keywords: (Array.isArray(keywords) && keywords.length ? keywords : [cfg.defaultKeyword]).join(', '),
        }),
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
        console.error(base, 'alt anthropic failed:', r.status, JSON.stringify(body).slice(0, 300));
        return res.status(502).json({ error: 'AI request failed' });
      }
      let out = (body.content || []).map(c => c.text || '').join('');
      out = out.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim();
      const a = out.indexOf('{'), b = out.lastIndexOf('}');
      let parsed;
      try { parsed = JSON.parse(out.slice(a, b + 1)); }
      catch (e) {
        console.error(base, 'alt parse failed:', e.message, 'stop_reason=', body.stop_reason);
        return res.status(502).json({ error: 'the AI reply was cut short — try again' });
      }
      res.json({
        altTexts: parsed.altTexts || [],
        imageFilenames: parsed.imageFilenames || [],
        startIndex: startIndex || 0,
      });
    } catch (err) {
      console.error(base, 'alt failed:', err.message);
      res.status(500).json({ error: 'alt text failed' });
    }
  });

  /* Look at a batch of photos and report what is in them, so the layout can
     follow the house rules (most people first, silhouettes last, whole-group
     shots on their own). */
  app.post(base + '/analyze', requireKey, async (req, res) => {
    try {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI not configured' });
      const { thumbs } = req.body || {};
      const list = Array.isArray(thumbs) ? thumbs.slice(0, 8) : [];
      if (!list.length) return res.json({ photos: [] });

      const content = [];
      list.forEach((t, i) => {
        content.push({ type: 'text', text: `Photo ${i + 1}:` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: t.dataBase64 } });
      });
      content.push({
        type: 'text',
        text:
`Look carefully at each of these ${list.length} photos and report what is in them.

For EACH photo, in order, return an object with:
"people": how many people are visible (a number; 0 if none)
"fullGroup": true only if this looks like the WHOLE group together in one frame — everyone the post is about, posed or moving together. A photo of one or two members of a larger group is false.
"silhouette": true if the subjects are backlit and read as dark shapes against a bright sky or water — a true silhouette, not merely a moody or backlit photo
"closeup": true if it is a tight portrait or detail (hands, feet, rings, a face filling the frame)
"candid": true if it is an unposed moment — laughing, running, playing, mid-motion
"subjects": very short phrase for who is in it, e.g. "whole family", "mom and baby", "the two brothers"
"description": one short sentence describing what is happening

Return ONLY JSON, no markdown fences:
{"photos":[{"people":0,"fullGroup":false,"silhouette":false,"closeup":false,"candid":false,"subjects":"","description":""}]}
The array must have exactly ${list.length} entries, in the same order as the photos.`,
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
        console.error(base, 'analyze anthropic failed:', r.status, JSON.stringify(body).slice(0, 300));
        return res.status(502).json({ error: 'AI request failed' });
      }
      let out = (body.content || []).map(c => c.text || '').join('');
      out = out.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim();
      const a = out.indexOf('{'), b = out.lastIndexOf('}');
      let parsed;
      try { parsed = JSON.parse(out.slice(a, b + 1)); }
      catch (e) {
        console.error(base, 'analyze parse failed:', e.message, 'stop_reason=', body.stop_reason);
        return res.status(502).json({ error: 'the AI reply was cut short — try again' });
      }
      res.json({ photos: parsed.photos || [] });
    } catch (err) {
      console.error(base, 'analyze failed:', err.message);
      res.status(500).json({ error: 'photo analysis failed' });
    }
  });

  /* Read the post text against what we know about each photo and work out which
     photos the words are pointing at ("our favourite shot", "the funny moment"). */
  app.post(base + '/moments', requireKey, async (req, res) => {
    try {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI not configured' });
      const { paragraphs, photos } = req.body || {};
      const paras = Array.isArray(paragraphs) ? paragraphs : [];
      const pics = Array.isArray(photos) ? photos : [];
      if (!paras.length || !pics.length) return res.json({ questions: [] });

      const picList = pics.map((p, i) =>
        `${i}: ${p.subjects || '?'} — ${p.description || ''}${p.silhouette ? ' [silhouette]' : ''}${p.fullGroup ? ' [whole group]' : ''} (${p.people} people, ${p.vertical ? 'vertical' : 'horizontal'})`
      ).join('\n');
      const paraList = paras.map((t, i) => `${i}: ${t}`).join('\n\n');

      const prompt =
`A blog post is being laid out. Below are the paragraphs that were written, and a list of the photos with what is in each one.

PARAGRAPHS:
${paraList.slice(0, 6000)}

PHOTOS:
${picList.slice(0, 6000)}

Find the places where the writing points at a SPECIFIC photo — a favourite shot, a funny moment, something that happened ("when he grabbed her nose", "my favourite frame of the day", "right as the sun dropped"). For each one, we want to place that photo next to those words.

Return ONLY JSON, no fences:
{"questions":[{"paragraph":0,"quote":"the exact words from the paragraph, copied verbatim","ask":"a short friendly question for the person laying out the post","candidates":[2,5,7]}]}

Rules:
- "quote" MUST be copied word for word from the paragraph it belongs to.
- "candidates" are photo numbers from the list above that plausibly match, best first, at most 5.
- Only include a moment if the words really do point at one particular photo. If the writing is general, return an empty list.
- At most 4 questions. Prefer the clearest ones.`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
      });
      const body = await r.json();
      if (!r.ok) {
        console.error(base, 'moments anthropic failed:', r.status, JSON.stringify(body).slice(0, 300));
        return res.status(502).json({ error: 'AI request failed' });
      }
      let out = (body.content || []).map(c => c.text || '').join('');
      out = out.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim();
      const a = out.indexOf('{'), b = out.lastIndexOf('}');
      let parsed;
      try { parsed = JSON.parse(out.slice(a, b + 1)); }
      catch (e) {
        console.error(base, 'moments parse failed:', e.message);
        return res.json({ questions: [] });
      }
      res.json({ questions: parsed.questions || [] });
    } catch (err) {
      console.error(base, 'moments failed:', err.message);
      res.status(500).json({ error: 'moment matching failed' });
    }
  });
}

/* ------------------------------------------------- Amy Gray Photography ---- */
mountBlogRoutes(app, {
  base: '/api/blog',
  header: 'x-agp-key',
  defaultUrl: 'https://amygrayphotography.com',
  defaultTimezone: 'America/Los_Angeles',
  defaultKeyword: 'san diego family photographer',
  env: { key: 'BLOG_APP_KEY', url: 'WP_URL', user: 'WP_USER', pass: 'WP_APP_PASSWORD' },
  suggestPrompt: ({ title, location, text, internalList, keywords }) =>
`You are the SEO assistant for Amy Gray Photography, a family/beach photographer in San Diego (amygrayphotography.com). A blog post is being prepared.

Working title: ${title || '(none yet)'}
Location: ${location || '(unknown)'}
Post text:
${(text || '(no text yet)').slice(0, 6000)}

Existing pages and posts on the site (for internal links — use ONLY these URLs):
${internalList.slice(0, 8000)}

Keywords Amy is actively trying to rank for. Work the relevant ones in naturally —
never stuff them, and never use one that doesn't genuinely fit this session:
${keywords}

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
  wordsPrompt: ({ title, location, keywords }) =>
`Write the blog copy for a session at Amy Gray Photography, a family and beach photographer in San Diego. Everything above — a client questionnaire, an email, or Amy's own notes — is the source material.

Working title: ${title || '(none yet)'}
Location: ${location || '(unknown)'}
Keywords Amy would like to rank for, used ONLY where one fits naturally: ${keywords}

Write it in Amy's voice. This matters more than anything else:
- Conversational and warm, never gushy. Say what happened and let the reader feel it; don't tell them how to feel.
- Dry humour and parenthetical asides are welcome — "(every family has one)".
- Specific details beat adjectives. Not "a beautiful evening" — the sand, the wind, what the kids actually did.
- Vary the sentence length. Some long with dashes and commas, some short. Never choppy all the way through.
- Let the client's own words carry the weight. Quote the questionnaire directly where it's good; those lines are usually the best part.
- Never brag about Amy, her skill with kids, or her availability. Never mention session length or pricing.
- No AI tells. Never "not just X, but Y", "a testament to", "nestled", "tapestry", "journey".

Shape: 3 to 5 short paragraphs, about 250 words total.
1. How the session came about (a sentence or two)
2. The family — who they are, their personalities, what made them memorable. This is the longest part.
3. What they hoped to capture, and/or their favourite photo — in their words where you have them
4. A short closer — their trip, or a simple closing thought

Use ONLY facts that appear in the source material. Never invent a name, an age, a date or a place. If something is missing, write around it rather than guess, and say so in "unsure".
Separate paragraphs with a blank line. No headings, no titles inside the copy, no call to action, no HTML.

Return ONLY JSON, no markdown fences:
{"words": "the paragraphs, separated by blank lines", "suggestedTitle": "Location Type Photos | Emotional Hook", "suggestedLocation": "where the session happened", "unsure": ["anything you had to leave out or guess at"]}`,
  introPrompt: ({ title, location, text, keywords }) =>
`You are writing for Amy Gray Photography, a family/beach photographer in San Diego (amygrayphotography.com). The documents above are source material for a blog post — typically a client questionnaire, an email, or notes about the session.

Working title: ${title || '(none yet)'}
Location: ${location || '(unknown)'}
Any words already written for the post:
${text || '(none yet)'}
Keywords Amy is trying to rank for (use one only where it fits naturally): ${keywords}

Write the OPENING paragraph of the blog post — 3 to 5 sentences, warm and first-person in Amy's voice, covering who the family is, where and when the session happened, and what made it special. Use only facts that appear in the documents; never invent names, dates or places. If something important is missing, leave it out rather than guess.

Return ONLY a JSON object, no markdown fences:
{"intro": "...", "facts": {"who": "...", "what": "...", "when": "...", "where": "...", "why": "...", "how": "..."}, "suggestedTitle": "...", "suggestedLocation": "...", "unsure": ["anything you could not read or were not sure about"]}
Leave a facts field as an empty string if the documents do not say.`,
  altPrompt: ({ title, location, keywords, count }) =>
`These are photos from a blog post for Amy Gray Photography, a San Diego family photographer.

Post title: ${title || '(untitled)'}
Location: ${location || '(unknown)'}
Keywords Amy wants to rank for: ${keywords}

For EACH of the ${count} photos, in order, write:
- alt text: describe what is actually happening in that specific photo (who, what, where) in at most 14 words. Every one must be different from the others — never repeat a generic line. Mention the location naturally in some of them. Work a keyword in ONLY where it honestly describes the picture.
- a filename: kebab-case, descriptive, includes the location, no extension.

Return ONLY JSON, no markdown fences:
{"altTexts":["...", ...], "imageFilenames":["...", ...]}
Both arrays must have exactly ${count} entries, in the same order as the photos.`,
});

/* --------------------------------- Christian Unified Schools of San Diego --- */
mountBlogRoutes(app, {
  base: '/api/cu/blog',
  header: 'x-cu-key',
  defaultUrl: 'https://christianunified.org',
  defaultTimezone: 'America/Los_Angeles',
  defaultKeyword: 'Christian school San Diego',
  env: { key: 'CU_BLOG_APP_KEY', url: 'CU_WP_URL' },
  bridge: { secretEnv: 'CU_BRIDGE_SECRET' },
  suggestPrompt: ({ title, location, text, internalList, keywords }) =>
`You are the SEO assistant for Christian Unified Schools of San Diego (christianunified.org), a private Christian school district in El Cajon and Chula Vista, California. Its campuses are Christian High School, Christian Junior High, Christian Elementary East and West, and Christian South in Chula Vista. The mascot is the Patriots. A blog post about school life is being prepared — an event, a performance, a game, a chapel, a celebration.

Working title: ${title || '(none yet)'}
Campus / place: ${location || '(unknown)'}
Post text:
${(text || '(no text yet)').slice(0, 6000)}

Existing pages and posts on the site (for internal links — use ONLY these URLs):
${internalList.slice(0, 8000)}

Keywords the school is trying to rank for, mostly aimed at parents searching for a
school. Work the relevant ones in naturally — never stuff them, and never use one
that doesn't genuinely fit this story:
${keywords}

Write in the school's voice: warm, celebratory, community-minded, plainly Christian
without being preachy. Name the campus and the school year where it helps. Never
invent student or staff names, scores, or details that are not in the post text.

Return ONLY a JSON object, no markdown fences, with keys:
"titleOptions": 3 SEO title options in the school's house style — an emotional hook, a colon, then the event and year (e.g. "Celebrating 60 Years: Homecoming 2025", "Honoring Our Heroes: Veterans Day Celebration 2025")
"slug": url slug for the best title
"metaDescription": max 155 chars, warm, names the campus/event and works in the most relevant target keyword
"excerpt": 1-2 sentence excerpt
"focusKeyword": short focus keyphrase — pick from the keyword list above when one fits
"secondaryKeywords": 2-4 more from the list that this post can realistically support
"inlineLinks": THE MOST IMPORTANT FIELD. Links to weave into the body text itself.
   3-6 items {"phrase","url","title","kind","why"} where:
     - "phrase" MUST be a short word-for-word quote (2-6 words) copied EXACTLY from the post text above, including its exact capitalisation. Never invent a phrase that is not in the text. Pick natural anchor text (a campus name, a program, a team, a phrase like "the spring musical").
     - "url" is either one of the school's URLs listed above (kind: "internal") — prefer admissions, tours, athletics, arts, campus and program pages — or an official outside site for a place or organisation actually named in the text, e.g. a venue, a league, a mission partner (kind: "external"). Only well-known official URLs.
     - Prefer a mix: at least one internal and at least one external when the text supports it.
     - Each phrase must be distinct and appear only once in your list.
"internalLinks": 2-4 items {"title","url","why"} for the "keep exploring" list at the end (do not duplicate inlineLinks). Favour pages a prospective parent would want next: tours, admissions, the relevant campus, athletics or arts.
"externalLinks": 1-2 items {"title","url","why"} — official pages for places or organisations named in the post, for the end list
"categoryHints": array of likely category names, chosen from the site's real categories (e.g. Blog, Chapel, Arts, Athletics)`,
  introPrompt: ({ title, location, text, keywords }) =>
`You are writing for Christian Unified Schools of San Diego (christianunified.org), a private Christian school district in El Cajon and Chula Vista, California — campuses are Christian High School, Christian Junior High, Christian Elementary East and West, and Christian South; the mascot is the Patriots. The documents above are source material for a blog post about a school event: a flyer, a program, a press release, an email, or notes.

Working title: ${title || '(none yet)'}
Campus / place: ${location || '(unknown)'}
Any words already written for the post:
${text || '(none yet)'}
Keywords the school is trying to rank for (use one only where it fits naturally): ${keywords}

Write the OPENING paragraph of the blog post — 3 to 5 sentences, warm, celebratory and community-minded, in the school's voice. Cover the what, when, where, who and why: what the event was, when and where it happened (name the campus), who was involved (grades, teams, groups — never guess an individual's name), and why it mattered. Use only facts that appear in the documents; never invent names, dates, scores or places. If something important is missing, leave it out rather than guess. Plainly Christian where the source is, never preachy.

Return ONLY a JSON object, no markdown fences:
{"intro": "...", "facts": {"who": "...", "what": "...", "when": "...", "where": "...", "why": "...", "how": "..."}, "suggestedTitle": "an SEO title in the school's style — emotional hook, colon, event and year", "suggestedLocation": "campus or venue as it should appear in the post", "unsure": ["anything you could not read or were not sure about"]}
Leave a facts field as an empty string if the documents do not say.`,
  altPrompt: ({ title, location, keywords, count }) =>
`These are photos from a blog post for Christian Unified Schools of San Diego, a private Christian school district in El Cajon and Chula Vista, California. The mascot is the Patriots.

Post title: ${title || '(untitled)'}
Campus / place: ${location || '(unknown)'}
Keywords the school wants to rank for: ${keywords}

For EACH of the ${count} photos, in order, write:
- alt text: describe what is actually happening in that specific photo (who, what, where) in at most 14 words. Every one must be different from the others — never repeat a generic line. Mention the campus or event naturally in some of them. Work a keyword in ONLY where it honestly describes the picture. Never guess a student's or staff member's name — say "a student", "students", "the team", "a teacher".
- a filename: kebab-case, descriptive, includes the campus or event, no extension.

Return ONLY JSON, no markdown fences:
{"altTexts":["...", ...], "imageFilenames":["...", ...]}
Both arrays must have exactly ${count} entries, in the same order as the photos.`,
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('agp-wallart-backend listening on ' + port));
