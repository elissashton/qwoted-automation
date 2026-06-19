const puppeteer = require('puppeteer-core');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
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
      document.querySelectorAll('[role="button"][data-conversation-id]').forEach(el => {
        const conversationId = el.dataset.conversationId;
        if
