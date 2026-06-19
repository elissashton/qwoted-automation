const puppeteer = require('puppeteer-core');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');


const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const SPREADSHEET_ID = '1h9ufUOVwhsCaOWQlM_pYBqTp5T65qRa7p3VLj7g89Lg';
const SEEN_FILE = path.join(__dirname, 'seen.json');

function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

function hasSeen(seen, accountEmail, id) {
  return seen[accountEmail]?.includes(id) || false;
}

function markSeen(seen, accountEmail, id) {
  if (!seen[accountEmail]) seen[accountEmail] = [];
  if (!seen[accountEmail].includes(id)) seen[accountEmail].push(id);
}

async function sendSlack(blocks) {
  const res = await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks })
  });
  if (!res.ok) console.error('Slack error:', res.status);
}

async function sendPitchNotification({ account, requestTitle, requestUrl, pitcherName, pitcherRole, pitchText, timestamp }) {
  await sendSlack([
    { type: 'header', text: { type: 'plain_text', text: 'New pitch reply', emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `*${account.publication}* · ${account.name}` }] },
    { type: 'section', text: { type: 'mrkdwn', text: `*<${requestUrl}|${requestTitle}>*` } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*From:*\n${pitcherName}` },
      { type: 'mrkdwn', text: `*Role:*\n${pitcherRole || 'N/A'}` }
    ]},
    { type: 'section', text: { type: 'mrkdwn', text: pitchText.substring(0, 500) + (pitchText.length > 500 ? '...' : '') } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: timestamp || '' }] },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'View Pitches', emoji: true }, url: requestUrl, style: 'primary' }] }
  ]);
}

async function sendInboxNotification({ account, senderName, senderCompany, subject, preview, conversationUrl }) {
  await sendSlack([
    { type: 'header', text: { type: 'plain_text', text: 'New inbox message', emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `*${account.publication}* · ${account.name}` }] },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*From:*\n${senderName}` },
      { type: 'mrkdwn', text: `*Company:*\n${senderCompany || 'N/A'}` }
    ]},
    { type: 'section', text: { type: 'mrkdwn', text: `*${subject}*\n${preview}` } },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'View Message', emoji: true }, url: conversationUrl, style: 'primary' }] }
  ]);
}

