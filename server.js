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
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
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

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('agp-wallart-backend listening on ' + port));
