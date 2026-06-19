const puppeteer = require('puppeteer-core');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SLACK_WEBHOOK = 'https://hooks.slack.com/services/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';
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

function markSeen(seen, accountEmail, id) {
  if (!seen[accountEmail]) seen[accountEmail] = [];
  if (!seen[accountEmail].includes(id)) seen[accountEmail].push(id);
}

function hasSeen(seen, accountEmail, id) {
  return seen[accountEmail]?.includes(id) || false;
}

async function sendSlack(blocks) {
  const res = await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks })
  });
  if (!res.ok) console.error('Slack error:', res.status);
}

async function sendReplyNotification(account, publication, requestTitle, replyFrom, replyText, requestUrl) {
  await sendSlack([
    { type: 'header', text: { type: 'plain_text', text: 'New pitch reply', emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `*${publication}* · ${account.name}` }] },
    { type: 'section', text: { type: 'mrkdwn', text: `*<${requestUrl}|${requestTitle}>*\n*From:* ${replyFrom}\n${replyText}` } },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'View Request', emoji: true }, url: requestUrl, style: 'primary' }] }
  ]);
}

async function getAccounts() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetNames = meta.data.sheets.map(s => s.properties.title);
  const accounts = [];

  for (const sheetName of sheetNames) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:E`
    });
    const rows = res.data.values || [];
    if (rows.length < 2) continue;
    const headers = rows[0].map(h => h.toLowerCase().trim());
    const nameIdx = headers.findIndex(h => h === 'name');
    const userIdx = headers.findIndex(h => h.includes('username'));
    const passIdx = headers.findIndex(h => h.includes('password'));
    const notesIdx = headers.findIndex(h => h.includes('notes'));

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const username = row[userIdx]?.trim();
      const password = row[passIdx]?.trim();
      const name = row[nameIdx]?.trim();
      if (!username || !password || !name) continue;
      const localPart = username.split('@')[0].replace(/\+/g, '-').replace(/\./g, '-').toLowerCase();
      accounts.push({ name, username, password, notes: row[notesIdx]?.trim() || '', publication: sheetName, slug: localPart });
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
  try {
    await page.goto('https://app.qwoted.com/users/sign_out', { waitUntil: 'networkidle2', timeout: 15000 });
  } catch {}
}

async function scrapeInbox(page, account, seen) {
  const newReplies = [];
  try {
    await page.goto('https://app.qwoted.com/my_inbox_v2', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const messages = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('[class*="inbox"], [class*="message"], [class*="pitch"]').forEach(card => {
        const link = card.querySelector('a[href*="/source_requests/"], a[href*="/pitches/"]');
        const text = card.innerText?.trim();
        const href = link?.href || '';
        const id = href.split('/').pop();
        if (id && text && text.length > 10) items.push({ id, href, text: text.substring(0, 500) });
      });
      return items;
    });

    for (const msg of messages) {
      if (!msg.id || hasSeen(seen, account.username, 'inbox-' + msg.id)) continue;
      markSeen(seen, account.username, 'inbox-' + msg.id);
      newReplies.push({ type: 'inbox', ...msg });
    }
  } catch (err) {
    console.error('Inbox scrape failed for ' + account.username + ': ' + err.message);
  }
  return newReplies;
}

async function scrapeReporterRequests(page, account, seen) {
  const newReplies = [];
  const url = 'https://app.qwoted.com/users/' + account.slug + '/reporter_requests';

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const requests = await page.evaluate(() => {
      const items = [];
      const today = new Date();
      const seen = new Set();
      document.querySelectorAll('a[href*="/source_requests/"]').forEach(a => {
        const href = a.href;
        const id = href.split('/').filter(Boolean).pop();
        if (!id || seen.has(id)) return;
        seen.add(id);
        const card = a.closest('li, article, [class*="card"], [class*="request"]') || a.parentElement;
        const text = card?.innerText || a.innerText || '';
        const deadlineMatch = text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
        let deadlinePassed = false;
        if (deadlineMatch) {
          const d = new Date(deadlineMatch[0]);
          if (!isNaN(d) && d < today) deadlinePassed = true;
        }
        if (!deadlinePassed) items.push({ href, id, title: text.substring(0, 200) });
      });
      return items;
    });

    console.log(account.name + ': ' + requests.length + ' open requests');

    for (const req of requests.slice(0, 20)) {
      try {
        await page.goto(req.href, { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 1500));

        const replies = await page.evaluate(() => {
          const items = [];
          document.querySelectorAll('[class*="reply"], [class*="pitch-response"], [class*="response"], [class*="pitch_reply"]').forEach(el => {
            const id = el.id || el.dataset?.id;
            const author = el.querySelector('[class*="author"], [class*="name"], h4, h5')?.innerText?.trim();
            const text = el.innerText?.trim()?.substring(0, 600);
            if (text && text.length > 20) items.push({ id: id || text.substring(0, 40), author: author || 'Unknown', text });
          });
          return items;
        });

        for (const reply of replies) {
          const replyId = 'reply-' + req.id + '-' + reply.id;
          if (hasSeen(seen, account.username, replyId)) continue;
          markSeen(seen, account.username, replyId);
          const title = await page.evaluate(() => document.querySelector('h2.fw-bold')?.innerText?.trim() || document.title);
          const publication = await page.evaluate(() => document.querySelector('a[href^="/publications/"]')?.innerText?.trim() || '');
          newReplies.push({ type: 'pitch_reply', requestUrl: req.href, requestTitle: title, publication: publication || account.publication, replyFrom: reply.author, replyText: reply.text });
        }
      } catch (err) {
        console.error('Failed to check request ' + req.href + ': ' + err.message);
      }
    }
  } catch (err) {
    console.error('Reporter requests failed for ' + account.username + ': ' + err.message);
  }
  return newReplies;
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

  let totalNewReplies = 0;

  for (const account of accounts) {
    console.log('\nProcessing: ' + account.name + ' (' + account.publication + ')');
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    try {
      await login(page, account.username, account.password);
      const inboxReplies = await scrapeInbox(page, account, seen);
      const pitchReplies = await scrapeReporterRequests(page, account, seen);
      const allReplies = [...inboxReplies, ...pitchReplies];
      totalNewReplies += allReplies.length;

      for (const reply of allReplies) {
        await sendReplyNotification(
          account,
          reply.publication || account.publication,
          reply.requestTitle || 'Inbox message',
          reply.replyFrom || account.name,
          reply.replyText || reply.text || '',
          reply.requestUrl || reply.href || 'https://app.qwoted.com/my_inbox_v2'
        );
        console.log('New reply found for ' + account.name);
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

  if (totalNewReplies === 0) {
    await sendSlack([{
      type: 'section',
      text: { type: 'mrkdwn', text: '✅ *All clear* — checked ' + accounts.length + ' accounts. No new pitch replies.' }
    }]);
  }

  console.log('\nDone. ' + totalNewReplies + ' new replies found.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