async function getAccounts() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetNames = meta.data.sheets.map(s => s.properties.title);
  const accounts = [];

  for (const sheetName of sheetNames) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A:E` });
    const rows = res.data.values || [];
    if (rows.length < 2) continue;
    const headers = rows[0].map(h => h.toLowerCase().trim());
    const nameIdx = headers.findIndex(h => h === 'name');
    const userIdx = headers.findIndex(h => h.includes('username'));
    const passIdx = headers.findIndex(h => h.includes('password'));

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const username = row[userIdx]?.trim();
      const password = row[passIdx]?.trim();
      const name = row[nameIdx]?.trim();
      if (!username || !password || !name) continue;
      const slug = username.split('@')[0].replace(/\+/g, '-').replace(/\./g, '-').toLowerCase();
      accounts.push({ name, username, password, publication: sheetName, slug });
    }
  }
  return accounts;
}

async function login(page, username, password) {
  await page.goto('https://app.qwoted.com/users/sign_in', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('input[name="user[email]"]', { timeout: 10000 });
  await page.type('input[name="user[email]"]', username, { delay: 50 });
  await page.type('input[name="user[password]"]', password, { delay: 50 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
    page.click('input[type="submit"], button[type="submit"]')
  ]);
  if (page.url().includes('sign_in')) throw new Error('Login failed for ' + username);
  console.log('Logged in: ' + username);
}

async function logout(page) {
  try { await page.goto('https://app.qwoted.com/users/sign_out', { waitUntil: 'networkidle2', timeout: 15000 }); } catch {}
}

async function scrapeInbox(page, account, seen) {
  const newMessages = [];
  try {
    await page.goto('https://app.qwoted.com/my_inbox_v2', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const messages = await page.evaluate(() => {
      const items = [];
      // Each conversation is a div with role="button" and data-conversation-id
      document.querySelectorAll('[role="button"][data-conversation-id]').forEach(el => {
        const conversationId = el.dataset.conversationId;
        if (!conversationId) return;

        const inner = el.querySelector('.d-flex.flex-column');
        if (!inner) return;

        // Sender name — first bold/strong or first line
        const nameEl = inner.querySelector('span, strong, b, [class*="fw-"]');
        const senderName = nameEl?.innerText?.trim() || '';

        // Company — second line often
        const lines = inner.querySelectorAll('div, p, span');
        let senderCompany = '';
        lines.forEach(l => {
          const t = l.innerText?.trim();
          if (t && t !== senderName && t.length > 2 && t.length < 60 && !t.includes('Re:') && !senderCompany) {
            senderCompany = t;
          }
        });

        // Subject and preview
        const allText = inner.innerText?.trim() || '';
        const textLines = allText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const subject = textLines.find(l => l.startsWith('Re:') || l.startsWith('re:')) || textLines[1] || '';
        const preview = textLines[textLines.length - 1] || '';

        items.push({ conversationId, senderName, senderCompany, subject, preview });
      });
      return items;
    });

    console.log(account.name + ' inbox: ' + messages.length + ' conversations');

    for (const msg of messages) {
      const seenKey = 'inbox-' + msg.conversationId;
      if (hasSeen(seen, account.username, seenKey)) continue;
      markSeen(seen, account.username, seenKey);

      newMessages.push(msg);
    }
  } catch (err) {
    console.error('Inbox scrape failed for ' + account.username + ': ' + err.message);
  }
  return newMessages;
}

async function getOpenRequests(page, slug) {
  const url = 'https://app.qwoted.com/users/' + slug + '/reporter_requests';
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  return await page.evaluate(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const requests = [];
    const seen = new Set();

    document.querySelectorAll('table.table-hover tbody tr.align-middle').forEach(row => {
      const link = row.querySelector('td:first-child a');
      if (!link) return;
      const href = link.href;
      const id = href.split('/').filter(Boolean).pop();
      if (!id || seen.has(id)) return;
      seen.add(id);

      const deadlineCell = row.querySelector('td.d-none.d-sm-table-cell');
      const deadlineText = deadlineCell?.innerText?.trim();
      let deadlinePassed = false;
      if (deadlineText) {
        const d = new Date(deadlineText);
        if (!isNaN(d) && d < today) deadlinePassed = true;
      }

      const progressText = row.innerText || '';
      if (progressText.toLowerCase().includes('complete')) deadlinePassed = true;

      if (!deadlinePassed) requests.push({ href, id, title: link.innerText.trim() });
    });

    return requests;
  });
}

async function getPitchReplies(page, request) {
  await page.goto(request.href, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  return await page.evaluate(() => {
    const pitches = [];
    document.querySelectorAll('[id^="pitch-"][id$="-simple-format-and-truncate"]').forEach(el => {
      const match = el.id.match(/pitch-(\d+)-/);
      if (!match) return;
      const pitchId = match[1];

      const card = el.closest('.d-flex.flex-row') || el.parentElement?.parentElement;
      const nameEl = card?.querySelector('a[href*="/users/"]');
      const pitcherName = nameEl?.innerText?.trim() || 'Unknown';
      const roleEl = nameEl?.closest('div')?.nextElementSibling;
      const pitcherRole = roleEl?.innerText?.trim() || '';
      const timeEl = card?.querySelector('[class*="text-end"], .text-end');
      const timestamp = timeEl?.innerText?.trim() || '';

      const textEls = el.querySelectorAll('p');
      const pitchText = Array.from(textEls).map(p => p.innerText.trim()).filter(t => t.length > 0).join('\n');

      if (pitchId && pitchText) pitches.push({ pitchId, pitcherName, pitcherRole, pitchText, timestamp });
    });
    return pitches;
  });
}

async function main() {
  console.log('Starting Qwoted scraper...');
  const seen = loadSeen();
  const accounts = await getAccounts();
  console.log('Found ' + accounts.length + ' accounts');

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/usr/bin/google-chrome-stable',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  let totalNew = 0;

  for (const account of accounts) {
    console.log('\nProcessing: ' + account.name + ' (' + account.publication + ')');
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    try {
      await login(page, account.username, account.password);

      // Check inbox
      const inboxMessages = await scrapeInbox(page, account, seen);
      for (const msg of inboxMessages) {
        await sendInboxNotification({
          account,
          senderName: msg.senderName,
          senderCompany: msg.senderCompany,
          subject: msg.subject,
          preview: msg.preview,
          conversationUrl: 'https://app.qwoted.com/my_inbox_v2?conversation=' + msg.conversationId
        });
        totalNew++;
        console.log('  New inbox message from ' + msg.senderName);
      }

      // Check pitch replies on open requests
      const requests = await getOpenRequests(page, account.slug);
      console.log(account.name + ': ' + requests.length + ' open requests');

      for (const request of requests) {
        try {
          const pitches = await getPitchReplies(page, request);
          console.log('  ' + request.title + ': ' + pitches.length + ' pitches');

          for (const pitch of pitches) {
            const seenKey = 'pitch-' + pitch.pitchId;
            if (hasSeen(seen, account.username, seenKey)) continue;
            markSeen(seen, account.username, seenKey);

            await sendPitchNotification({
              account,
              requestTitle: request.title,
              requestUrl: request.href,
              pitcherName: pitch.pitcherName,
              pitcherRole: pitch.pitcherRole,
              pitchText: pitch.pitchText,
              timestamp: pitch.timestamp
            });
            totalNew++;
            console.log('  New pitch from ' + pitch.pitcherName);
          }
        } catch (err) {
          console.error('  Failed to check ' + request.title + ': ' + err.message);
        }
      }

      await logout(page);
    } catch (err) {
      console.error('Error processing ' + account.name + ': ' + err.message);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  saveSeen(seen);

  if (totalNew === 0) {
    await sendSlack([{
      type: 'section',
      text: { type: 'mrkdwn', text: '✅ *All clear* — checked ' + accounts.length + ' accounts. No new pitch replies or inbox messages.' }
    }]);
  }

  console.log('\nDone. ' + totalNew + ' new items found.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
