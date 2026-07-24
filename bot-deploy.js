const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const axios = require('axios');
const telebirrReceipt = require('./telebirr-receipt-master');
const { HttpsProxyAgent } = require('https-proxy-agent');
const https = require('https');
const pdfParse = require('pdf-parse');
let proxyChain = null;
let puppeteer = null;
const fs = require('fs');
const path = require('path');
//npx puppeteer browsers install cPPhrome
// Load env first
try { require('dotenv').config({ path: require('path').join(__dirname, '.env') }); } catch (_) { }

function resolveChromeExecutablePath() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
    const base = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
    try {
        const chromeDir = path.join(base, 'chrome');
        const entries = fs.readdirSync(chromeDir).filter(n => n.startsWith('linux-'));
        if (entries.length === 0) return undefined;
        entries.sort().reverse();
        const candidate = path.join(chromeDir, entries[0], 'chrome-linux64', 'chrome');
        if (fs.existsSync(candidate)) return candidate;
    } catch (_) { }
    return undefined;
}

// Initialize Firebase Admin SDK
function stripWrappingQuotes(value) {
    let v = String(value || '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
    }
    return v.trim();
}

function getFirebasePrivateKey() {
    let key = stripWrappingQuotes(process.env.FIREBASE_PRIVATE_KEY || '');
    if (!key) return undefined;
    return key.replace(/\\n/g, '\n');
}

function normalizeServiceAccount(parsed) {
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Service account must be a JSON object');
    }
    if (parsed.private_key) {
        parsed.private_key = stripWrappingQuotes(parsed.private_key).replace(/\\n/g, '\n');
    }
    if (!parsed.private_key || !parsed.client_email) {
        throw new Error('Service account missing private_key or client_email');
    }
    if (!parsed.private_key.includes('BEGIN PRIVATE KEY')) {
        throw new Error('Service account private_key is malformed');
    }
    return parsed;
}

function parseServiceAccountJson(raw) {
    let text = stripWrappingQuotes(raw);
    // Some platforms store JSON stringified twice
    try {
        let parsed = JSON.parse(text);
        if (typeof parsed === 'string') {
            parsed = JSON.parse(parsed);
        }
        return normalizeServiceAccount(parsed);
    } catch (err) {
        throw new Error(`Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${err.message}`);
    }
}

function loadServiceAccount() {
    // Most reliable on Northflank: base64 of the service-account JSON
    const b64 = stripWrappingQuotes(process.env.FIREBASE_SERVICE_ACCOUNT_B64 || '');
    if (b64) {
        try {
            const decoded = Buffer.from(b64, 'base64').toString('utf8');
            const parsed = parseServiceAccountJson(decoded);
            console.log('🔐 Loaded Firebase credentials from FIREBASE_SERVICE_ACCOUNT_B64');
            return parsed;
        } catch (err) {
            // Do NOT fall back — otherwise old broken keys silently take over
            throw new Error(`FIREBASE_SERVICE_ACCOUNT_B64 error: ${err.message}`);
        }
    }

    // Preferred: full JSON string
    const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (rawJson) {
        try {
            const parsed = parseServiceAccountJson(rawJson);
            console.log('🔐 Loaded Firebase credentials from FIREBASE_SERVICE_ACCOUNT_JSON');
            return parsed;
        } catch (err) {
            throw new Error(err.message);
        }
    }

    // Optional: path to downloaded JSON file
    const jsonPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (jsonPath && fs.existsSync(jsonPath)) {
        const parsed = normalizeServiceAccount(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
        console.log('🔐 Loaded Firebase credentials from GOOGLE_APPLICATION_CREDENTIALS file');
        return parsed;
    }

    const firebaseProjectId = process.env.FIREBASE_PROJECT_ID || 'bgeno2-fa38b';
    console.log('🔐 Loaded Firebase credentials from individual FIREBASE_* env vars');
    return normalizeServiceAccount({
        type: 'service_account',
        project_id: firebaseProjectId,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: getFirebasePrivateKey(),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
        client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
    });
}

const BUILD_MARKER = 'yg-bot-firebase-b64-v3';
console.log(`🚀 BOOT ${BUILD_MARKER}`);
console.log('🔐 Env flags:', {
    hasB64: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_B64),
    hasJson: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
    hasPrivateKey: Boolean(process.env.FIREBASE_PRIVATE_KEY),
    hasClientEmail: Boolean(process.env.FIREBASE_CLIENT_EMAIL),
});

let serviceAccount = null;
let firebaseProjectId = process.env.FIREBASE_PROJECT_ID || 'bgeno2-fa38b';
let db = null;

global.__ygFirebaseAuth = {
    ok: false,
    projectId: firebaseProjectId,
    email: null,
    error: null,
    build: BUILD_MARKER,
};

