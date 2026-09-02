/* AGP Wall Art backend — receives client designs and emails them to Amy.
   Deploy on DigitalOcean App Platform. Required environment variables:
     SMTP_USER  — the Gmail address that sends the mail (amy@amygray.net)
     SMTP_PASS  — a Google "app password" for that account (SECRET)
     MAIL_TO    — where designs land (defaults to amy@amygray.net)
     ALLOW_ORIGIN — comma-separated list of extra origins allowed to call this
                    API. The GitHub Pages origin is always allowed, so a typo
                    here can never take the photography or school apps down. */
'use strict';
const express = require('express');
const nodemailer = require('nodemailer');

const app = express();

/* Every app talking to this backend is a static site on someone else's host, so
   CORS has to name them one by one. The apps are not all in the same place any
   more — the photography and school builders sit on GitHub Pages, the Sitterwise
   one on Netlify — so this is a list rather than the single origin it used to
   be. GitHub Pages is hard-coded rather than defaulted, so setting ALLOW_ORIGIN
   for one app cannot knock the other two offline. */
const ALLOWED_ORIGINS = [...new Set([
  'https://amycothrangray.github.io',
  ...String(process.env.ALLOW_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean),
])];
app.use((req, res, next) => {
  const origin = req.get('Origin');
  // A browser rejects a list in this header — it has to be one exact value —
  // so echo back the caller's own origin when it is one we know.
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    res.set('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
  }
  // Without this a shared cache could hand one app another app's CORS headers.
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-AGP-Key, X-CU-Key, X-SW-Key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* After the CORS headers, deliberately. express.json() rejects a malformed or
   oversized body itself, and anything it answers before the CORS middleware has
   run carries no Access-Control headers — so the browser refuses to show the
   page the status and reports it as a bare network failure instead. */
app.use(express.json({ limit: '30mb' }));
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'those documents are too big to send' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'the request body was not valid JSON' });
  }
  return next(err);
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
      subject: (/SEVERE/.test(String(summary || '')) ? '[CHECK PRINT SIZE] ' : '')
        + `Wall art design — ${safeName}`,
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
     /api/sw/blog/*  Sitterwise             → https://amycothrangray.github.io/sitterwiseblogbuilder/

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

   Environment variables — Sitterwise:
     SW_BLOG_APP_KEY   — passphrase for the Sitterwise app (SECRET)
     SW_WP_URL         — https://sitterwise.com (this is the default)
     SW_BRIDGE_SECRET  — shared secret shown by the sitterwise-blog-bridge
                         plugin at Settings -> Sitterwise Blog Bridge (SECRET).
                         sitterwise.com runs Elementor, and the bridge is where
                         the Elementor-specific handling lives: clearing the
                         builder flag off the post, re-serving the blog CSS from
                         <head> when kses eats the inline <style>, and printing
                         the BlogPosting schema in <head>.

   Shared:
     ANTHROPIC_API_KEY — for AI suggestions (SECRET)
--------------------------------------------------------------------------- */


/* Pages worth linking a blog post to. A photography site accumulates a lot that
   readers should never be sent to — signed contracts, one-off client pages,
   half-finished page-builder drafts, account and form plumbing. Each site adds
   its own patterns via cfg.hidePages. */
const JUNK_PAGE = new RegExp([
  'contract', 'flexbox', 'sitemap', 'form-submitted', 'my-account', 'edit-request',
  'client-proofing', 'checkout', 'cart', 'no-model-release', 'package-customization',
  'thank-you', 'privacy', 'terms', 'test-page', 'draft',
].join('|'), 'i');

