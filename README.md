# AGP Wall Art — backend

Receives designs from the [mock-up app](https://github.com/amycothrangray/agp-wallart-mockup)
and emails each one to Amy with the `.wallart.json` attached (reply-to set to
the client). No database needed — the inbox is the archive.

## Deploy (DigitalOcean App Platform, ~$5/mo)

1. Push this folder to its own GitHub repo (`agp-wallart-backend`).
2. DigitalOcean → Apps → Create App → connect that repo, branch `main`.
   Autodetects Node; run command `node server.js`; smallest instance is fine.
3. Set environment variables:
   - `SMTP_USER` = amy@amygray.net
   - `SMTP_PASS` = a Google **app password** (Google Account → Security →
     2-Step Verification → App passwords) — mark **Encrypt** in DO
   - `MAIL_TO` = amy@amygray.net (optional, this is the default)
4. Deploy, note the app URL, and check `https://<app-url>/api/health` says ok.
5. In the mock-up app's `app.js`, set
   `SUBMIT_URL = 'https://<app-url>/api/submit'` and republish.

The client's browser POSTs `{design, summary, contact}` as JSON (up to 30MB);
CORS is locked to the GitHub Pages origin.