try {
    serviceAccount = loadServiceAccount();
    firebaseProjectId = serviceAccount.project_id || firebaseProjectId;
    global.__ygFirebaseAuth.projectId = firebaseProjectId;
    global.__ygFirebaseAuth.email = serviceAccount.client_email || null;

    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${firebaseProjectId}-default-rtdb.firebaseio.com/`,
            projectId: firebaseProjectId,
        });
    }
    db = admin.firestore();
    console.log(`✅ Firebase Admin initialized for project ${firebaseProjectId} (${serviceAccount.client_email})`);

    // Verify credentials immediately (catches UNAUTHENTICATED at boot)
    db.collection('users').limit(1).get()
        .then(() => {
            global.__ygFirebaseAuth.ok = true;
            console.log('✅ Firebase credentials verified (Firestore read OK)');
        })
        .catch((err) => {
            global.__ygFirebaseAuth.ok = false;
            global.__ygFirebaseAuth.error = err.message;
            console.error('❌ Firebase credentials INVALID at startup:', err.message);
            console.error('👉 Set FIREBASE_SERVICE_ACCOUNT_B64 on Northflank, then redeploy latest commit');
        });
} catch (err) {
    global.__ygFirebaseAuth.error = err.message;
    console.error('❌ Firebase setup failed (bot will stay up for /health):', err.message);
    console.error('👉 Northflank must build latest git commit and set FIREBASE_SERVICE_ACCOUNT_B64');
}

function requireDb() {
    if (!db) {
        throw new Error('Firebase is not configured. On Northflank: rebuild latest commit + set FIREBASE_SERVICE_ACCOUNT_B64');
    }
    return db;
}

// Firebase Functions will be called via HTTP requests since we're using Admin SDK

// Function to add leaderboard points directly to user document (matching web app system)
async function addDepositLeaderboardPoints(uid, depositAmount) {
    try {
        const pointsToAdd = Math.floor(depositAmount * 5);

        // Update user document with daily leaderboard points (matching web app system)
        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            console.error(`User ${uid} not found for leaderboard update`);
            return {
                success: false,
                pointsAdded: 0,
                message: 'User not found'
            };
        }

        const userData = userDoc.data();
        const currentDailyPoints = userData.dailyLeaderboardPoints || 0;
        const newDailyPoints = currentDailyPoints + pointsToAdd;

        // Update daily leaderboard points on user document
        const updateData = {
            dailyLeaderboardPoints: newDailyPoints,
            lastLeaderboardUpdate: admin.firestore.FieldValue.serverTimestamp()
        };

        // Ensure all daily leaderboard fields exist (for backward compatibility)
        if (userData.dailyTotalGames === undefined) {
            updateData.dailyTotalGames = 0;
        }
        if (userData.dailyTotalWins === undefined) {
            updateData.dailyTotalWins = 0;
        }
        if (userData.dailyTotalWinnings === undefined) {
            updateData.dailyTotalWinnings = 0;
        }

        await userRef.update(updateData);

        console.log(`Added ${pointsToAdd} leaderboard points for user ${uid} deposit of ${depositAmount} ETB (Total: ${newDailyPoints})`);
        return {
            success: true,
            pointsAdded: pointsToAdd,
            message: `Added ${pointsToAdd} leaderboard points for deposit`
        };
    } catch (error) {
        console.error(`Error adding leaderboard points for user ${uid}:`, error);
        throw error;
    }
}

// In-memory conversation state per user
const userStates = new Map();

// Helper function to safely send messages with error handling
async function safeSendMessage(chatId, text, options = {}) {
    try {
        return await bot.sendMessage(chatId, text, options);
    } catch (error) {
        console.error('[Main Bot] Error sending message:', error);
        // Try sending a fallback message without special formatting
        try {
            const fallbackText = text.replace(/[<>]/g, '').replace(/\*\*/g, '').replace(/\*/g, '');
            return await bot.sendMessage(chatId, fallbackText, {});
        } catch (fallbackError) {
            console.error('[Main Bot] Fallback message also failed:', fallbackError);
            // Last resort - send a simple message
            try {
                return await bot.sendMessage(chatId, 'Message could not be sent. Please try again.');
            } catch (finalError) {
                console.error('[Main Bot] All message sending attempts failed:', finalError);
            }
        }
    }
}

// Telebirr deposit configuration
const TELEBIRR_TARGET_PHONE_LOCAL = '0941443794';
const TELEBIRR_TARGET_NAME = 'Yonatan Abdulkadir'; // Expected receiver name
function toInternationalPhone(localPhone) {
    const cleaned = localPhone.replace(/\D/g, '');
    if (cleaned.startsWith('0')) {
        return '251' + cleaned.slice(1);
    }
    if (cleaned.startsWith('251')) {
        return cleaned;
    }
    return cleaned;
}
const TELEBIRR_TARGET_PHONE_INTL = toInternationalPhone(TELEBIRR_TARGET_PHONE_LOCAL);

// CBE Birr deposit configuration
const CBE_TARGET_PHONE_LOCAL = '0941443794';
const CBE_TARGET_PHONE_INTL = toInternationalPhone(CBE_TARGET_PHONE_LOCAL);
const CBE_TARGET_NAME = 'Yonatan Abdulkadir'; // Expected receiver name

function parseTelebirrReceipt(messageText) {
    const text = messageText || '';
    const amountMatch = text.match(/transferred\s*ETB\s*([\d,.]+)/i);
    const txMatch = text.match(/transaction\s+number\s+is\s+([A-Z0-9]+)/i);
    const linkMatch = text.match(/https?:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/[A-Za-z0-9_-]+/i);
    const receiverNameMatch = text.match(/to\s+([^\(\n]+)\s*\(/i);
    const maskedPhoneMatch = text.match(/\(([^)]+)\)/);
    const datetimeMatch = text.match(/on\s+(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/);

    return {
        amount: amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : null,
        transactionNumber: txMatch ? txMatch[1].toUpperCase() : null,
        receiptUrl: linkMatch ? linkMatch[0] : null,
        receiverName: receiverNameMatch ? receiverNameMatch[1].trim() : null,
        maskedPhone: maskedPhoneMatch ? maskedPhoneMatch[1] : null,
        datetime: datetimeMatch ? datetimeMatch[1] : null
    };
}

function parseCBEBirrReceipt(messageText) {
    const text = messageText || '';

    // Parse amount: "you have sent 10.00Br."
    const amountMatch = text.match(/sent\s+([\d,.]+)Br\./i);

    // Parse transaction ID: "Txn ID CHO1SN9RQX"
    const txMatch = text.match(/Txn\s+ID\s+([A-Z0-9]+)/i);

    // Parse receipt URL: "https://cbepay1.cbe.com.et/aureceipt?TID=CHO1SN9RQX&PH=251913503182"
    const linkMatch = text.match(/https?:\/\/cbepay1\.cbe\.com\.et\/aureceipt\?[^\s]+/i);

    // Parse receiver name: "to edomiayas tariku"
    const receiverNameMatch = text.match(/to\s+([^,]+?)\s+on/i);

    // Parse date and time: "on 24/08/25 21:40"
    const datetimeMatch = text.match(/on\s+(\d{2}\/\d{2}\/\d{2}\s+\d{2}:\d{2})/);

    // Parse account balance: "Your CBE Birr account balance is 514.77Br."
    const balanceMatch = text.match(/balance\s+is\s+([\d,.]+)Br\./i);

    return {
        amount: amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : null,
        transactionNumber: txMatch ? txMatch[1].toUpperCase() : null,
        receiptUrl: linkMatch ? linkMatch[0] : null,
        receiverName: receiverNameMatch ? receiverNameMatch[1].trim() : null,
        datetime: datetimeMatch ? datetimeMatch[1] : null,
        accountBalance: balanceMatch ? Number(balanceMatch[1].replace(/,/g, '')) : null
    };
}

function maskedPhoneMatchesTarget(maskedPhone, targetIntl) {
    if (!maskedPhone || !targetIntl) return false;
    const digitsOnly = maskedPhone.replace(/\D/g, '');
    const targetDigits = targetIntl.replace(/\D/g, '');
    if (digitsOnly.length < 6 || targetDigits.length < 6) return false;
    const startsOk = digitsOnly.startsWith('2519');
    const endsOk = digitsOnly.endsWith(targetDigits.slice(-4));
    return startsOk && endsOk;
}

function receiverNameMatchesTarget(receiverName, targetName) {
    if (!receiverName || !targetName) return false;

    // Normalize names for comparison (case-insensitive, trim whitespace)
    const normalizedReceiver = receiverName.toLowerCase().trim();
    const normalizedTarget = targetName.toLowerCase().trim();

    // Exact match
    if (normalizedReceiver === normalizedTarget) return true;

    // Partial match (in case of slight variations)
    if (normalizedReceiver.includes(normalizedTarget) || normalizedTarget.includes(normalizedReceiver)) return true;

    // Handle common name variations
    const targetWords = normalizedTarget.split(' ');
    const receiverWords = normalizedReceiver.split(' ');

    // Check if all target name words are present in receiver name
    const allTargetWordsPresent = targetWords.every(word =>
        receiverWords.some(receiverWord =>
            receiverWord.includes(word) || word.includes(receiverWord)
        )
    );

    return allTargetWordsPresent;
}

function buildAxiosOptionsForReceipt(urlString) {
    const options = { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' } };

    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const noProxy = (process.env.NO_PROXY || '').split(',').map(s => s.trim()).filter(Boolean);
    const hostname = (() => { try { return new URL(urlString).hostname; } catch { return ''; } })();
    const skipProxy = noProxy.some(domain => hostname.endsWith(domain));
    if (proxyUrl && !skipProxy) {
        options.httpsAgent = new HttpsProxyAgent(proxyUrl);
    }

    if (process.env.HTTPS_CA_CERT) {
        options.httpsAgent = new https.Agent({
            ...(options.httpsAgent ? { ...options.httpsAgent.options } : {}),
            ca: process.env.HTTPS_CA_CERT,
            rejectUnauthorized: true
        });
    }

    if (process.env.RECEIPT_ALLOW_INSECURE === '1') {
        options.httpsAgent = new https.Agent({
            ...(options.httpsAgent ? { ...options.httpsAgent.options } : {}),
            rejectUnauthorized: false
        });
    }

    return options;
}

async function fetchReceiptHtmlWithRedirects(startUrl) {
    const visited = new Set();
    let currentUrl = startUrl;
    let cookies = '';
    const maxHops = 10;
    for (let i = 0; i < maxHops; i++) {
        if (visited.has(currentUrl)) {
            console.log('[telebirr-debug] redirect loop detected at', currentUrl);
            throw new Error('redirect_loop');
        }
        visited.add(currentUrl);
        const opts = buildAxiosOptionsForReceipt(currentUrl);
        const headers = { ...(opts.headers || {}), Cookie: cookies };
        const res = await axios.request({ url: currentUrl, method: 'GET', headers, timeout: opts.timeout || 15000, httpsAgent: opts.httpsAgent, maxRedirects: 0, validateStatus: () => true, responseType: 'text' });
        console.log('[telebirr-debug] hop', i, res.status, res.headers && res.headers.location);
        const setCookie = res.headers && res.headers['set-cookie'];
        if (Array.isArray(setCookie) && setCookie.length) {
            const jar = setCookie.map(c => c.split(';')[0]).join('; ');
            cookies = cookies ? cookies + '; ' + jar : jar;
        }
        if (res.status >= 300 && res.status < 400 && res.headers && res.headers.location) {
            const next = new URL(res.headers.location, currentUrl).toString();
            currentUrl = next;
            continue;
        }
        if (res.status >= 200 && res.status < 300) {
            return { body: typeof res.data === 'string' ? res.data : String(res.data), finalUrl: currentUrl };
        }
        throw new Error('http_' + res.status);
    }
    throw new Error('too_many_redirects');
}

async function fetchReceiptHtmlWithPuppeteer(url) {
    try {
        if (!puppeteer) puppeteer = require('puppeteer');
        if (!proxyChain) proxyChain = require('proxy-chain');
        const proxyUrlRaw = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
        const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
        let proxyAuth = null;
        let anonymizedProxyUrl = null;
        if (proxyUrlRaw) {
            try {
                const p = new URL(proxyUrlRaw);
                if (p.username || p.password) {
                    anonymizedProxyUrl = await proxyChain.anonymizeProxy(proxyUrlRaw);
                    launchArgs.push(`--proxy-server=${anonymizedProxyUrl}`);
                } else {
                    const proxyServer = `${p.protocol || 'http:'}//${p.hostname}:${p.port}`;
                    launchArgs.push(`--proxy-server=${proxyServer}`);
                }
                if (p.username || p.password) {
                    proxyAuth = { username: decodeURIComponent(p.username || ''), password: decodeURIComponent(p.password || '') };
                }
            } catch (e) { console.log('[telebirr-debug] proxy parse error:', e && e.message); }
        }
        const execPath = resolveChromeExecutablePath();
        console.log('[telebirr-debug] puppeteer launching with args:', launchArgs, 'execPath:', execPath || '(default)');
        const browser = await puppeteer.launch({ args: launchArgs, headless: 'new', executablePath: execPath });
        const page = await browser.newPage();
        if (proxyAuth && !anonymizedProxyUrl) {
            try { await page.authenticate(proxyAuth); } catch (e) { console.log('[telebirr-debug] page.authenticate error:', e && e.message); }
        }
        await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1');
        await page.setExtraHTTPHeaders({ 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' });
        console.log('[telebirr-debug] puppeteer goto:', url);
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log('[telebirr-debug] puppeteer status:', resp && resp.status());
        await new Promise(r => setTimeout(r, 1500));
        const content = await page.content();
        await browser.close();
        if (anonymizedProxyUrl) {
            try { await proxyChain.closeAnonymizedProxy(anonymizedProxyUrl, true); } catch (_) { }
        }
        return content;
    } catch (e) {
        console.log('[telebirr-debug] puppeteer error:', e && e.message);
        return null;
    }
}

async function validateReceiptUrl(url) {
    try {
        let htmlBody = null;
        try {
            const { body } = await fetchReceiptHtmlWithRedirects(url);
            htmlBody = body;
        } catch (e) {
            console.log('[telebirr-debug] redirect fetch failed:', e && e.message, '→ trying puppeteer');
        }
        if (!htmlBody) htmlBody = await fetchReceiptHtmlWithPuppeteer(url);
        if (!htmlBody) return { ok: true, parsed: null, amountFallback: null, statusOk: null, receiptNo: null };
        if (/This request is not correct/i.test(htmlBody)) {
            return { ok: false, reason: 'invalid_receipt' };
        }

        // Try parse receipt HTML to verify credited account
        let parsedReceipt = null;
        try {
            parsedReceipt = telebirrReceipt.utils.parseFromHTML(htmlBody);
            console.log('[telebirr-debug] parsed receipt data:', {
                credited_party_name: parsedReceipt?.credited_party_name,
                credited_party_acc_no: parsedReceipt?.credited_party_acc_no,
                to: parsedReceipt?.to,
                from: parsedReceipt?.from
            });

            const creditedAcc = String(parsedReceipt?.credited_party_acc_no || '').replace(/\D/g, '');
            const creditedMasked = String(parsedReceipt?.to || '').replace(/\D/g, '');
            const target = TELEBIRR_TARGET_PHONE_INTL.replace(/\D/g, '');
            const last4Ok = creditedAcc.endsWith(target.slice(-4)) || creditedMasked.endsWith(target.slice(-4));
            const starts2519 = creditedAcc.startsWith('2519') || creditedMasked.startsWith('2519');
            if (!(last4Ok && starts2519)) {
                // still ok
            }
        } catch (_) {
            // ignore parse errors, still ok
        }

        const { amountFallback, statusOk, creditedPartyName } = extractAmountAndStatusFallback(htmlBody);
        return { ok: true, parsed: parsedReceipt, amountFallback, statusOk, creditedPartyName };
    } catch (error) {
        return { ok: true, parsed: null, amountFallback: null, statusOk: null, creditedPartyName: null };
    }
}