function linkablePages(pages, cfg) {
  const extra = cfg.hidePages instanceof RegExp ? cfg.hidePages : null;
  return pages.filter((p) => {
    let slug = '';
    try { slug = new URL(p.url).pathname.replace(/^\/|\/$/g, ''); } catch { slug = ''; }
    if (!slug) return false;                       // the home page isn't a useful in-post link
    if (JUNK_PAGE.test(slug) || JUNK_PAGE.test(p.title || '')) return false;
    if (extra && (extra.test(slug) || extra.test(p.title || ''))) return false;
    return true;
  });
}

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

  /* Each bridge plugin owns its own REST namespace and secret header; the
     defaults are Christian Unified's, which is the site the bridge was written
     for, so its config keeps working unchanged. */
  async function bridgeFetch(path, payload, method) {
    const ns = (cfg.bridge && cfg.bridge.namespace) || 'cu-blog/v1';
    const hdr = (cfg.bridge && cfg.bridge.header) || 'X-CU-Bridge-Secret';
    const r = await fetch(wpUrl() + '/wp-json/' + ns + path, {
      method: method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        [hdr]: process.env[cfg.bridge.secretEnv] || '',
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(payload) }),
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
      /* The bridge plugin knows things the public REST API doesn't: whether
         Elementor is active, which SEO plugin to write meta into, what sits in
         front of a post slug in the permalink, which page templates exist, and
         whether the posting user can save a raw <style> block. All of it has a
         safe default in the app, so a failed ping is not an error. */
      const ping = useBridge
        ? bridgeFetch('/ping', null, 'GET').then((r) => (r.ok ? r.body : null)).catch(() => null)
        : Promise.resolve(null);
      const [cats, posts, pages, root, info] = await Promise.all([
        wpFetch('/wp-json/wp/v2/categories?per_page=100&orderby=count&order=desc&_fields=id,name,count'),
        collect('/wp-json/wp/v2/posts?_fields=id,title,link,date', 1),
        collect(`/wp-json/wp/v2/pages?_fields=id,title,link${cfg.dropFormPages ? ',content' : ''}`, 4),
        wpFetch('/wp-json/'),
        ping,
      ]);
      // The site's own timezone drives scheduling: the app sends plain local
      // times and WordPress interprets them in this zone, so what the writer
      // picks is what readers see. Restored here — it was added for scheduled
      // posts and then dropped by a later refactor, which broke back-dating.
      const tz = (root.body && root.body.timezone_string) || cfg.defaultTimezone;
      const data = {
        categories: (cats.body || []).map(c => ({ id: c.id, name: c.name, count: c.count })),
        posts: posts.map(p => ({ title: p.title?.rendered || '', url: p.link, date: p.date })),
        pages: linkablePages(
          pages
            // A school site is mostly forms — permission slips, sign-ups,
            // absence reports. They're embedded from Cognito Forms, so the
            // embed in the page body is the reliable way to spot them; the
            // titles alone don't say ("Use Last Year's Photo" is a form).
            .filter((p) => !cfg.dropFormPages
              || !/cognitoforms/i.test(p.content?.rendered || ''))
            .map(p => ({ title: p.title?.rendered || '', url: p.link })),
          cfg),
        timezone: tz,
        siteTimeNow: new Date().toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T').slice(0, 16),
        ...(info ? { info } : {}),
      };
      siteCache = { at: Date.now(), data };
      res.json(data);
    } catch (err) {
      console.error(base, 'site fetch failed:', err.message);
      res.status(502).json({ error: 'could not reach the website' });
    }
  });

  /* Upload one resized photo to the WordPress media library. */

  /* Search the whole site for something to link to. The cached /site list only
     carries the most recent posts — amygrayphotography.com has ~800 — so an
     older session can only be found by asking WordPress directly. */
  app.get(base + '/search', requireKey, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 80);
      if (q.length < 2) return res.json({ results: [] });
      const enc = encodeURIComponent(q);
      // Posts only. Every page is already in the cached /site list and gets
      // filtered there; asking WordPress for pages as well drags in anything
      // that merely mentions the word in its body (Pricing, Contact…).
      const posts = await wpFetch(
        `/wp-json/wp/v2/posts?search=${enc}&per_page=25&orderby=relevance&_fields=title,link,date`);
      const results = (Array.isArray(posts.body) ? posts.body : [])
        .map((p) => ({ title: p.title?.rendered || '', url: p.link, date: p.date, kind: 'post' }))
        .filter((r) => r.url);
      res.json({ results });
    } catch (err) {
      console.error(base, 'search failed:', err.message);
      res.status(502).json({ error: 'search failed' });
    }
  });

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
              status, metaDesc, focusKeyword, date,
              jsonLd, blogCss, pageTemplate, clearElementor } = req.body || {};
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
          // Elementor and head-output extras. A bridge that predates them
          // ignores unknown keys, so the older CU plugin is unaffected.
          jsonLd: jsonLd || '', blogCss: blogCss || '',
          pageTemplate: pageTemplate || '', clearElementor: !!clearElementor,
        });
        if (!b.ok) {
          console.error(base, 'bridge publish failed:', b.status, JSON.stringify(b.body).slice(0, 300));
          return res.status(502).json({ error: 'WordPress rejected the post' });
        }
        siteCache = { at: 0, data: null };
        return res.json({
          id: b.body.id, link: b.body.link,
          status: b.body.status, date: b.body.date,
          yoastMetaApplied: !!b.body.yoastMetaApplied,
          seoPlugin: b.body.seoPlugin || '',
          styleMoved: !!b.body.styleMoved,
          elementorCleared: !!b.body.elementorCleared,
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
          const pages = await collect(
            `/wp-json/wp/v2/pages?_fields=title,link${cfg.dropFormPages ? ',content' : ''}`, 4);
          site = {
            posts: posts.map(p => ({ title: p.title?.rendered, url: p.link })),
            // Same filtering as /site — otherwise the AI happily offers to link
            // a story about a concert to a detention sign-up form.
            pages: linkablePages(
              pages
                .filter((p) => !cfg.dropFormPages || !/cognitoforms/i.test(p.content?.rendered || ''))
                .map(p => ({ title: p.title?.rendered, url: p.link })),
              cfg),
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

  /* Write a whole blog post to a fixed brand template. The photo-led sites
     (Amy Gray Photography, Christian Unified) start from a gallery and paste
     words in around it; a Sitterwise post is the other way round — a hero, a
     glance box, a few sections, a tip box and a CTA, all in a shape the brand
     never varies. So this returns the finished structure as blocks, and the
     app drops them straight into its editor. Only mounted where a site has a
     composePrompt. */
  app.post(base + '/compose', requireKey, async (req, res) => {
    try {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI not configured' });
      if (!cfg.composePrompt) return res.status(501).json({ error: 'not available for this site' });
      const { brief, docs, title, place, kind, kindLabel, angle, keywords, ranked } = req.body || {};
      const raw = typeof brief === 'string' ? brief.trim().slice(0, 12000) : '';
      const list = Array.isArray(docs) ? docs.slice(0, 6) : [];
      if (!raw && !list.length) return res.status(400).json({ error: 'nothing to work from' });

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
      if (bytes > 24_000_000) return res.status(413).json({ error: 'source documents too large — keep it under ~20 MB total' });
      if (raw) content.push({ type: 'text', text: `The brief:\n\n${raw}` });

      /* Ranks matter to the writing, not just the reporting: a term the site
         already holds at #1 does not want another post competing with it, and
         one sitting on page two or three is exactly what a post can move. */
      const rankLine = Array.isArray(ranked) && ranked.length
        ? ranked.map((r) => `${r.kw} (currently #${r.rank})`).join('; ')
        : '';
      content.push({
        type: 'text',
        text: cfg.composePrompt({
          title, place, kind, kindLabel, angle, rankLine,
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
        // A whole post plus the SEO fields overflows a small budget and comes
        // back truncated and unparseable.
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8000, messages: [{ role: 'user', content }] }),
      });
      const body = await r.json();
      if (!r.ok) {
        console.error(base, 'compose anthropic failed:', r.status, JSON.stringify(body).slice(0, 300));
        return res.status(502).json({ error: 'AI request failed' });
      }
      if (body.stop_reason === 'max_tokens') {
        console.error(base, 'compose response hit max_tokens — reply was truncated');
      }
      let out = (body.content || []).map((c) => c.text || '').join('');
      out = out.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim();
      const a = out.indexOf('{'), b = out.lastIndexOf('}');
      let parsed;
      try { parsed = JSON.parse(out.slice(a, b + 1)); }
      catch (e) {
        console.error(base, 'compose parse failed:', e.message, 'stop_reason=', body.stop_reason);
        return res.status(502).json({ error: 'the AI reply was cut short — try again' });
      }
      res.json({
        eyebrow: String(parsed.eyebrow || '').trim(),
        heroHeadline: String(parsed.heroHeadline || '').trim(),
        heroSub: String(parsed.heroSub || '').trim(),
        heroCaption: String(parsed.heroCaption || '').trim(),
        title: String(parsed.title || '').trim(),
        place: String(parsed.place || '').trim(),
        blocks: Array.isArray(parsed.blocks) ? parsed.blocks : [],
        cta: parsed.cta && typeof parsed.cta === 'object' ? parsed.cta : null,
        slug: String(parsed.slug || '').trim(),
        metaDescription: String(parsed.metaDescription || '').trim(),
        excerpt: String(parsed.excerpt || '').trim(),
        focusKeyword: String(parsed.focusKeyword || '').trim(),
        secondaryKeywords: Array.isArray(parsed.secondaryKeywords) ? parsed.secondaryKeywords : [],
        unsure: Array.isArray(parsed.unsure) ? parsed.unsure : [],
      });
    } catch (err) {
      console.error(base, 'compose failed:', err.message);
      res.status(500).json({ error: 'writing the post failed' });
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
  // One-off client pages and old experiments that shouldn't be offered as
  // links in a blog post. Add a slug here if one starts turning up.
  hidePages: /^(derm2?|harness|june|foothills|mixed-media-art|shop|presidio-park|coronado-proposal|coronado-avenida-del-sol|venturewell-headshots|session-questionnaire)$/i,
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
  dropFormPages: true,        // christianunified.org is ~75% Cognito Forms pages
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

/* ------------------------------------------------------------- Sitterwise ---
   sitterwise.com — vetted local caregivers for families travelling in San
   Diego, and for hotels and events. Unlike the other two sites this one is
   copy-led: every post follows the same brand template, so /compose returns a
   finished structure rather than a paragraph. */

/* House rules, repeated into every prompt because they are the difference
   between a Sitterwise post and a generic one. */
const SW_VOICE = `Voice — this matters more than anything else:
- Conversational and warm, never gushy. Say what is true and let it land; do not tell the reader how to feel.
- Specific details beat adjectives. "The sand actually sparkles" beats "a beautiful beach".
- Parenthetical asides and light dry humour are welcome.
- Vary the sentence length. Some long and flowing, some short. Never choppy all the way through.
- Always say "caregivers", never "sitters", for the people Sitterwise sends. ("Babysitter" is fine and is what parents search for — it is the bare word "sitter" that is off-brand.)
- No AI tells. Never "not just X, but Y", "nestled", "a testament to", "tapestry", "journey", "hidden gem", "vibrant", "bustling", "delve", "whether you're X or Y".
- The service tie-in belongs in the tip box and the CTA. The post has to be genuinely useful on its own — do not sell in every paragraph.
- Never invent a price, an opening time, a distance or a name. If the source does not say, write around it and list it under "unsure".`;

const SW_KEYWORD_RULE = `Keywords Sitterwise is trying to rank for. Work the relevant ones in naturally, never stuff them, and never use one that does not honestly fit this post:
{{KEYWORDS}}

Current Google positions, from this month's report: {{RANKS}}
Read those positions as strategy. A term already sitting in the top few is won — support it with an internal link rather than writing a post that competes with it. A term on page two or three is what a post like this can actually move, so prefer one of those as the focus keyword when the subject genuinely fits.`;

const swKeywordBlock = ({ keywords, rankLine }) => SW_KEYWORD_RULE
  .replace('{{KEYWORDS}}', keywords)
  .replace('{{RANKS}}', rankLine || '(none supplied)');

mountBlogRoutes(app, {
  base: '/api/sw/blog',
  header: 'x-sw-key',
  defaultUrl: 'https://sitterwise.com',
  defaultTimezone: 'America/Los_Angeles',
  defaultKeyword: 'hotel childcare',
  env: { key: 'SW_BLOG_APP_KEY', url: 'SW_WP_URL' },
  bridge: {
    secretEnv: 'SW_BRIDGE_SECRET',
    namespace: 'sw-blog/v1',
    header: 'X-SW-Bridge-Secret',
  },
  // Account plumbing the booking app owns; nobody wants a blog post linking here.
  hidePages: /^(login|signup|sign-up|register|account|dashboard|reset-password|apply|application|terms|privacy|cookie)/i,

  composePrompt: ({ title, place, kindLabel, angle, keywords, rankLine }) =>
`You are writing a blog post for Sitterwise (sitterwise.com), which connects families with experienced, vetted local caregivers in San Diego — at their hotel, their vacation rental, or an event. The readers are parents: mostly visiting families staying in a hotel or rental, plus locals, plus event and conference organisers.

Everything above is the source material — a brief, and possibly a property page, press kit or flyer. Use only what is actually in it.

Post type: ${kindLabel || 'San Diego Family Guide'} — ${angle || 'a guide for families in San Diego'}
Working title: ${title || '(none yet)'}
Place or subject: ${place || '(not given)'}

${SW_VOICE}

${swKeywordBlock({ keywords, rankLine })}

Shape — this is a fixed brand template, so follow it exactly:
- A navy hero: a short uppercase eyebrow, a Playfair headline, and one sentence underneath.
- A first paragraph or two that sets the scene.
- A "glance box" near the top: a teal callout with a short label, one lead line, and 3-5 bullets. The day, or the stay, at a glance.
- Three or four H2 sections with two or three paragraphs each. Sub-headings (H3) only where a section genuinely splits.
- Two image slots, spaced through the article, each with a short italic caption. Return them as blocks of type "image" with a caption; the photos get added in the app.
- A "tip box" near the end: a navy callout labelled "Parent Tip". This is the one place the service is woven in — a caregiver at the hotel or rental so the parents get a few hours to themselves. One short paragraph, warm, not a pitch.
- A closing paragraph after the tip box.
- A coral CTA strip at the very end.

About 600 words in the body, not counting the hero or the CTA.

Return ONLY a JSON object, no markdown fences:
{
  "eyebrow": "short uppercase-style label, e.g. San Diego Family Guide or Hotel Feature",
  "heroHeadline": "the big headline — short, concrete, no colon-subtitle padding",
  "heroSub": "one sentence under the headline",
  "heroCaption": "one short italic caption for the hero photo",
  "title": "the WordPress post title — can be longer and more searchable than the hero headline",
  "place": "the place or property this is about, as it should read in the post",
  "blocks": [
    {"type":"text","text":"a paragraph"},
    {"type":"glance","label":"The Quick Version","lead":"one line","items":["bullet","bullet","bullet"]},
    {"type":"heading","text":"an H2"},
    {"type":"sub","text":"an H3"},
    {"type":"list","intro":"optional line","items":["bullet"]},
    {"type":"image","caption":"short italic caption"},
    {"type":"tip","label":"Parent Tip","text":"one paragraph"}
  ],
  "cta": {"heading":"Playfair heading for the coral strip","text":"one line","button":"Book a Caregiver"},
  "slug": "url-slug",
  "metaDescription": "max 155 characters, includes the focus keyword",
  "excerpt": "1-2 sentences",
  "focusKeyword": "one phrase from the keyword list that this post can realistically win",
  "secondaryKeywords": ["2-4 more from the list this post honestly supports"],
  "unsure": ["anything the source did not say that you left out rather than guess"]
}
The blocks array must be in reading order and must contain exactly one "glance" block near the top and exactly one "tip" block near the end.`,

  introPrompt: ({ title, location, text, keywords }) =>
`You are writing for Sitterwise (sitterwise.com), which connects families with vetted local caregivers in San Diego — at their hotel, vacation rental or event. The documents above are source material for a blog post.

Working title: ${title || '(none yet)'}
Place or subject: ${location || '(unknown)'}
Any words already written:
${text || '(none yet)'}
Keywords to work in only where one fits naturally: ${keywords}

${SW_VOICE}

Write the OPENING paragraph — 3 to 5 sentences that set the scene: where this is, who it suits, and what the day or the stay is actually like. Use only facts from the documents.

Return ONLY a JSON object, no markdown fences:
{"intro": "...", "facts": {"who": "...", "what": "...", "when": "...", "where": "...", "why": "...", "how": "..."}, "suggestedTitle": "...", "suggestedLocation": "...", "unsure": ["anything you could not read or were not sure about"]}
Leave a facts field as an empty string if the documents do not say.`,

  suggestPrompt: ({ title, location, text, internalList, keywords }) =>
`You are the SEO assistant for Sitterwise (sitterwise.com), which connects families with experienced, vetted local caregivers in San Diego — at their hotel, vacation rental or event. A blog post is being prepared.

Working title: ${title || '(none yet)'}
Place or subject: ${location || '(unknown)'}
Post text:
${(text || '(no text yet)').slice(0, 6000)}

Existing pages and posts on the site (for internal links — use ONLY these URLs):
${internalList.slice(0, 8000)}

${swKeywordBlock({ keywords, rankLine: '' })}

Note on wording: "babysitter" and "babysitters" are search terms parents really type and are fine in a title or description. The bare word "sitter" is not — Sitterwise's people are always "caregivers".

Return ONLY a JSON object, no markdown fences, with keys:
"titleOptions": 3 title options. Sitterwise's house style is plain and searchable — the place or property, what the post is for, and who it is for. No colon-subtitle padding, no clickbait.
"slug": url slug for the best title
"metaDescription": max 155 chars, warm, names the place and works in the most relevant target keyword
"excerpt": 1-2 sentence excerpt
"focusKeyword": short focus keyphrase — pick from the keyword list above, favouring one the site does not already own outright
"secondaryKeywords": 2-4 more from the list that this post can realistically support
"inlineLinks": THE MOST IMPORTANT FIELD. Links to weave into the body text itself.
   3-6 items {"phrase","url","title","kind","why"} where:
     - "phrase" MUST be a short word-for-word quote (2-6 words) copied EXACTLY from the post text above, including its exact capitalisation. Never invent a phrase that is not in the text. Pick natural anchor text (a place name, an activity, a phrase like "hotel childcare").
     - "url" is either one of Sitterwise's URLs listed above (kind: "internal") — favour the booking page, hotel childcare, and how-it-works — or the official site of a venue, hotel or attraction actually named in the text (kind: "external"). Only well-known official URLs.
     - At least one internal and at least one external where the text supports it. Each phrase distinct, each appearing once.
"internalLinks": 2-4 items {"title","url","why"} for the "Keep exploring" list at the end (do not duplicate inlineLinks). Favour what a parent wants next: booking, hotel childcare, rates, how it works.
"externalLinks": 1-2 items {"title","url","why"} — official pages for the hotels, parks or attractions named in the post
"categoryHints": array of likely category names, chosen from the site's real categories`,

  altPrompt: ({ title, location, keywords, count }) =>
`These are photos from a blog post for Sitterwise, which connects families with vetted local caregivers in San Diego — at their hotel, vacation rental or event.

Post title: ${title || '(untitled)'}
Place or subject: ${location || '(unknown)'}
Keywords Sitterwise wants to rank for: ${keywords}

For EACH of the ${count} photos, in order, write:
- alt text: describe what is actually in that specific photo (who, what, where) in at most 14 words. Every one must be different — never repeat a generic line. Mention the place naturally in some of them. Work a keyword in ONLY where it honestly describes the picture. Never guess a child's or a caregiver's name — say "a child", "two kids", "a caregiver".
- a filename: kebab-case, descriptive, includes the place, no extension.

Return ONLY JSON, no markdown fences:
{"altTexts":["...", ...], "imageFilenames":["...", ...]}
Both arrays must have exactly ${count} entries, in the same order as the photos.`,
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('agp-wallart-backend listening on ' + port));