function extractAmountAndStatusFallback(html) {
    try {
        const text = String(html);
        const amountMatches = Array.from(text.matchAll(/([\d.,]+)\s*Birr/gi)).map(m => Number(String(m[1]).replace(/,/g, ''))).filter(n => Number.isFinite(n));
        const maxAmount = amountMatches.length ? Math.max(...amountMatches) : null;
        const statusOk = /Completed/i.test(text) ? true : null;
        const receiptNoMatch = text.match(/Invoice\s*No\.?\s*([A-Z0-9]+)/i) || text.match(/Receipt\s*No\.?\s*([A-Z0-9]+)/i);
        const receiptNo = receiptNoMatch ? receiptNoMatch[1].toUpperCase() : null;

        // Extract credited party name from HTML
        let creditedPartyName = null;

        // Try to find the credited party name in the HTML
        // Look for patterns like "የገንዘብ ተቀባይ ስም" or "Credited Party name" followed by the name
        const creditedPartyMatch = text.match(/የገንዘብ\s*ተቀባይ\s*ስም[:\s]*([^\n\r<]+)/i) ||
            text.match(/Credited\s*Party\s*name[:\s]*([^\n\r<]+)/i) ||
            text.match(/To[:\s]*([^\n\r<]+)/i) ||
            text.match(/Receiver[:\s]*([^\n\r<]+)/i) ||
            text.match(/Credited\s*Party\s*Name[:\s]*([^\n\r<]+)/i) ||
            text.match(/Credited\s*Party\s*name[:\s]*([A-Za-z\s]+)/i);

        if (creditedPartyMatch) {
            creditedPartyName = creditedPartyMatch[1].trim();
            console.log('[telebirr-debug] extracted credited party name from HTML:', creditedPartyName);
        }

        return { amountFallback: maxAmount, statusOk, receiptNo, creditedPartyName };
    } catch {
        return { amountFallback: null, statusOk: null, receiptNo: null, creditedPartyName: null };
    }
}

function buildAxiosOptionsForCBEReceipt(urlString) {
    const options = {
        timeout: 15000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
            'Accept': 'application/pdf,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    };

    // For CBE Birr, we don't use proxy as specified
    console.log('[cbe-debug] not using proxy for CBE receipt fetch');

    // Custom CA support
    if (process.env.HTTPS_CA_CERT) {
        options.httpsAgent = new https.Agent({
            ca: process.env.HTTPS_CA_CERT,
            rejectUnauthorized: true
        });
        console.log('[cbe-debug] custom CA set');
    }

    // Optional insecure flag (last resort)
    if (process.env.RECEIPT_ALLOW_INSECURE === '1') {
        options.httpsAgent = new https.Agent({
            rejectUnauthorized: false
        });
        console.log('[cbe-debug] TLS validation disabled for CBE receipt fetch');
    }

    return options;
}

async function fetchCBEReceiptPdf(url) {
    console.log('[cbe-debug] fetching CBE receipt URL:', url);

    try {
        // Simple direct approach with https module
        const https = require('https');
        const urlObj = new URL(url);

        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/pdf,application/octet-stream,*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Connection': 'close'
            },
            timeout: 30000,
            rejectUnauthorized: false
        };

        return new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                console.log('[cbe-debug] response status:', res.statusCode);
                console.log('[cbe-debug] response headers:', res.headers);

                let data = [];
                res.on('data', chunk => data.push(chunk));
                res.on('end', () => {
                    const buffer = Buffer.concat(data);
                    console.log('[cbe-debug] received data size:', buffer.length);

                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        const contentType = res.headers['content-type'] || '';
                        if (contentType.includes('application/pdf') || buffer.length > 1000) {
                            console.log('[cbe-debug] PDF fetch successful');
                            resolve(buffer);
                        } else {
                            console.log('[cbe-debug] not a PDF, content type:', contentType);
                            reject(new Error('Not a PDF'));
                        }
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}`));
                    }
                });
            });

            req.on('error', (error) => {
                console.log('[cbe-debug] request error:', error.message);
                reject(error);
            });

            req.on('timeout', () => {
                console.log('[cbe-debug] request timeout');
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.end();
        });

    } catch (error) {
        console.log('[cbe-debug] fetch error:', error.message);
        return null;
    }
}

async function validateCBEReceiptUrl(url, expectedAmount, expectedTxId) {
    try {
        console.log('[cbe-debug] validating CBE receipt URL:', url);

        const pdfData = await fetchCBEReceiptPdf(url);
        if (!pdfData) {
            console.log('[cbe-debug] could not fetch CBE receipt PDF - REJECTING DEPOSIT');
            return { ok: false, reason: 'pdf_fetch_failed' };
        }

        // Convert PDF data to text for parsing using proper PDF parser
        try {
            const buffer = Buffer.from(pdfData);
            console.log('[cbe-debug] PDF buffer size:', buffer.length);

            // Use pdf-parse library to properly extract text from PDF
            const parsedPdfData = await pdfParse(buffer);
            const textContent = parsedPdfData.text;

            console.log('[cbe-debug] PDF text content (first 500 chars):', textContent.substring(0, 500));

            // Look for key information in the PDF text - updated for CBE Birr format
            console.log('[cbe-debug] full PDF text for debugging:', textContent);

            // Amount patterns for CBE Birr receipts - look for the specific format in the PDF
            const amountMatch = textContent.match(/Paid\s*amount\s*(\d+\.\d{2})/i) ||
                textContent.match(/Total\s*Paid\s*Amount\s*(\d+\.\d{2})/i) ||
                textContent.match(/(\d+\.\d{2})\s*Paid\s*amount/i) ||
                textContent.match(/(\d+\.\d{2})\s*Total\s*Paid\s*Amount/i);

            // Transaction ID patterns - based on actual PDF structure
            const txMatch = textContent.match(/Order\s*ID\s*([A-Z0-9]+)/i) ||
                textContent.match(/Transaction\s*ID[:\s]*([A-Z0-9]+)/i) ||
                textContent.match(/TID[:\s]*([A-Z0-9]+)/i) ||
                textContent.match(/Reference[:\s]*([A-Z0-9]+)/i) ||
                textContent.match(/Invoice[:\s]*([A-Z0-9]+)/i);

            // Status patterns - based on actual PDF structure
            const statusMatch = textContent.match(/Transaction\s*Status\s*(Completed|Success|Successful|Paid)/i) ||
                textContent.match(/Status[:\s]*(Completed|Success|Successful|Paid)/i) ||
                textContent.match(/Payment[:\s]*(Completed|Success|Successful|Paid)/i);

            // Receiver patterns - based on actual PDF structure
            const receiverMatch = textContent.match(/Receiver\s*Name\s*([^\n]+)/i) ||
                textContent.match(/Customer\s*Name[:\s]*([^\n]+)/i) ||
                textContent.match(/Receiver[:\s]*([^\n]+)/i) ||
                textContent.match(/To[:\s]*([^\n]+)/i) ||
                textContent.match(/(\d{10,12})\s*-\s*([^\n]+)/i) || // Phone - Name format
                textContent.match(/Credit\s*Account\s*\d+\s*-\s*([^\n]+)/i) || // Credit Account format
                textContent.match(/Receiver\s*Name\s*\d+\s*-\s*([^\n]+)/i); // Receiver Name with phone format

            let extractedAmount = null;
            if (amountMatch) {
                if (amountMatch[1]) {
                    extractedAmount = Number(amountMatch[1].replace(/[^\d.,]/g, '').replace(/,/g, ''));
                } else if (amountMatch[0]) {
                    extractedAmount = Number(amountMatch[0].replace(/[^\d.,]/g, '').replace(/,/g, ''));
                }
            }

            // Debug logging for amount extraction
            console.log('[cbe-debug] amountMatch result:', amountMatch);
            console.log('[cbe-debug] initial extractedAmount:', extractedAmount);

            // Fallback: Look for amount in the transaction details section
            if (!extractedAmount || extractedAmount <= 0) {
                // Look specifically for "Paid amount" line
                const paidAmountMatch = textContent.match(/Paid\s*amount\s*(\d+\.\d{2})/i);
                if (paidAmountMatch) {
                    extractedAmount = Number(paidAmountMatch[1]);
                    console.log('[cbe-debug] fallback paidAmountMatch:', paidAmountMatch);
                }
            }

            // Additional fallback: Look for "Total Paid Amount" line
            if (!extractedAmount || extractedAmount <= 0) {
                const totalPaidMatch = textContent.match(/Total\s*Paid\s*Amount\s*(\d+\.\d{2})/i);
                if (totalPaidMatch) {
                    extractedAmount = Number(totalPaidMatch[1]);
                    console.log('[cbe-debug] fallback totalPaidMatch:', totalPaidMatch);
                }
            }

            // Final fallback: Look for the specific pattern in your PDF
            if (!extractedAmount || extractedAmount <= 0) {
                // Look for the pattern: "5.00\nPaid amount" or similar
                const specificMatch = textContent.match(/(\d+\.\d{2})\s*\n\s*Paid\s*amount/i);
                if (specificMatch) {
                    extractedAmount = Number(specificMatch[1]);
                    console.log('[cbe-debug] fallback specificMatch:', specificMatch);
                }
            }
            const extractedTxId = txMatch ? txMatch[1].toUpperCase() : null;
            const statusOk = statusMatch ? true : null;

            // Handle receiver name extraction
            let receiverName = null;
            if (receiverMatch) {
                if (receiverMatch[1] && receiverMatch[2]) {
                    // Phone - Name format
                    receiverName = receiverMatch[2].trim();
                } else {
                    // Direct name format
                    receiverName = receiverMatch[1].trim();
                }
            }

            // Additional fallback: Look for the specific format in your PDF
            if (!receiverName) {
                const creditAccountMatch = textContent.match(/Credit\s*Account\s*\d+\s*-\s*([^\n]+)/i);
                if (creditAccountMatch) {
                    receiverName = creditAccountMatch[1].trim();
                    console.log('[cbe-debug] extracted receiver from Credit Account:', receiverName);
                }
            }

            if (!receiverName) {
                const receiverNameMatch = textContent.match(/Receiver\s*Name\s*\d+\s*-\s*([^\n]+)/i);
                if (receiverNameMatch) {
                    receiverName = receiverNameMatch[1].trim();
                    console.log('[cbe-debug] extracted receiver from Receiver Name:', receiverName);
                }
            }

            console.log('[cbe-debug] extracted from PDF:', {
                amount: extractedAmount,
                txId: extractedTxId,
                status: statusOk,
                receiver: receiverName
            });

            // If we successfully extracted data from PDF, use it as authoritative
            if (extractedAmount && extractedTxId) {
                // Verify the extracted data matches expected values
                const amountMatches = !expectedAmount || !extractedAmount || Math.abs(extractedAmount - expectedAmount) < 0.01;
                const txMatches = !expectedTxId || !extractedTxId || extractedTxId === expectedTxId;

                // Validate receiver name matches expected target
                const nameMatches = !receiverName || receiverNameMatchesTarget(receiverName, CBE_TARGET_NAME);
                console.log('[cbe-debug] checking CBE receiver name:', receiverName, 'against target:', CBE_TARGET_NAME, 'matches:', nameMatches);

                if (!amountMatches || !txMatches || !nameMatches) {
                    console.log('[cbe-debug] extracted data does not match expected values - amount:', amountMatches, 'tx:', txMatches, 'name:', nameMatches);
                    return { ok: false, reason: 'data_mismatch' };
                }

                return {
                    ok: true,
                    parsed: {
                        amount: extractedAmount,
                        transactionId: extractedTxId,
                        status: statusOk,
                        receiver: receiverName
                    },
                    amountFallback: extractedAmount,
                    statusOk: statusOk,
                    receiptNo: extractedTxId
                };
            } else {
                console.log('[cbe-debug] could not extract sufficient data from PDF - REJECTING DEPOSIT');
                return { ok: false, reason: 'pdf_parse_failed' };
            }

        } catch (parseError) {
            console.log('[cbe-debug] PDF parsing error:', parseError.message);
            // If we can't parse the PDF, REJECT the deposit
            return { ok: false, reason: 'pdf_parse_error' };
        }

    } catch (error) {
        console.log('[cbe-debug] CBE receipt validation error:', error && (error.message || error.code));
        // Per requirement, do not reject on network errors
        return { ok: true, parsed: null, amountFallback: null, statusOk: null, receiptNo: null };
    }
}

async function getUserDocByTelegramId(telegramId) {
    const snap = await db.collection('users').where('telegramId', '==', String(telegramId)).get();
    if (snap.empty) return null;

    // MAIN BOT: Look for non-happy accounts specifically
    for (const doc of snap.docs) {
        const uid = doc.id;
        if (!uid.startsWith('happy_')) {
            // Found a main account
            return { id: doc.id, ref: doc.ref, data: doc.data() };
        }
    }

    // Only happy accounts found
    return null;
}

async function creditDepositIfNew(userRef, txNumber, amount, rawMessage) {
    return await db.runTransaction(async (t) => {
        // Check duplicate by using subcollection doc id as transaction number
        const txDocRef = userRef.collection('transactions').doc(txNumber);
        const existing = await t.get(txDocRef);
        if (existing.exists) {
            return { credited: false, duplicate: true, balance: (await t.get(userRef)).data()?.wallet || 0 };
        }

        const userSnap = await t.get(userRef);
        const userData = userSnap.data() || {};
        const currentBalance = Number(userData.wallet || 0);

        // Simple deposit
        const depositAmount = Number(amount);
        const totalCredit = depositAmount;
        const newBalance = currentBalance + totalCredit;

        t.set(txDocRef, {
            type: 'deposit',
            provider: rawMessage.includes('CBE') ? 'cbe_birr' : 'telebirr',
            amount: depositAmount,
            totalCredit: totalCredit,
            transactionNumber: txNumber,
            status: 'credited',
            message: rawMessage,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Also save to centralized deposits collection for easier querying
        const centralizedDepositRef = db.collection('deposits').doc(txNumber);
        t.set(centralizedDepositRef, {
            userId: userRef.id,
            userName: userData.userName || 'Unknown',
            phone: userData.phone || 'N/A',
            type: 'deposit',
            provider: rawMessage.includes('CBE') ? 'cbe_birr' : 'telebirr',
            amount: depositAmount,
            totalCredit: totalCredit,
            transactionNumber: txNumber,
            status: 'credited',
            message: rawMessage,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Update user wallet
        t.update(userRef, {
            wallet: newBalance
        });

        return {
            credited: true,
            balance: newBalance,
            totalCredit: totalCredit
        };
    });
}

// REMOVED: Announcement functionality has been disabled

// REMOVED: Announcement processing functionality has been disabled


function sendDepositInstructions(bot, chatId) {
    const instructions = `
💳 TELEBIRR በኩል ገንዘብ አስገባ

1) TELEBIRR ክፍት እና የሚፈልጉትን መጠን ወደ ይላኩ:
• ስም: Yonatan Abdulkadir
• ስልክ: ${TELEBIRR_TARGET_PHONE_LOCAL}

2) ከክፍያ በኋላ፣ ሙሉውን የTELEBIRR መልዕክት ይቅዱ እና እዚህ ይላኩ።

🆘 ችግር ካጋጠመዎት፣ ሁልጊዜ ${TELEBIRR_TARGET_PHONE_LOCAL} ያግኙ።

`;

    bot.sendMessage(chatId, instructions, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '❌ ይሰርዙ', callback_data: 'cancel_deposit' }]
            ]
        }
    });
}

function sendCBEDepositInstructions(bot, chatId) {
    const instructions = `
💳 CBE Birr በኩል ገንዘብ አስገባ

1) CBE Birr መተግበሪያ ክፍት እና የሚፈልጉትን መጠን ወደ ይላኩ:
• ስም: Yonatan Abdulkadir
• ስልክ: ${CBE_TARGET_PHONE_LOCAL}

2) ከክፍያ በኋላ፣ ሙሉውን የCBE Birr መልዕክት ይቅዱ እና እዚህ ይላኩ።

🆘 ችግር ካጋጠመዎት፣ ሁልጊዜ ${CBE_TARGET_PHONE_LOCAL} ያግኙ።

`;

    bot.sendMessage(chatId, instructions, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '❌ ይሰርዙ', callback_data: 'cancel_deposit' }]
            ]
        }
    });
}

// Bot configuration with validation
const token = process.env.BOT_TOKEN;
const gameUrl = process.env.GAME_URL || 'https://ygbingo.netlify.app/';

// Debug information
console.log('🔍 Debug Information:');
console.log('Token exists:', !!token);
console.log('Token value:', token ? token.substring(0, 10) + '...' + token.substring(token.length - 4) : 'undefined');
console.log('Game URL:', gameUrl);

// Validate bot token
if (!token || token === 'your_telegram_bot_token_here') {
    console.error('❌ Error: Bot token not found or invalid!');
    console.error('Please check your environment variables and ensure BOT_TOKEN is set correctly.');
    process.exit(1);
}

console.log('✅ Bot token loaded successfully');
console.log('✅ Game URL:', gameUrl);

// Northflank / code.run public URL needs an HTTP listener
try {
    require('./health-server').startHealthServer();
} catch (err) {
    console.warn('⚠️ Health server failed to start:', err.message);
}

const bot = new TelegramBot(token, { polling: false });

function normalizePhone(phone) {
    let digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return '';
    // Ethiopia local 09xxxxxxxx -> 2519xxxxxxxx
    if (digits.startsWith('0') && digits.length === 10) {
        digits = `251${digits.slice(1)}`;
    }
    // 9xxxxxxxx -> 2519xxxxxxxx
    if (digits.length === 9 && digits.startsWith('9')) {
        digits = `251${digits}`;
    }
    return digits;
}

function phoneLookupVariants(phone) {
    const normalized = normalizePhone(phone);
    const variants = new Set([normalized, `+${normalized}`]);
    const raw = String(phone || '').replace(/\s+/g, '').replace(/-/g, '');
    if (raw) variants.add(raw);
    return [...variants].filter(Boolean);
}

// Function to check if user is registered
async function isUserRegistered(userId) {
    try {
        const data = await getUserData(userId);
        return Boolean(data);
    } catch (error) {
        console.error('Error checking user registration:', error);
        return false;
    }
}

// Function to get user data from Firebase (MAIN BOT - non-happy users only)
async function getUserData(userId) {
    try {
        const uid = String(userId);

        // Prefer doc id == telegram id (Mini App / new registrations)
        const byId = await db.collection('users').doc(uid).get();
        if (byId.exists) {
            const data = byId.data() || {};
            if (!uid.startsWith('happy_')) {
                return { ...data, uid };
            }
        }

        const userDoc = await db.collection('users').where('telegramId', '==', uid).get();
        if (!userDoc.empty) {
            // MAIN BOT: Look for non-happy accounts specifically
            for (const doc of userDoc.docs) {
                const docId = doc.id;
                if (!docId.startsWith('happy_')) {
                    return {
                        ...doc.data(),
                        uid: docId
                    };
                }
            }
        }
        return null;
    } catch (error) {
        console.error('Error getting user data:', error);
        return null;
    }
}

// Function to check if user has ANY account (for registration purposes)
async function checkUserExists(userId) {
    try {
        const userDoc = await db.collection('users').where('telegramId', '==', userId.toString()).get();
        return !userDoc.empty;
    } catch (error) {
        console.error('Error checking user existence:', error);
        return false;
    }
}

// Helper function to get user data and handle registration prompts
async function getUserDataWithFallback(userId, chatId, bot) {
    const userData = await getUserData(userId);
    if (userData && userData.uid) {
        return userData;
    }

    // User doesn't have a main account, prompt to register
    bot.sendMessage(chatId, 'Please register first using /start and share your phone number.');
    return null;
}

// Function to check if phone number is already registered
async function isPhoneRegistered(phone) {
    try {
        const userDoc = await db.collection('users').where('phone', '==', phone).get();
        return !userDoc.empty;
    } catch (error) {
        console.error('Error checking phone registration:', error);
        return false;
    }
}

// Function to get user by phone number
async function getUserByPhone(phone) {
    try {
        for (const candidate of phoneLookupVariants(phone)) {
            const userDoc = await db.collection('users').where('phone', '==', candidate).limit(5).get();
            if (userDoc.empty) continue;
            for (const doc of userDoc.docs) {
                const uid = doc.id;
                if (!uid.startsWith('happy_')) {
                    return {
                        ...doc.data(),
                        uid: uid
                    };
                }
            }
        }
        return null;
    } catch (error) {
        console.error('Error getting user by phone:', error);
        return null;
    }
}

// Function to show user profile and play options
async function showUserProfile(chatId, userData) {
    const profileMessage = `
👤 Welcome Back, ${userData.userName}!

📱 Phone: ${userData.phone}
💰 Balance: ${userData.wallet} Birr
🆔 UID: ${userData.uid}
📅 Member since: ${userData.createdAt ? new Date(userData.createdAt.toDate()).toLocaleDateString() : 'N/A'}

You're already registered! Ready to play?
  `;

    bot.sendMessage(chatId, profileMessage, {
        parse_mode: 'HTML',
        reply_markup: {
            keyboard: [
                [
                    { text: '🎮 Play' },
                    { text: '💰 Balance' }
                ],
                [
                    { text: '💳 Deposit' },
                    { text: '💸 Withdraw' }
                ],
            ],
            resize_keyboard: true,
            persistent: true
        }
    });
}

// Function to create user in Firebase (doc id = telegram id for Mini App)
async function createUser(userId, userName, phone, referralCode = null) {
    try {
        const firestore = requireDb();
        const uid = String(userId);
        const normalizedPhoneNumber = normalizePhone(phone);
        if (!normalizedPhoneNumber) {
            throw new Error('Invalid phone number');
        }

        // Already registered under telegram id
        const existingById = await firestore.collection('users').doc(uid).get();
        if (existingById.exists) {
            await existingById.ref.set({
                phone: normalizedPhoneNumber,
                userName: userName || existingById.data()?.userName,
                name: userName || existingById.data()?.name,
                telegramId: uid,
                lastLogin: new Date().toISOString(),
            }, { merge: true });
            return uid;
        }

        // Phone already used — link telegram if same/empty, else block
        const existingUser = await getUserByPhone(phone);
        if (existingUser) {
            if (!existingUser.telegramId || String(existingUser.telegramId) === uid) {
                await firestore.collection('users').doc(existingUser.uid).set({
                    telegramId: uid,
                    userName: userName || existingUser.userName,
                    name: userName || existingUser.name || existingUser.userName,
                    phone: normalizedPhoneNumber,
                    lastLogin: new Date().toISOString(),
                    source: existingUser.source || 'telegram',
                }, { merge: true });
                return existingUser.uid;
            }
            throw new Error('Phone number already registered');
        }

        await firestore.collection('users').doc(uid).set({
            uid,
            userName: userName,
            name: userName,
            phone: normalizedPhoneNumber,
            telegramId: uid,
            wallet: 0,
            isAdult: true,
            agreeTerms: true,
            dailyLeaderboardPoints: 0,
            dailyTotalGames: 0,
            dailyTotalWins: 0,
            dailyTotalWinnings: 0,
            source: 'telegram',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            lastLogin: new Date().toISOString(),
            ...(referralCode ? { referralCode } : {}),
        });

        return uid;
    } catch (error) {
        console.error('Error creating user:', error);
        throw error;
    }
}

// Function to create withdrawal request
async function createWithdrawalRequest(userId, amount, method, phone) {
    try {
        const userData = await getUserData(userId);
        if (!userData) {
            throw new Error('User not found');
        }

        // Check wallet balance for withdrawal validation
        const walletBalance = Number(userData.wallet || 0);

        if (walletBalance < amount) {
            throw new Error('Insufficient wallet balance');
        }

        // Use a transaction to ensure atomicity
        const result = await db.runTransaction(async (transaction) => {
            // Get the user document reference
            const userDoc = await db.collection('users').where('telegramId', '==', userId.toString()).get();
            if (userDoc.empty) {
                throw new Error('User not found');
            }

            const userRef = userDoc.docs[0].ref;
            const currentUserData = userDoc.docs[0].data();
            const currentBalance = Number(currentUserData.wallet || 0);

            // Validate wallet balance
            if (currentBalance < amount) {
                throw new Error('Insufficient wallet balance');
            }

            // Deduct from wallet
            const newBalance = currentBalance - Number(amount);

            // Create withdrawal request
            const withdrawalRef = db.collection('withdrawals').doc();
            transaction.set(withdrawalRef, {
                userId: userId.toString(),
                userName: currentUserData.userName || 'Unknown',
                phone: phone,
                amount: Number(amount),
                method: method,
                status: 'pending',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // Update user balance
            transaction.update(userRef, {
                wallet: newBalance,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // Add transaction record for user
            const transactionRef = userRef.collection('transactions').doc();
            transaction.set(transactionRef, {
                type: 'withdrawal_request',
                amount: -Number(amount), // Negative amount for withdrawal
                method: method,
                status: 'pending',
                withdrawalId: withdrawalRef.id,
                description: `Withdrawal request via ${method}`,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            return { withdrawalId: withdrawalRef.id, newBalance };
        });

        return result.withdrawalId;
    } catch (error) {
        console.error('Error creating withdrawal request:', error);
        throw error;
    }
}

// REMOVED: /announce command has been disabled

// REMOVED: /process-announcements command has been disabled

// REMOVED: /stop-announcements command has been disabled


// Bot commands
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name;

    // Check if user has a main account specifically  
    const existingMainUser = await getUserData(userId);

    if (!existingMainUser) {
        // Sanitize userName to prevent parsing issues
        const sanitizedUserName = userName ? userName.replace(/[<>]/g, '') : 'User';

        let welcomeText = `🎰 Welcome to YG Bingo Bot, ${sanitizedUserName}! 🏆

I'm here to help you with your bingo gaming experience.

To get started, please register with your phone number!`;

        try {
            await safeSendMessage(chatId, welcomeText, {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: '📱 Register', request_contact: true }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
        } catch (error) {
            console.error('[Main Bot] Error sending welcome message:', error);
            // Fallback message without special characters
            await safeSendMessage(chatId, `Welcome to YG Bingo Bot! Please share your phone number to register.`, {
                reply_markup: {
                    keyboard: [
                        [{ text: '📱 Register', request_contact: true }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
        }
    } else {
        // User is already registered
        const userData = await getUserData(userId);
        // Sanitize userName to prevent parsing issues
        const sanitizedUserName = userName ? userName.replace(/[<>]/g, '') : 'User';

        const welcomeMessage = `
🎰 Welcome back to YG Bingo Bot, ${sanitizedUserName}! 🏆

Your balance: ${userData?.wallet || 0} Birr

Available commands:
/start - Show this welcome message
/help - Show help information
/play - Start a new game
/balance - Check your balance
/deposit - Add funds to your account
/withdraw - Withdraw your winnings
/leaderboard - View top players
/profile - View your profile
/web - Play on web platform

How can I help you today?
  `;

        try {
            await safeSendMessage(chatId, welcomeMessage, {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [
                            { text: '🎮 Play' },
                            { text: '💰 Balance' }
                        ],
                        [
                            { text: '💳 Deposit' },
                            { text: '💸 Withdraw' }
                        ],
                        [
                            { text: '🌐 Play on Web' }
                        ]
                    ],
                    resize_keyboard: true,
                    persistent: true
                }
            });
        } catch (error) {
            console.error('[Main Bot] Error sending existing user welcome message:', error);
            // Fallback message without special characters
            await safeSendMessage(chatId, `Welcome back to YG Bingo Bot! Your balance: ${userData?.wallet || 0} Birr`, {
                reply_markup: {
                    keyboard: [
                        [
                            { text: '🎮 Play' },
                            { text: '💰 Balance' }
                        ],
                        [
                            { text: '💳 Deposit' },
                            { text: '💸 Withdraw' }
                        ],
                        [
                            { text: '🌐 Play on Web' }
                        ]
                    ],
                    resize_keyboard: true,
                    persistent: true
                }
            });
        }
    }
});

// Handle contact sharing for registration
bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name || msg.from.username || 'Player';
    const contact = msg.contact;

    // Accept own contact (Telegram user_id may be number/string)
    const contactUid = contact?.user_id != null ? Number(contact.user_id) : null;
    const isOwnContact = contactUid === Number(userId);

    if (!isOwnContact) {
        bot.sendMessage(chatId, '❌ Please share your own phone number for registration.');
        return;
    }

    try {
        const existingMainUser = await getUserData(userId);
        if (existingMainUser) {
            bot.sendMessage(chatId, '✅ You are already registered! Use /start to see your options.');
            return;
        }

        const uid = await createUser(userId, userName, contact.phone_number);

        const successMessage = `
✅ Registration Successful!

Welcome to YG Bingo, ${userName}!
Your account has been created successfully.

Your UID: <code>${uid}</code>

Tap Play to open the game!
`;

        bot.sendMessage(chatId, successMessage, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [
                        { text: '🎮 Play' },
                        { text: '💰 Balance' }
                    ],
                    [
                        { text: '💳 Deposit' },
                        { text: '💸 Withdraw' }
                    ],
                    [
                        { text: '🌐 Play on Web', web_app: { url: gameUrl } }
                    ]
                ],
                resize_keyboard: true,
                persistent: true
            }
        });
    } catch (error) {
        console.error('Registration error:', error);

        if (error.message === 'Phone number already registered') {
            const existingUser = await getUserByPhone(contact.phone_number);
            if (existingUser) {
                await showUserProfile(chatId, existingUser);
                return;
            }
        }

        const detail = error?.message ? `\n\nDetails: ${error.message}` : '';
        bot.sendMessage(chatId, `❌ Registration failed. Please try again later.${detail}`);
    }
});

bot.onText(/\/web/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Check if user is registered
    const userDoc = await getUserDocByTelegramId(userId);
    if (!userDoc) {
        const registerMessage = `
❌ **Registration Required**

You need to register first before accessing the web game.

Please use /start and share your phone number to create an account.
        `;

        bot.sendMessage(chatId, registerMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📱 Register Now', callback_data: 'register_now' }
                    ]
                ]
            }
        });
        return;
    }

    // Get user data with proper fallback handling
    const userData = await getUserDataWithFallback(userId, chatId, bot);
    if (!userData) return; // Error message already sent

    const uid = userData.uid;

    const webMessage = `
🌐 Play YG Bingo on Web

Click the button below to play on our web platform:

${gameUrl}?uid=${uid}

Features on web:
• Full-screen gaming experience
• Real-time multiplayer games
• Advanced graphics and animations
• Better game controls
• Live chat with other players
  `;

    bot.sendMessage(chatId, webMessage, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🌐 Open Web Game', callback_data: 'open_web_game' }
                ],
                [
                    { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                ]
            ]
        }
    });
});

bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;

    const helpMessage = `
🤖 YG Bingo Bot Help

Commands:
• /start - Start the bot
• /help - Show this help
• /play - Start playing bingo
• /balance - Check your balance
• /deposit - Add money to account
• /withdraw - Withdraw winnings
• /leaderboard - Top players
• /profile - Your profile
• /web - Play on web platform

Game Rules:
• Choose your stake amount
• Select your cartela number
• Wait for numbers to be called
• Mark called numbers on your card
• Call BINGO when you win!

Platforms:
• Telegram Bot - Quick access and notifications
• Web Platform - Full gaming experience

Need more help? Contact support.
  `;

    bot.sendMessage(chatId, helpMessage, { parse_mode: 'HTML' });
});

bot.onText(/\/play/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Get user data with proper fallback handling
    const userData = await getUserDataWithFallback(userId, chatId, bot);
    if (!userData) return; // Error message already sent

    const uid = userData.uid;

    const playMessage = `
🎮 **Opening Game...**

Redirecting you to the web platform for the best gaming experience!
  `;

    bot.sendMessage(chatId, playMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🎮 Play Now', web_app: { url: gameUrl } }
                ],
                [
                    { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                ]
            ]
        }
    });
});

bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Get user data with proper fallback handling
    const userData = await getUserDataWithFallback(userId, chatId, bot);
    if (!userData) return; // Error message already sent

    const balance = userData.wallet || 0;
    const uid = userData.uid;

    const balanceMessage = `
💰 Your Balance: ${balance} Birr

Recent transactions:
• No recent activity

🌐 Check detailed balance on web: ${gameUrl}?uid=${uid}
  `;

    bot.sendMessage(chatId, balanceMessage, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🌐 View on Web', url: `${gameUrl}?uid=${uid}` }
                ],
                [
                    { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                ]
            ]
        }
    });
});

// New: /deposit command handler
bot.onText(/\/deposit/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userDoc = await getUserDocByTelegramId(userId);
    if (!userDoc) {
        bot.sendMessage(chatId, 'Please register first using /start and share your phone number.');
        return;
    }

    const depositMessage = `
💳 Choose Deposit Method:

Select your preferred payment method:
    `;

    bot.sendMessage(chatId, depositMessage, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📱 Telebirr', callback_data: 'deposit_telebirr' },
                    { text: '🏦 CBE Birr', callback_data: 'deposit_cbe' }
                ],
                [
                    { text: '❌ Cancel', callback_data: 'cancel_deposit' }
                ]
            ]
        }
    });
});

// Handle callback queries (button clicks)
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    // Helper function to safely answer callback queries
    const safeAnswerCallback = async (queryId, options = {}) => {
        try {
            await bot.answerCallbackQuery(queryId, options);
        } catch (error) {
            console.log('Callback query already answered or expired:', error.message);
            // Don't throw - this is expected behavior for expired queries
        }
    };

    // Get user data with proper fallback handling
    const userData = await getUserDataWithFallback(userId, chatId, bot);
    if (!userData) {
        await safeAnswerCallback(query.id, {
            text: 'Please register first or use the correct bot for your account type',
            show_alert: true
        });
        return;
    }

    const uid = userData.uid;

    switch (data) {
        case 'play':
            // Directly open web game since that's the only platform
            const playMessage = `
🎮 **Opening Game...**

Redirecting you to the web platform for the best gaming experience!
            `;

            bot.editMessageText(playMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🎮 Play Now', web_app: { url: gameUrl } }
                        ],
                        [
                            { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                        ]
                    ]
                }
            });
            break;


        case 'play_web_game':
        case 'open_web_game':
            // Check if user is registered
            const userDoc = await getUserDocByTelegramId(userId);
            if (!userDoc) {
                const registerMessage = `
❌ **Registration Required**

You need to register first before accessing the web game.

Please use /start and share your phone number to create an account.
                `;

                bot.editMessageText(registerMessage, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '📱 Register Now', callback_data: 'register_now' }
                            ],
                            [
                                { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                            ]
                        ]
                    }
                });
                return;
            }

            // User is registered, open web game
            const webGameMessage = `
🌐 **Opening Web Game...**

Redirecting you to the web platform...
            `;

            bot.editMessageText(webGameMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🌐 Open Web Game', web_app: { url: gameUrl } }
                        ],
                        [
                            { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                        ]
                    ]
                }
            });
            break;

        case 'register_now':
            const startMessage = `
📱 **Registration Required**

Please use the /start command and share your phone number to create an account.

Once registered, you'll be able to access all features including the web game.
            `;

            bot.editMessageText(startMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                        ]
                    ]
                }
            });
            break;

        case 'view_balance_web':
        case 'view_leaderboard_web':
        case 'view_profile_web':
        case 'withdraw_web':
        case 'play_full_game_web':
            // Check if user is registered
            const webUserDoc = await getUserDocByTelegramId(userId);
            if (!webUserDoc) {
                const webRegisterMessage = `
❌ **Registration Required**

You need to register first before accessing web features.

Please use /start and share your phone number to create an account.
                `;

                bot.editMessageText(webRegisterMessage, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '📱 Register Now', callback_data: 'register_now' }
                            ],
                            [
                                { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                            ]
                        ]
                    }
                });
                return;
            }

            // User is registered, open web feature
            let webFeatureMessage;
            if (data === 'view_balance_web') {
                webFeatureMessage = '💰 **Opening Balance Page...**';
            } else if (data === 'view_leaderboard_web') {
                webFeatureMessage = '🏆 **Opening Leaderboard...**';
            } else if (data === 'view_profile_web') {
                webFeatureMessage = '👤 **Opening Profile Page...**';
            } else if (data === 'withdraw_web') {
                webFeatureMessage = '💸 **Opening Withdrawal Page...**';
            } else if (data === 'play_full_game_web') {
                webFeatureMessage = '🎮 **Opening Full Game...**';
            }

            bot.editMessageText(webFeatureMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🌐 Open Web', url: `${gameUrl}?uid=${uid}` }
                        ],
                        [
                            { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                        ]
                    ]
                }
            });
            break;

        case 'balance':
            const totalBalance = userData?.wallet || 0;
            const balanceMessage = `
💰 Your Balance: ${totalBalance} Birr

Recent transactions:
• No recent activity

🌐 Check detailed balance on web: ${gameUrl}?uid=${uid}
      `;

            bot.editMessageText(balanceMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🌐 View on Web', callback_data: 'view_balance_web' }
                        ],
                        [
                            { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                        ]
                    ]
                }
            });
            break;

        case 'leaderboard':
            const leaderboardMessage = `
🏆 Top Players Leaderboard:

🥇 Player1 - 1500 Birr
🥈 Player2 - 1200 Birr  
🥉 Player3 - 900 Birr
4️⃣ Player4 - 750 Birr
5️⃣ Player5 - 600 Birr

🌐 View full leaderboard: ${gameUrl}?uid=${uid}
      `;

            bot.editMessageText(leaderboardMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🌐 View Full Leaderboard', callback_data: 'view_leaderboard_web' }
                        ],
                        [
                            { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                        ]
                    ]
                }
            });
            break;

        case 'profile':
            const userName = query.from.first_name;
            const profileMessage = `
👤 Profile: ${userName}

📊 Statistics:
• Games Played: 0
• Games Won: 0
• Total Winnings: 0 Birr
• Balance: ${userData?.wallet || 0} Birr

🎯 Achievement: New Player

🌐 View detailed profile: ${gameUrl}?uid=${uid}
      `;

            bot.editMessageText(profileMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🌐 View Full Profile', callback_data: 'view_profile_web' }
                        ],
                        [
                            { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                        ]
                    ]
                }
            });
            break;

        case 'deposit':
            const depositMessage = `
💳 Choose Deposit Method:

Select your preferred payment method:
            `;

            bot.editMessageText(depositMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📱 Telebirr', callback_data: 'deposit_telebirr' },
                            { text: '🏦 CBE Birr', callback_data: 'deposit_cbe' }
                        ],
                        [
                            { text: '❌ Cancel', callback_data: 'cancel_deposit' }
                        ]
                    ]
                }
            });
            break;

        case 'deposit_telebirr':
            userStates.set(userId, { waitingForTelebirrReceipt: true });
            sendDepositInstructions(bot, chatId);
            break;

        case 'deposit_cbe':
            userStates.set(userId, { waitingForCBEReceipt: true });
            sendCBEDepositInstructions(bot, chatId);
            break;

        case 'cancel_deposit':
            userStates.delete(userId);
            bot.editMessageText('Deposit canceled. Use /deposit whenever you are ready.', {
                chat_id: chatId,
                message_id: query.message.message_id
            });
            break;

        case 'cancel_withdrawal':
            userStates.delete(userId);
            bot.editMessageText('Withdrawal canceled. Use /withdraw whenever you are ready.', {
                chat_id: chatId,
                message_id: query.message.message_id
            });
            break;

        case 'withdraw':
            const withdrawMessage = `
💸 Withdraw Funds

Your balance: ${userData?.wallet || 0} Birr

Choose withdrawal method:

🌐 For instant withdrawals, visit: ${gameUrl}?uid=${uid}
      `;

            bot.editMessageText(withdrawMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🏦 CBE Birr', callback_data: 'withdraw_cbe' },
                            { text: '📱 Telebirr', callback_data: 'withdraw_telebirr' }
                        ],
                        [
                            { text: '🌐 Withdraw on Web', callback_data: 'withdraw_web' }
                        ],
                        [
                            { text: '🔙 Back', callback_data: 'back_to_main' }
                        ]
                    ]
                }
            });
            break;

        case 'withdraw_cbe':
        case 'withdraw_telebirr':
            const method = data === 'withdraw_cbe' ? 'CBE Birr' : 'Telebirr';
            const withdrawMethodMessage = `
💸 Withdraw via ${method}

Your balance: ${userData?.wallet || 0} Birr

Please enter the amount you want to withdraw (max: ${userData?.wallet || 0} Birr):
      `;

            userStates.set(userId, {
                waitingForWithdrawalAmount: true,
                withdrawalMethod: method
            });

            bot.editMessageText(withdrawMethodMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔙 Back', callback_data: 'withdraw' }
                        ]
                    ]
                }
            });
            break;


        case 'back_to_main':
            const mainMessage = `
🎰 YG Bingo Bot

How can I help you today?
      `;

            bot.editMessageText(mainMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🎮 Play Now', callback_data: 'play' },
                            { text: '�� Balance', callback_data: 'balance' }
                        ],
                        [
                            { text: '📊 Leaderboard', callback_data: 'leaderboard' },
                            { text: '👤 Profile', callback_data: 'profile' }
                        ],
                        [
                            { text: '💳 Deposit', callback_data: 'deposit' },
                            { text: '💸 Withdraw', callback_data: 'withdraw' }
                        ]
                    ]
                }
            });
            break;

        default:
            // Handle any other callback data if needed
            break;
    }

    // Answer callback query
    await safeAnswerCallback(query.id);
});

// Text message handlers for keyboard buttons
bot.onText(/🎮 Play/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Get user data with proper fallback handling
    const userData = await getUserDataWithFallback(userId, chatId, bot);
    if (!userData) return; // Error message already sent

    const uid = userData.uid;

    const playMessage = `
🎮 **Opening Game...**

Redirecting you to the web platform for the best gaming experience!
    `;

    bot.sendMessage(chatId, playMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🎮 Play Now', web_app: { url: gameUrl } }
                ],
                [
                    { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                ]
            ]
        }
    });
});

bot.onText(/💰 Balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Get user data with proper fallback handling
    const userData = await getUserDataWithFallback(userId, chatId, bot);
    if (!userData) return; // Error message already sent

    const balance = userData.wallet || 0;
    const uid = userData.uid;

    const balanceMessage = `
💰 Your Balance: ${balance} Birr

Recent transactions:
• No recent activity

🌐 Check detailed balance on web: ${gameUrl}?uid=${uid}
    `;

    bot.sendMessage(chatId, balanceMessage, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🌐 View on Web', url: `${gameUrl}?uid=${uid}` }
                ],
                [
                    { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                ]
            ]
        }
    });
});

bot.onText(/💳 Deposit/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Get user data with proper fallback handling
    const userData = await getUserDataWithFallback(userId, chatId, bot);
    if (!userData) return; // Error message already sent

    const depositMessage = `
💳 Choose Deposit Method:

Select your preferred payment method:
    `;

    bot.sendMessage(chatId, depositMessage, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📱 Telebirr', callback_data: 'deposit_telebirr' },
                    { text: '🏦 CBE Birr', callback_data: 'deposit_cbe' }
                ],
                [
                    { text: '❌ Cancel', callback_data: 'cancel_deposit' }
                ]
            ]
        }
    });
});

bot.onText(/💸 Withdraw/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Get user data with proper fallback handling
    const userData = await getUserDataWithFallback(userId, chatId, bot);
    if (!userData) return; // Error message already sent

    const uid = userData.uid;

    const withdrawMessage = `
💸 Withdraw Funds

Your balance: ${userData.wallet || 0} Birr

Choose withdrawal method:

🌐 For instant withdrawals, visit: ${gameUrl}?uid=${uid}
    `;

    bot.sendMessage(chatId, withdrawMessage, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🏦 CBE Birr', callback_data: 'withdraw_cbe' },
                    { text: '📱 Telebirr', callback_data: 'withdraw_telebirr' }
                ],
                [
                    { text: '🌐 Withdraw on Web', url: `${gameUrl}?uid=${uid}` }
                ],
                [
                    { text: '🔙 Back', callback_data: 'back_to_main' }
                ]
            ]
        }
    });
});


// New: message handler to capture Telebirr SMS when in deposit flow
async function getCurrentBalanceByTelegramId(telegramId) {
    const userDoc = await getUserDocByTelegramId(telegramId);
    if (!userDoc) return 0;
    const snap = await db.collection('users').doc(userDoc.id).get();
    return Number(snap.data()?.wallet || 0);
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!msg.text || /^\//.test(msg.text)) return;

    const state = userStates.get(userId);
    if (!state) return;

    // Handle withdrawal amount input
    if (state.waitingForWithdrawalAmount) {
        const amount = parseFloat(msg.text);
        if (isNaN(amount) || amount <= 0) {
            bot.sendMessage(chatId, '❌ Please enter a valid amount greater than 0.');
            return;
        }

        const userData = await getUserData(userId);

        // Validate wallet balance
        if (amount > userData?.wallet) {
            bot.sendMessage(chatId, `❌ Insufficient balance. Your balance: ${userData?.wallet || 0} Birr`);
            return;
        }

        // Ask for phone number
        userStates.set(userId, {
            waitingForWithdrawalPhone: true,
            withdrawalMethod: state.withdrawalMethod,
            withdrawalAmount: amount
        });

        bot.sendMessage(chatId, `📱 Please enter your ${state.withdrawalMethod === 'CBE Birr' ? 'CBE Birr account number' : 'Telebirr phone number'} for the withdrawal:`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Cancel', callback_data: 'cancel_withdrawal' }]
                ]
            }
        });
        return;
    }

    // Handle withdrawal phone/account input
    if (state.waitingForWithdrawalPhone) {
        const phone = msg.text.trim();
        if (!phone) {
            bot.sendMessage(chatId, '❌ Please enter a valid phone number or account number.');
            return;
        }

        try {
            const withdrawalId = await createWithdrawalRequest(
                userId,
                state.withdrawalAmount,
                state.withdrawalMethod,
                phone
            );

            userStates.delete(userId);

            // Get updated user data to show new balance
            const updatedUserData = await getUserData(userId);

            const successMessage = `
✅ Withdrawal Request Submitted!

Amount: ${state.withdrawalAmount} Birr
Method: ${state.withdrawalMethod}
Account/Phone: ${phone}
Request ID: ${withdrawalId}
New Balance: ${updatedUserData?.wallet || 0} Birr

Your request is now pending approval. You will be notified once it's processed.
            `;

            bot.sendMessage(chatId, successMessage, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                        ]
                    ]
                }
            });
        } catch (error) {
            console.error('Withdrawal request error:', error);
            bot.sendMessage(chatId, `❌ Error creating withdrawal request: ${error.message}`);
        }
        return;
    }

    // Handle Telebirr receipt (existing code)
    if (state.waitingForTelebirrReceipt) {
        // Notify user we are processing
        bot.sendMessage(chatId, '⏳ We are processing your Telebirr deposit. This will only take less than a minute...');

        try {
            const parsed = parseTelebirrReceipt(msg.text);
            console.log('[telebirr-debug] SMS parsed:', parsed);
            if (!parsed.transactionNumber || !parsed.receiptUrl || !parsed.maskedPhone) {
                const balance = await getCurrentBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `Could not parse your Telebirr message. Please paste the full message including the receipt link.\nYour current balance: ${balance} Birr`);
                return;
            }

            if (!maskedPhoneMatchesTarget(parsed.maskedPhone, TELEBIRR_TARGET_PHONE_INTL)) {
                const balance = await getCurrentBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `The destination phone number does not match ${TELEBIRR_TARGET_PHONE_LOCAL}. Please ensure you sent to the correct number.\nYour current balance: ${balance} Birr`);
                return;
            }

            // Check receiver name
            console.log('[telebirr-debug] checking receiver name:', parsed.receiverName, 'against target:', TELEBIRR_TARGET_NAME);
            if (!receiverNameMatchesTarget(parsed.receiverName, TELEBIRR_TARGET_NAME)) {
                const balance = await getCurrentBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `The receiver name "${parsed.receiverName}" does not match the expected recipient "${TELEBIRR_TARGET_NAME}". Please ensure you sent to the correct person.\nYour current balance: ${balance} Birr`);
                return;
            }

            const receiptCheck = await validateReceiptUrl(parsed.receiptUrl);
            if (!receiptCheck.ok) {
                const balance = await getCurrentBalanceByTelegramId(userId);
                const reason = receiptCheck.reason === 'invalid_receipt' ? 'The receipt link is invalid.' : 'Could not verify the receipt link.';
                bot.sendMessage(chatId, `${reason} Please double check and try again.\nYour current balance: ${balance} Birr`);
                return;
            }

            // Check credited party name from receipt (more secure than SMS)
            // Prioritize parsed receipt data over HTML extraction
            const receiptCreditedName = receiptCheck.parsed?.credited_party_name || receiptCheck.creditedPartyName;
            console.log('[telebirr-debug] checking receipt credited party name:', receiptCreditedName, 'against target:', TELEBIRR_TARGET_NAME);
            if (receiptCreditedName && !receiverNameMatchesTarget(receiptCreditedName, TELEBIRR_TARGET_NAME)) {
                const balance = await getCurrentBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `❌ Deposit rejected: The receipt shows the money was sent to "${receiptCreditedName}" instead of "${TELEBIRR_TARGET_NAME}". Please ensure you sent to the correct recipient.\nYour current balance: ${balance} Birr`);
                return;
            }

            const parsedReceipt = receiptCheck.parsed || null;
            let amountFromReceipt = parsedReceipt && (Number(parsedReceipt.settled_amount) || Number(parsedReceipt.total_amount)) || 0;
            if (!amountFromReceipt || amountFromReceipt <= 0) {
                if (receiptCheck.amountFallback && receiptCheck.amountFallback > 0) {
                    amountFromReceipt = receiptCheck.amountFallback;
                }
            }
            if (!amountFromReceipt || amountFromReceipt <= 0 || receiptCheck.statusOk === false) {
                const balance = await getCurrentBalanceByTelegramId(userId);
                const reason = receiptCheck.reason === 'invalid_receipt' ? 'The receipt link is invalid.' : 'Could not verify the receipt link.';
                bot.sendMessage(chatId, `${reason} Please double check and try again.\nYour current balance: ${balance} Birr`);
                return;
            }

            const finalAmount = amountFromReceipt;
            const txNumber = (parsedReceipt && parsedReceipt.receiptNo) || receiptCheck.receiptNo || parsed.transactionNumber;

            const userDoc = await getUserDocByTelegramId(userId);
            if (!userDoc) {
                const balance = await getCurrentBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `User not found. Please register first using /start.\nYour current balance: ${balance} Birr`);
                return;
            }

            const result = await creditDepositIfNew(userDoc.ref, txNumber, finalAmount, msg.text);
            const { credited, duplicate, balance, totalCredit } = result;

            if (duplicate) {
                bot.sendMessage(chatId, `This transaction (${txNumber}) was already used. Your balance is ${balance} Birr.`);
                return;
            }

            userStates.delete(userId);

            // Add leaderboard points for successful deposit (deposit amount * 5)
            try {
                const pointsResult = await addDepositLeaderboardPoints(userDoc.id, finalAmount);
                console.log(`Added ${pointsResult.pointsAdded} leaderboard points for user ${userDoc.id} deposit`);
            } catch (pointsError) {
                console.error('Error adding leaderboard points for deposit:', pointsError);
                // Don't fail the deposit if points update fails
            }

            bot.sendMessage(chatId, `✅ Telebirr deposit successful!\nAmount: ETB ${finalAmount.toFixed(2)}\nTx: ${txNumber}\nNew balance: ${balance} Birr`);
        } catch (error) {
            console.error('Telebirr deposit handling error:', error);
            const balance = await getCurrentBalanceByTelegramId(userId);
            bot.sendMessage(chatId, `An error occurred while processing your Telebirr deposit. Please try again.\nYour current balance: ${balance} Birr`);
        }
    }

    // Handle CBE Birr receipt
    if (state.waitingForCBEReceipt) {
        // Notify user we are processing
        bot.sendMessage(chatId, '⏳ We are processing your CBE Birr deposit. This will only take less than a minute...');

        try {
            const parsed = parseCBEBirrReceipt(msg.text);
            console.log('[cbe-debug] CBE SMS parsed:', parsed);

            if (!parsed.transactionNumber || !parsed.receiptUrl || !parsed.amount) {
                const balance = await getCurrentBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `Could not parse your CBE Birr message. Please paste the full message including the receipt link.\nYour current balance: ${balance} Birr`);
                return;
            }

            // Check receiver name from SMS first (early validation)
            if (parsed.receiverName && !receiverNameMatchesTarget(parsed.receiverName, CBE_TARGET_NAME)) {
                const balance = await getCurrentBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `❌ Deposit rejected: The receiver name "${parsed.receiverName}" does not match the expected recipient "${CBE_TARGET_NAME}". Please ensure you sent to the correct person.\nYour current balance: ${balance} Birr`);
                return;
            }

            // Validate the receipt URL
            const receiptCheck = await validateCBEReceiptUrl(parsed.receiptUrl, parsed.amount, parsed.transactionNumber);
            console.log('[cbe-debug] CBE receipt check:', receiptCheck);

            if (!receiptCheck.ok) {
                const balance = await getCurrentBalanceByTelegramId(userId);
                let reason = 'Could not verify the receipt link.';

                if (receiptCheck.reason === 'data_mismatch') {
                    // Check if it's specifically a name mismatch
                    const parsed = parseCBEBirrReceipt(msg.text);
                    if (parsed.receiverName && !receiverNameMatchesTarget(parsed.receiverName, CBE_TARGET_NAME)) {
                        reason = `The receiver name "${parsed.receiverName}" does not match the expected recipient "${CBE_TARGET_NAME}". Please ensure you sent to the correct person.`;
                    } else {
                        reason = 'The receipt data does not match the transaction.';
                    }
                }

                bot.sendMessage(chatId, `❌ Deposit rejected: ${reason} Please double check and try again.\nYour current balance: ${balance} Birr`);
                return;
            }

            // Additional security check: If PDF was successfully parsed, verify amount matches


            // ONLY use PDF amount - NO SMS fallback
            if (!receiptCheck.ok) {
                console.log('[cbe-debug] PDF validation failed:', receiptCheck.reason);
                bot.sendMessage(chatId, `❌ Deposit rejected: Could not verify the official receipt. Please ensure you're using the original CBE Birr message without any modifications.`);
                return;
            }

            if (!receiptCheck.parsed || !receiptCheck.parsed.amount) {
                console.log('[cbe-debug] Could not extract amount from PDF receipt');
                bot.sendMessage(chatId, `❌ Deposit rejected: Could not verify the transaction amount from the official receipt. Please try again with the original message.`);
                return;
            }

            const finalAmount = receiptCheck.parsed.amount;
            const txNumber = parsed.transactionNumber;
            console.log('[cbe-debug] Using PDF amount as authoritative source:', finalAmount);

            const userDoc = await getUserDocByTelegramId(userId);
            if (!userDoc) {
                const balance = await getCurrentBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `User not found. Please register first using /start.\nYour current balance: ${balance} Birr`);
                return;
            }

            const result = await creditDepositIfNew(userDoc.ref, txNumber, finalAmount, msg.text);
            const { credited, duplicate, balance, totalCredit } = result;
            console.log('[cbe-debug] CBE transaction result:', { credited, duplicate, balance, totalCredit });

            if (duplicate) {
                bot.sendMessage(chatId, `This CBE Birr transaction (${txNumber}) was already used. Your balance is ${balance} Birr.`);
                return;
            }

            userStates.delete(userId);

            // Add leaderboard points for successful deposit (deposit amount * 5)
            try {
                const pointsResult = await addDepositLeaderboardPoints(userDoc.id, finalAmount);
                console.log(`Added ${pointsResult.pointsAdded} leaderboard points for user ${userDoc.id} CBE deposit`);
            } catch (pointsError) {
                console.error('Error adding leaderboard points for CBE deposit:', pointsError);
                // Don't fail the deposit if points update fails
            }

            bot.sendMessage(chatId, `✅ CBE Birr deposit successful!\nAmount: ETB ${finalAmount.toFixed(2)}\nTx: ${txNumber}\nNew balance: ${balance} Birr`);
        } catch (error) {
            console.error('CBE Birr deposit handling error:', error);
            const balance = await getCurrentBalanceByTelegramId(userId);
            bot.sendMessage(chatId, `An error occurred while processing your CBE Birr deposit. Please try again.\nYour current balance: ${balance} Birr`);
        }
    }
});


// Handle errors
bot.on('error', (error) => {
    console.error('Bot error:', error);
});

bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

// Global error handlers to prevent crashes
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection in Main Bot:', reason);
    // Don't exit the process, just log the error
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception in Main Bot:', error);
    // Don't exit the process, just log the error
});

// Bot is ready to be started
// Note: Bot will be started by bot-manager.js when both bots are needed

// Start polling if this file is run directly (not required as module)
if (require.main === module) {
    console.log('🚀 Starting Main Bot directly...');
    bot.startPolling();
}

// Function to migrate existing dailyLeaderboard collection data to user documents
async function migrateLeaderboardData() {
    try {
        console.log('Starting leaderboard data migration...');

        const today = new Date().toISOString().split('T')[0];
        const leaderboardRef = db.collection('dailyLeaderboard').doc(today);
        const leaderboardDoc = await leaderboardRef.get();

        if (!leaderboardDoc.exists) {
            console.log('No daily leaderboard data to migrate for today');
            return;
        }

        const playersSnapshot = await leaderboardRef.collection('players').get();
        let migratedCount = 0;

        for (const playerDoc of playersSnapshot.docs) {
            const playerData = playerDoc.data();
            const uid = playerData.uid;

            if (uid) {
                const userRef = db.collection('users').doc(uid);
                const userDoc = await userRef.get();

                if (userDoc.exists) {
                    const userData = userDoc.data();
                    const currentPoints = userData.dailyLeaderboardPoints || 0;
                    const newPoints = currentPoints + (playerData.points || 0);

                    await userRef.update({
                        dailyLeaderboardPoints: newPoints,
                        dailyTotalGames: userData.dailyTotalGames || 0,
                        dailyTotalWins: userData.dailyTotalWins || 0,
                        dailyTotalWinnings: userData.dailyTotalWinnings || 0,
                        lastLeaderboardUpdate: admin.firestore.FieldValue.serverTimestamp()
                    });

                    migratedCount++;
                    console.log(`Migrated ${playerData.points} points for user ${uid}`);
                }
            }
        }

        console.log(`Migration completed. Migrated data for ${migratedCount} users.`);

    } catch (error) {
        console.error('Error during leaderboard migration:', error);
    }
}

// REMOVED: All announcement functionality has been completely disabled

// Export bot as default for backward compatibility with bot-manager.js
module.exports = bot;

// Also export migration function for manual use if needed
module.exports.migrateLeaderboardData = migrateLeaderboardData; 