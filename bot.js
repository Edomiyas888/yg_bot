const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const axios = require('axios');
const telebirrReceipt = require('./telebirr-receipt-master');
const { HttpsProxyAgent } = require('https-proxy-agent');
const https = require('https');
const pdfParse = require('pdf-parse');
let puppeteer = null;
let proxyChain = null;
const fs = require('fs');
const path = require('path');

// Load environment variables first
try { require('dotenv').config({ path: require('path').join(__dirname, '.env') }); } catch (_) { }

function mask(str, keepStart = 4, keepEnd = 2) {
    if (!str) return String(str);
    const s = String(str);
    if (s.length <= keepStart + keepEnd) return s;
    return s.slice(0, keepStart) + '***' + s.slice(-keepEnd);
}

console.log('[telebirr-debug] env loaded:', {
    HAS_BOT_TOKEN: !!process.env.BOT_TOKEN,
    HAS_FIREBASE_KEY: !!process.env.FIREBASE_PRIVATE_KEY,
    HTTPS_PROXY_SET: !!process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
});

// Initialize Firebase Admin SDK
const serviceAccount = {
    "type": "service_account",
    "project_id": "geno-831c6",
    "private_key_id": process.env.FIREBASE_PRIVATE_KEY_ID,
    "private_key": (() => {
        let privateKey = process.env.FIREBASE_PRIVATE_KEY;
        if (!privateKey) return undefined;

        // Remove quotes if they exist
        if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
            privateKey = privateKey.slice(1, -1);
        }

        // Replace literal \n with actual newlines
        privateKey = privateKey.replace(/\\n/g, '\n');

        // Validate PEM format
        if (!privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
            console.error('❌ Invalid private key format');
            return undefined;
        }

        return privateKey;
    })(),
    "client_email": process.env.FIREBASE_CLIENT_EMAIL,
    "client_id": process.env.FIREBASE_CLIENT_ID,
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
    "client_x509_cert_url": process.env.FIREBASE_CLIENT_CERT_URL
};

// Initialize Firebase Admin
if (!admin.apps.length) {
    try {
        if (serviceAccount.private_key && serviceAccount.client_email) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: "https://geno-831c6-default-rtdb.firebaseio.com/"
            });
            console.log('[telebirr-debug] Firebase initialized with service account');
        } else {
            // Fallback to default credentials
            admin.initializeApp({
                credential: admin.credential.applicationDefault(),
                databaseURL: "https://geno-831c6-default-rtdb.firebaseio.com/"
            });
            console.log('[telebirr-debug] Firebase initialized with default credentials');
        }
    } catch (error) {
        console.error('[telebirr-debug] Firebase initialization error:', error.message);
        // Try to initialize with default credentials as last resort
        try {
            admin.initializeApp({
                credential: admin.credential.applicationDefault(),
                databaseURL: "https://geno-831c6-default-rtdb.firebaseio.com/"
            });
            console.log('[telebirr-debug] Firebase initialized with default credentials (fallback)');
        } catch (fallbackError) {
            console.error('[telebirr-debug] Firebase fallback initialization failed:', fallbackError.message);
        }
    }
}

const db = admin.firestore();

// In-memory conversation state per user
const userStates = new Map();

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
    // Expect format like 2519****3152; validate startsWith 2519 and endsWith last 4 digits
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

    // Proxy support
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const noProxy = (process.env.NO_PROXY || '').split(',').map(s => s.trim()).filter(Boolean);
    const hostname = (() => { try { return new URL(urlString).hostname; } catch { return ''; } })();
    const skipProxy = noProxy.some(domain => hostname.endsWith(domain));
    if (proxyUrl && !skipProxy) {
        options.httpsAgent = new HttpsProxyAgent(proxyUrl);
        console.log('[telebirr-debug] using proxy for', hostname, 'agent set');
    } else {
        console.log('[telebirr-debug] not using proxy for', hostname, 'skipProxy=', skipProxy);
    }

    // Custom CA support
    if (process.env.HTTPS_CA_CERT) {
        options.httpsAgent = new https.Agent({
            ...(options.httpsAgent ? { ...options.httpsAgent.options } : {}),
            ca: process.env.HTTPS_CA_CERT,
            rejectUnauthorized: true
        });
        console.log('[telebirr-debug] custom CA set');
    }

    // Optional insecure flag (last resort)
    if (process.env.RECEIPT_ALLOW_INSECURE === '1') {
        options.httpsAgent = new https.Agent({
            ...(options.httpsAgent ? { ...options.httpsAgent.options } : {}),
            rejectUnauthorized: false
        });
        console.log('[telebirr-debug] TLS validation disabled for receipt fetch');
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

function resolveChromeExecutablePath() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
    const base = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
    try {
        const chromeDir = path.join(base, 'chrome');
        const entries = fs.readdirSync(chromeDir).filter(n => n.startsWith('linux-'));
        if (entries.length === 0) return undefined;
        // pick the latest (sorted descending)
        entries.sort().reverse();
        const candidate = path.join(chromeDir, entries[0], 'chrome-linux64', 'chrome');
        if (fs.existsSync(candidate)) return candidate;
    } catch (_) { }
    return undefined;
}

async function fetchReceiptHtmlWithPuppeteer(url) {
    try {
        if (!puppeteer) puppeteer = require('puppeteer');
        if (!proxyChain) proxyChain = require('proxy-chain');
        const proxyUrlRaw = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
        const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
        ];
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
            } catch (e) {
                console.log('[telebirr-debug] proxy parse error:', e && e.message);
            }
        }
        const execPath = resolveChromeExecutablePath();
        console.log('[telebirr-debug] puppeteer launching with args:', launchArgs, 'execPath:', execPath || '(default)');
        const browser = await puppeteer.launch({ args: launchArgs, headless: 'new', executablePath: execPath });
        const page = await browser.newPage();
        // If we used anonymized proxy, do not set page.authenticate (creds handled by proxy-chain)
        if (proxyAuth && !anonymizedProxyUrl) {
            try { await page.authenticate(proxyAuth); } catch (e) { console.log('[telebirr-debug] page.authenticate error:', e && e.message); }
        }
        await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1');
        await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        });
        console.log('[telebirr-debug] puppeteer goto:', url);
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log('[telebirr-debug] puppeteer status:', resp && resp.status());
        try { await new Promise(r => setTimeout(r, 1500)); } catch (_) { }
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
        console.log('[telebirr-debug] fetching receipt URL:', url);
        let htmlBody = null;
        try {
            const { body, finalUrl } = await fetchReceiptHtmlWithRedirects(url);
            console.log('[telebirr-debug] final URL:', finalUrl);
            htmlBody = body;
        } catch (e) {
            console.log('[telebirr-debug] redirect fetch failed:', e && e.message, '→ trying puppeteer');
        }
        if (!htmlBody) {
            htmlBody = await fetchReceiptHtmlWithPuppeteer(url);
        }
        if (!htmlBody) {
            throw new Error('no_html');
        }
        console.log('[telebirr-debug] receipt body snippet:', String(htmlBody).slice(0, 600));
        // Reject ONLY if the page shows the explicit Telebirr error text
        if (/This request is not correct/i.test(htmlBody)) {
            console.log('[telebirr-debug] telebirr page indicates invalid request');
            return { ok: false, reason: 'invalid_receipt' };
        }

        // Parse and verify via telebirr-receipt parser
        let parsedReceipt = null;
        try {
            parsedReceipt = telebirrReceipt.utils.parseFromHTML(htmlBody);
            console.log('[telebirr-debug] parsed receipt data:', {
                credited_party_name: parsedReceipt?.credited_party_name,
                credited_party_acc_no: parsedReceipt?.credited_party_acc_no,
                to: parsedReceipt?.to,
                from: parsedReceipt?.from,
                settled_amount: parsedReceipt?.settled_amount,
                total_amount: parsedReceipt?.total_amount,
                receiptNo: parsedReceipt?.receiptNo,
                transaction_status: parsedReceipt?.transaction_status,
            });
            // Prefer credited_party_acc_no or to; normalize to digits
            const creditedAcc = String(parsedReceipt?.credited_party_acc_no || '').replace(/\D/g, '');
            const creditedMasked = String(parsedReceipt?.to || '').replace(/\D/g, '');
            const target = TELEBIRR_TARGET_PHONE_INTL.replace(/\D/g, '');
            const last4Ok = creditedAcc.endsWith(target.slice(-4)) || creditedMasked.endsWith(target.slice(-4));
            const starts2519 = creditedAcc.startsWith('2519') || creditedMasked.startsWith('2519');
            if (!(last4Ok && starts2519)) {
                // Still ok; upstream SMS maskedPhone check will guard
                console.log('[telebirr-debug] credited check relaxed; last4Ok=', last4Ok, 'starts2519=', starts2519);
            }
        } catch (_) {
            // If parse fails, still treat as ok per relaxed rule
            console.log('[telebirr-debug] parseFromHTML failed; will use fallbacks');
        }

        // Fallback extraction for amount and status
        let amountFallback = null, statusOk = null, receiptNo = null, creditedPartyName = null;
        try {
            const fallback = extractAmountAndStatusFallback(htmlBody);
            amountFallback = fallback.amountFallback;
            statusOk = fallback.statusOk;
            receiptNo = fallback.receiptNo;
            creditedPartyName = fallback.creditedPartyName;
            console.log('[telebirr-debug] fallback parse:', { amountFallback, statusOk, receiptNo, creditedPartyName });
        } catch (e) {
            console.log('[telebirr-debug] fallback extractor error:', e && e.message);
        }

        return { ok: true, parsed: parsedReceipt, amountFallback, statusOk, receiptNo, creditedPartyName };
    } catch (error) {
        console.log('[telebirr-debug] fetch error:', error && (error.message || error.code), 'response status:', error && error.response && error.response.status);
        // Per requirement, do not reject on network errors
        return { ok: true, parsed: null, amountFallback: null, statusOk: null, receiptNo: null, creditedPartyName: null };
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

            // Amount patterns for CBE Birr receipts - based on actual PDF structure
            const amountMatch = textContent.match(/Amount\s*([\d.,]+)/i) ||
                textContent.match(/Total\s*([\d.,]+)/i) ||
                textContent.match(/Paid\s*amount\s*([\d.,]+)/i) ||
                textContent.match(/Amount\s*CHO\d+[A-Z0-9]+\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}\s*([\d.,]+)/i) ||
                textContent.match(/([\d.,]+)\s*ETB/gi) ||
                textContent.match(/([\d.,]+)\s*Birr/gi) ||
                // New patterns based on actual PDF structure
                textContent.match(/CHU\d+[A-Z0-9]+\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}([\d.,]+)/i) ||
                textContent.match(/Transaction\s*Date\s*Amount\s*[\s\S]*?(\d+\.\d{2})/i) ||
                textContent.match(/(\d+\.\d{2})\s*Paid\s*amount/i) ||
                // Additional patterns for the specific format in the PDF
                textContent.match(/CHU\d+[A-Z0-9]+\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}(\d+\.\d{2})/i) ||
                textContent.match(/(\d+\.\d{2})\s*Paid\s*amount/i) ||
                textContent.match(/Total\s*Paid\s*Amount\s*(\d+\.\d{2})/i);

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
                textContent.match(/(\d{10,12})\s*-\s*([^\n]+)/i); // Phone - Name format

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
                const transactionDetailsMatch = textContent.match(/Transaction\s*Details[\s\S]*?(\d+\.\d{2})/i);
                if (transactionDetailsMatch) {
                    extractedAmount = Number(transactionDetailsMatch[1]);
                    console.log('[cbe-debug] fallback transactionDetailsMatch:', transactionDetailsMatch);
                }
            }

            // Additional fallback: Look for any number with .00 format in the transaction section
            if (!extractedAmount || extractedAmount <= 0) {
                const allAmountMatches = textContent.match(/(\d+\.\d{2})/g);
                console.log('[cbe-debug] all amount matches found:', allAmountMatches);
                if (allAmountMatches && allAmountMatches.length > 0) {
                    // Filter out 0.00 values and take the first non-zero amount
                    const validAmounts = allAmountMatches
                        .map(match => Number(match))
                        .filter(amount => amount > 0);
                    if (validAmounts.length > 0) {
                        extractedAmount = validAmounts[0];
                        console.log('[cbe-debug] using fallback amount from all matches:', extractedAmount);
                    }
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

                if (!amountMatches || !txMatches) {
                    console.log('[cbe-debug] extracted data does not match expected values');
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
    const snap = await db.collection('users').where('telegramId', '==', String(telegramId)).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return { id: doc.id, ref: doc.ref, data: doc.data() };
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
        const currentWithdrawable = Number(userData.withdrawable || 0);
        const isFirstDeposit = !userData.firstDepositMade;

        // No cashback - just credit the deposit amount
        const totalCredit = Number(amount);
        const newBalance = currentBalance + totalCredit;
        // Withdrawable balance remains unchanged - only winnings are withdrawable
        const newWithdrawable = currentWithdrawable;

        t.set(txDocRef, {
            type: 'deposit',
            provider: rawMessage.includes('CBE') ? 'cbe_birr' : 'telebirr',
            amount: Number(amount),
            cashbackAmount: 0, // No cashback
            totalCredit: totalCredit,
            isFirstDeposit: isFirstDeposit,
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
            amount: Number(amount),
            cashbackAmount: 0, // No cashback
            totalCredit: totalCredit,
            isFirstDeposit: isFirstDeposit,
            transactionNumber: txNumber,
            status: 'credited',
            message: rawMessage,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Update user wallet, withdrawable balance, and mark first deposit as made
        t.update(userRef, {
            wallet: newBalance,
            withdrawable: newWithdrawable,
            firstDepositMade: true
        });

        return {
            credited: true,
            balance: newBalance,
            withdrawable: newWithdrawable,
            isFirstDeposit: isFirstDeposit,
            cashbackAmount: 0,
            totalCredit: totalCredit
        };
    });
}

function sendDepositInstructions(bot, chatId) {
    const instructions = `
💳 Deposit via Telebirr

1) Open Telebirr and send your desired amount to:
• Name: Yonatan Abdulkadir
• Phone: ${TELEBIRR_TARGET_PHONE_LOCAL}

2) After payment, copy the full Telebirr message and paste it here.

Example message:
"Dear Kaleb\nYou have transferred ETB 20.00 to Yonatan Abdulkadir (2519****3794) on 11/08/2025 21:30:07. Your transaction number is CHB657ZKOA. ... To download your payment information please click this link: https://transactioninfo.ethiotelecom.et/receipt/CHB657ZKOA.\n\nThank you for using telebirr\nEthio telecom"

We will verify:
• Correct destination phone number
• Receipt link is valid
• Transaction not used before`;

    bot.sendMessage(chatId, instructions, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '❌ Cancel', callback_data: 'cancel_deposit' }]
            ]
        }
    });
}

function sendCBEDepositInstructions(bot, chatId) {
    const instructions = `
💳 Deposit via CBE Birr

1) Open CBE Birr app and send your desired amount to:
• Name: Yonatan Abdulkadir
• Phone: ${CBE_TARGET_PHONE_LOCAL}

2) After payment, copy the full CBE Birr message and paste it here.

Example message:
"Dear KALEAB, you have sent 10.00Br. to Mohammed Seid on 24/08/25 21:40,Txn ID CHO1SN9RQX. Your CBE Birr account balance is 514.77Br.Thank you! For invoice https://cbepay1.cbe.com.et/aureceipt?TID=CHO1SN9RQX&PH=251913503182"

We will verify:
• Correct destination phone number
• Receipt link is valid
• Transaction not used before`;

    bot.sendMessage(chatId, instructions, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: '❌ Cancel', callback_data: 'cancel_deposit' }]
            ]
        }
    });
}

// Load environment variables - try config file first, then use process.env directly
let configLoaded = false;
try {
    require('dotenv').config({ path: require('path').join(__dirname, '.env') });
    configLoaded = true;
    console.log('📁 Loaded configuration from .env file');
} catch (error) {
    console.log('📁 Using environment variables (deployment mode)');
}

// Bot configuration with validation
const token = process.env.BOT_TOKEN;
const gameUrl = process.env.GAME_URL || 'https://ygbingo.netlify.app';

// Debug information
console.log('🔍 Debug Information:');
console.log('Config file loaded:', configLoaded);
console.log('Token exists:', !!token);
console.log('Token value:', token ? token.substring(0, 10) + '...' + token.substring(token.length - 4) : 'undefined');
console.log('Game URL:', gameUrl);
console.log('All env vars with BOT:', Object.keys(process.env).filter(key => key.includes('BOT')));

// Validate bot token
if (!token || token === 'your_telegram_bot_token_here') {
    console.error('❌ Error: Bot token not found or invalid!');
    console.error('Please check your .env file and ensure BOT_TOKEN is set correctly.');
    console.error('Current token value:', token);
    console.error('Available environment variables:', Object.keys(process.env).filter(key => key.includes('BOT')));

    // For deployment, provide specific instructions
    if (!configLoaded) {
        console.error('\n🚀 DEPLOYMENT SETUP:');
        console.error('Set these environment variables in your deployment platform (never commit real values):');
        console.error('BOT_TOKEN=your_telegram_bot_token_here');
        console.error('GAME_URL=https://ygbingo.netlify.app');
        console.error('BOT_USERNAME=your_bot_username_here');
    }

    process.exit(1);
}

// Validate game URL
if (!gameUrl || gameUrl === 'https://your-domain.com/webhook') {
    console.warn('⚠️  Warning: Game URL not configured properly');
    console.warn('Please update GAME_URL in .env file');
}

console.log('✅ Bot token loaded successfully');
console.log('✅ Game URL:', gameUrl);

const bot = new TelegramBot(token, { polling: true });

// Store user data (in production, use a database)
const userData = new Map();

// Function to check if user is registered
async function isUserRegistered(userId) {
    try {
        // Check if user is registered by telegramId
        const userDoc = await db.collection('users').where('telegramId', '==', userId.toString()).get();
        return !userDoc.empty;
    } catch (error) {
        console.error('Error checking user registration:', error);
        return false;
    }
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
        const normalizedPhone = phone.replace(/\s+/g, '').replace(/-/g, '');
        const userDoc = await db.collection('users').where('phone', '==', normalizedPhone).get();
        if (!userDoc.empty) {
            const userData = userDoc.docs[0].data();
            return {
                ...userData,
                uid: userDoc.docs[0].id
            };
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
                [
                    { text: '🌐 Play on Web' }
                ]
            ],
            resize_keyboard: true,
            persistent: true
        }
    });
}

// Function to get user data from Firebase
async function getUserData(userId) {
    try {
        // First try to find user by telegramId
        let userDoc = await db.collection('users').where('telegramId', '==', userId.toString()).get();

        if (!userDoc.empty) {
            return userDoc.docs[0].data();
        }

        // If not found by telegramId, try to find by phone number from contact
        // This would require the contact to be passed to this function
        return null;
    } catch (error) {
        console.error('Error getting user data:', error);
        return null;
    }
}

// Function to link existing web user to Telegram account
async function linkWebUserToTelegram(userId, phone) {
    try {
        const normalizedPhoneNumber = phone.replace(/\s+/g, '').replace(/-/g, '');
        const userDoc = await db.collection('users').where('phone', '==', normalizedPhoneNumber).get();

        if (!userDoc.empty) {
            const userData = userDoc.docs[0].data();
            const userRef = userDoc.docs[0].ref;

            // Update the existing user to include telegramId
            await userRef.update({
                telegramId: userId.toString()
            });

            return userRef.id;
        }
        return null;
    } catch (error) {
        console.error('Error linking web user to Telegram:', error);
        return null;
    }
}

// Function to create user in Firebase
async function createUser(userId, userName, phone, referralCode = null) {
    try {
        // Check if phone number is already registered
        const phoneExists = await isPhoneRegistered(phone);
        if (phoneExists) {
            throw new Error('Phone number already registered');
        }

        // Normalize the phone number (e.g., remove spaces, dashes) - same as web app
        const normalizedPhoneNumber = phone.replace(/\s+/g, '').replace(/-/g, '');

        // Check if referral code is valid and not already used by this user
        let referredBy = null;
        if (referralCode) {
            const inviterDoc = await db.collection('users').doc(referralCode).get();
            if (inviterDoc.exists) {
                // Check if this user has already been awarded for this referral
                const existingUser = await db.collection('users').where('phone', '==', normalizedPhoneNumber).get();
                if (!existingUser.empty) {
                    // User already exists, check if they already have a referral bonus
                    const existingUserData = existingUser.docs[0].data();
                    if (existingUserData.referredBy && existingUserData.referralBonusAwarded) {
                        console.log('User already received referral bonus, skipping duplicate award');
                    } else {
                        referredBy = referralCode;
                    }
                } else {
                    // New user, can award referral bonus
                    referredBy = referralCode;
                }
            }
        }

        // Calculate registration bonus (10% of a base amount, let's say 100 Birr = 10 Birr bonus)
        const registrationBonus = 10; // 10 Birr registration bonus

        const userRef = await db.collection('users').add({
            userName: userName, // Match web app field name
            phone: normalizedPhoneNumber, // Match web app field name and normalization
            telegramId: userId.toString(), // Additional field for Telegram users
            wallet: registrationBonus, // Start with 10 Birr registration bonus
            withdrawable: 0, // Track withdrawable balance
            isAdult: true,
            agreeTerms: true,
            referredBy: referredBy, // Add referral tracking
            referralCount: 0, // Initialize referral count
            referralBonusAwarded: false, // Track if referral bonus was awarded
            firstDepositMade: false, // Track if user has made their first deposit
            registrationBonusAwarded: true, // Track that registration bonus was awarded
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const newUserId = userRef.id;

        // Add registration bonus transaction
        await userRef.collection('transactions').add({
            type: 'registration_bonus',
            amount: registrationBonus,
            description: 'Welcome bonus for new registration',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Handle referral bonus if applicable
        if (referredBy) {
            try {
                await handleReferralBonus(referredBy, newUserId, normalizedPhoneNumber);
            } catch (error) {
                console.error('Error handling referral bonus:', error);
                // Don't fail registration if referral bonus fails
            }
        }

        return newUserId;
    } catch (error) {
        console.error('Error creating user:', error);
        throw error;
    }
}

async function getCurrentBalanceByTelegramId(telegramId) {
    const userDoc = await getUserDocByTelegramId(telegramId);
    if (!userDoc) return 0;
    const snap = await userDoc.ref.get();
    return Number(snap.data()?.wallet || 0);
}

// Function to create withdrawal request
async function createWithdrawalRequest(userId, amount, method, phone) {
    try {
        const userData = await getUserData(userId);
        if (!userData) {
            throw new Error('User not found');
        }

        // Check withdrawable balance instead of total wallet balance
        const withdrawableBalance = Number(userData.withdrawable || 0);
        if (withdrawableBalance < amount) {
            throw new Error('Insufficient withdrawable balance');
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
            const currentWithdrawable = Number(currentUserData.withdrawable || 0);

            if (currentWithdrawable < amount) {
                throw new Error('Insufficient withdrawable balance');
            }

            const newBalance = currentBalance - Number(amount);
            const newWithdrawable = currentWithdrawable - Number(amount);

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

            // Update user balance and withdrawable balance
            transaction.update(userRef, {
                wallet: newBalance,
                withdrawable: newWithdrawable,
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

            return { withdrawalId: withdrawalRef.id, newBalance, newWithdrawable };
        });

        return result.withdrawalId;
    } catch (error) {
        console.error('Error creating withdrawal request:', error);
        throw error;
    }
}

// Function to send announcement to all users (can be called by service worker)
async function sendAnnouncementToAllUsers(message, imageUrl = null) {
    try {
        // Get all users
        const usersSnapshot = await db.collection('users').get();
        const users = usersSnapshot.docs;

        let successCount = 0;
        let errorCount = 0;

        for (const userDoc of users) {
            const userData = userDoc.data();
            if (userData.telegramId) {
                try {
                    if (imageUrl) {
                        // Send photo with caption
                        await bot.sendPhoto(userData.telegramId, imageUrl, {
                            caption: `📢 **ANNOUNCEMENT**\n\n${message}`,
                            parse_mode: 'Markdown'
                        });
                    } else {
                        // Send text only
                        await bot.sendMessage(userData.telegramId, `📢 **ANNOUNCEMENT**\n\n${message}`, {
                            parse_mode: 'Markdown'
                        });
                    }
                    successCount++;
                } catch (error) {
                    console.error(`Failed to send announcement to ${userData.telegramId}:`, error);
                    errorCount++;
                }
            }
        }

        return { successCount, errorCount };
    } catch (error) {
        console.error('Error sending announcements:', error);
        throw error;
    }
}

// Function to handle referral bonus
async function handleReferralBonus(inviterId, newUserId, phoneNumber) {
    try {
        // Check if this referral has already been processed
        const referralTrackingRef = db.collection('referralTracking').doc(`${inviterId}_${phoneNumber}`);
        const existingTracking = await referralTrackingRef.get();

        if (existingTracking.exists) {
            console.log(`Referral bonus already awarded for inviter ${inviterId} and phone ${phoneNumber}`);
            return null; // Already processed
        }

        // Get inviter data
        const inviterDoc = await db.collection('users').doc(inviterId).get();
        if (!inviterDoc.exists) {
            throw new Error('Inviter not found');
        }

        const inviterData = inviterDoc.data();
        const currentBalance = Number(inviterData.wallet || 0);
        const newBalance = currentBalance + 10; // 10 birr bonus

        // Update inviter's balance
        await db.collection('users').doc(inviterId).update({
            wallet: newBalance,
            referralCount: (inviterData.referralCount || 0) + 1,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Add referral transaction for inviter
        await db.collection('users').doc(inviterId).collection('transactions').add({
            type: 'referral_bonus',
            amount: 10,
            description: `Referral bonus for user ${newUserId} (${phoneNumber})`,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Mark the new user as having received referral bonus
        await db.collection('users').doc(newUserId).update({
            referralBonusAwarded: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Track this referral to prevent duplicates
        await referralTrackingRef.set({
            inviterId: inviterId,
            referredPhone: phoneNumber,
            referredUserId: newUserId,
            bonusAmount: 10,
            awardedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Send notification to inviter
        if (inviterData.telegramId) {
            try {
                await bot.sendMessage(inviterData.telegramId,
                    `🎉 **Referral Bonus!**\n\nYou earned 10 Birr for referring a new user!\n\nNew balance: ${newBalance} Birr`, {
                    parse_mode: 'Markdown'
                });
            } catch (error) {
                console.error('Failed to send referral notification:', error);
            }
        }

        return newBalance;
    } catch (error) {
        console.error('Error handling referral bonus:', error);
        throw error;
    }
}

// Function to process pending announcements (can be called periodically by service worker)
async function processPendingAnnouncements() {
    try {
        const announcementsRef = db.collection('announcements');
        const pendingQuery = announcementsRef.where('status', '==', 'pending');
        const pendingSnapshot = await pendingQuery.get();

        for (const doc of pendingSnapshot.docs) {
            const announcement = doc.data();
            try {
                const result = await sendAnnouncementToAllUsers(announcement.message, announcement.imageUrl);

                // Update status to sent
                await doc.ref.update({
                    status: 'sent',
                    processedAt: admin.firestore.FieldValue.serverTimestamp(),
                    result: result
                });

                console.log(`Announcement ${doc.id} sent successfully:`, result);
            } catch (error) {
                console.error(`Failed to process announcement ${doc.id}:`, error);

                // Update status to failed
                await doc.ref.update({
                    status: 'failed',
                    error: error.message,
                    processedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        }
    } catch (error) {
        console.error('Error processing pending announcements:', error);
    }
}

// Bot commands
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name;

    // Check if user is registered
    const isRegistered = await isUserRegistered(userId);

    if (!isRegistered) {
        const welcomeMessage = `
🎰 Welcome to Genius Bingo Bot, ${userName}! 🏆

I'm here to help you with your bingo gaming experience.

To get started, please register with your phone number!
💰 Get 10 Birr welcome bonus on registration!
🎯 Earn 10 Birr for each friend you refer!
  `;

        bot.sendMessage(chatId, welcomeMessage, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: '📱 Register', request_contact: true }]
                ],
                resize_keyboard: true,
                one_time_keyboard: true
            }
        });
    } else {
        // User is already registered
        const userData = await getUserData(userId);
        const welcomeMessage = `
🎰 Welcome back to Genius Bingo Bot, ${userName}! 🏆

Your balance: ${userData?.wallet || 0} Birr

Available commands:
/start - Show this welcome message
/help - Show help information
/play - Start a new game
/balance - Check your balance
/deposit - Add funds to your account
/withdraw - Withdraw your winnings
/referral - Get your referral link
/leaderboard - View top players
/profile - View your profile
/web - Play on web platform

How can I help you today?
  `;

        bot.sendMessage(chatId, welcomeMessage, {
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
    }
});

// Handle contact sharing for registration
bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name;
    const contact = msg.contact;

    // Check if this is the user's own contact
    if (contact.user_id === userId) {
        try {
            // First check if a user already exists with this phone number (from web registration)
            const linkedUser = await linkWebUserToTelegram(userId, contact.phone_number);

            if (linkedUser) {
                // User already exists, link them to Telegram
                const userData = await getUserData(userId);
                const successMessage = `
✅ Account Linked Successfully!

Welcome back to Genius Bingo, ${userName}!
Your existing account has been linked to Telegram.

Your balance: ${userData?.wallet || 0} Birr
Your UID: ${linkedUser}

You can now use both web and Telegram platforms!
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
                                { text: '🌐 Play on Web' }
                            ]
                        ],
                        resize_keyboard: true,
                        persistent: true
                    }
                });
                return;
            }

            // Check if phone number is already registered by another Telegram user
            const existingUser = await getUserByPhone(contact.phone_number);
            if (existingUser) {
                // User is already registered, show their profile
                await showUserProfile(chatId, existingUser);
                return;
            }

            // Create new user in Firebase
            const uid = await createUser(userId, userName, contact.phone_number);

            const successMessage = `
✅ Registration Successful!

Welcome to Genius Bingo, ${userName}!
Your account has been created successfully.

Your UID: ${uid}

💰 Welcome bonus: 10 Birr credited to your account!
🎯 Share your referral link to earn 10 Birr per referral!

You can now start playing!
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
                            { text: '🌐 Play on Web' }
                        ]
                    ],
                    resize_keyboard: true,
                    persistent: true
                }
            });
        } catch (error) {
            console.error('Registration error:', error);

            // Check if the error is due to phone already being registered
            if (error.message === 'Phone number already registered') {
                const existingUser = await getUserByPhone(contact.phone_number);
                if (existingUser) {
                    await showUserProfile(chatId, existingUser);
                    return;
                }
            }

            bot.sendMessage(chatId, '❌ Registration failed. Please try again later.');
        }
    } else {
        bot.sendMessage(chatId, '❌ Please share your own phone number for registration.');
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

    // Get user data from Firebase
    const userData = await getUserData(userId);
    const uid = userData?.uid || '';

    const webMessage = `
🌐 Play Genius Bingo on Web

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
🤖 Genius Bingo Bot Help

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

    // Get user data from Firebase
    const userData = await getUserData(userId);
    const uid = userData?.uid || '';

    const playMessage = `
🎮 Choose Your Platform:

Where would you like to play?
  `;

    bot.sendMessage(chatId, playMessage, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📱 Play on Telegram', callback_data: 'play_telegram' },
                    { text: '🌐 Play on Web', url: `${gameUrl}?uid=${uid}` }
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

    // Get user data from Firebase
    const userData = await getUserData(userId);
    const balance = userData?.wallet || 0;
    const uid = userData?.uid || '';

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

    // Get user data from Firebase
    const userData = await getUserData(userId);
    const uid = userData?.uid || '';

    switch (data) {
        case 'play':
            const playMessage = `
🎮 Choose Your Platform:

Where would you like to play?
      `;

            bot.editMessageText(playMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📱 Play on Telegram', callback_data: 'play_telegram' },
                            { text: '🌐 Play on Web', callback_data: 'play_web_game' }
                        ],
                        [
                            { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                        ]
                    ]
                }
            });
            break;

        case 'play_telegram':
            const telegramPlayMessage = `
🎮 Choose Your Stake Amount:

Select how much you want to bet:
      `;

            bot.editMessageText(telegramPlayMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '10 Birr', callback_data: 'stake_10' },
                            { text: '20 Birr', callback_data: 'stake_20' }
                        ],
                        [
                            { text: '50 Birr', callback_data: 'stake_50' },
                            { text: '100 Birr', callback_data: 'stake_100' }
                        ],
                        [
                            { text: '🔙 Back', callback_data: 'play' }
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

        case 'balance':
            const totalBalance = userData?.wallet || 0;
            const withdrawableBalance = userData?.withdrawable || 0;
            const balanceMessage = `
💰 Your Balances:

💳 Total Balance: ${totalBalance} Birr
💸 Withdrawable Balance: ${withdrawableBalance} Birr

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
                            { text: '🌐 View on Web', url: `${gameUrl}?uid=${uid}` }
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
                            { text: '🌐 View Full Leaderboard', url: `${gameUrl}?uid=${uid}` }
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
• Total Balance: ${userData?.wallet || 0} Birr
• Withdrawable Balance: ${userData?.withdrawable || 0} Birr

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
                            { text: '🌐 View Full Profile', url: `${gameUrl}?uid=${uid}` }
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

        case 'copy_referral_link':
            const copyReferralLink = `${gameUrl}?ref=${userData?.uid || userId}`;
            bot.answerCallbackQuery(query.id, {
                text: 'Referral link copied to clipboard!',
                show_alert: true
            });
            break;

        case 'share_referral_link':
            const shareLink = `${gameUrl}?ref=${userData?.uid || userId}`;
            const shareMessage = `🎯 Join Genius Bingo Bot and get 10 Birr bonus!\n\n🔗 ${shareLink}\n\n💰 Earn money playing bingo games!`;
            bot.editMessageText(shareMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown'
            });
            break;

        case 'referral':
            const referralLink = `${gameUrl}?ref=${userData?.uid || userId}`;
            const referralMessage = `
🎯 **Your Referral Link**

Share this link with your friends and earn 10 Birr for each successful registration!

🔗 **Your Link:**
\`${referralLink}\`

💰 **How it works:**
• Share your link with friends
• When they register using your link
• Both you and your friend get 10 Birr bonus!

📊 **Your Stats:**
• Total Referrals: ${userData?.referralCount || 0}
• Total Earned: ${(userData?.referralCount || 0) * 10} Birr

💡 **Tips:**
• Share on social media
• Send to friends and family
• Post in groups and channels
            `;

            bot.editMessageText(referralMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔗 Copy Link', callback_data: 'copy_referral_link' },
                            { text: '📤 Share Link', callback_data: 'share_referral_link' }
                        ],
                        [
                            { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                        ]
                    ]
                }
            });
            break;

        case 'withdraw':
            const withdrawMessage = `
💸 Withdraw Funds

Your total balance: ${userData?.wallet || 0} Birr
Your withdrawable balance: ${userData?.withdrawable || 0} Birr

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
                            { text: '🌐 Withdraw on Web', url: `${gameUrl}?uid=${uid}` }
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

Your total balance: ${userData?.wallet || 0} Birr
Your withdrawable balance: ${userData?.withdrawable || 0} Birr

Please enter the amount you want to withdraw (max: ${userData?.withdrawable || 0} Birr):
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
🎰 Genius Bingo Bot

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
                            { text: '💰 Balance', callback_data: 'balance' }
                        ],
                        [
                            { text: '📊 Leaderboard', callback_data: 'leaderboard' },
                            { text: '👤 Profile', callback_data: 'profile' }
                        ],
                        [
                            { text: '💳 Deposit', callback_data: 'deposit' },
                            { text: '💸 Withdraw', callback_data: 'withdraw' }
                        ],
                        [
                            { text: '🌐 Play on Web', url: `${gameUrl}?uid=${uid}` }
                        ]
                    ]
                }
            });
            break;

        default:
            if (data.startsWith('stake_')) {
                const stake = data.split('_')[1];
                const stakeMessage = `
🎯 Stake Selected: ${stake} Birr

Now choose your cartela number (1-100):

🌐 For better gaming experience, play on web: ${gameUrl}?uid=${uid}
        `;

                // Create number grid
                const numberGrid = [];
                for (let i = 0; i < 10; i++) {
                    const row = [];
                    for (let j = 1; j <= 10; j++) {
                        const number = i * 10 + j;
                        row.push({ text: number.toString(), callback_data: `cartela_${stake}_${number}` });
                    }
                    numberGrid.push(row);
                }

                // Add web play button
                numberGrid.push([
                    { text: '🌐 Play on Web', url: `${gameUrl}?uid=${uid}` }
                ]);

                bot.editMessageText(stakeMessage, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: numberGrid
                    }
                });
            } else if (data.startsWith('cartela_')) {
                const [, stake, number] = data.split('_');
                const cartelaMessage = `
🎉 Cartela Selected!

Stake: ${stake} Birr
Cartela Number: ${number}

Game starting soon...

🌐 For full gaming experience, play on web: ${gameUrl}?uid=${uid}
        `;

                bot.editMessageText(cartelaMessage, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '🌐 Play Full Game on Web', url: `${gameUrl}?uid=${uid}` }
                            ],
                            [
                                { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                            ]
                        ]
                    }
                });
            }
            break;
    }

    // Answer callback query
    bot.answerCallbackQuery(query.id);
});

// Text message handlers for keyboard buttons
bot.onText(/🎮 Play/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userDoc = await getUserDocByTelegramId(userId);
    if (!userDoc) {
        bot.sendMessage(chatId, 'Please register first using /start and share your phone number.');
        return;
    }

    const userData = await getUserData(userId);
    const uid = userData?.uid || '';

    const playMessage = `
🎮 Choose Your Platform:

Where would you like to play?
    `;

    bot.sendMessage(chatId, playMessage, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📱 Play on Telegram', callback_data: 'play_telegram' },
                    { text: '🌐 Play on Web', url: `${gameUrl}?uid=${uid}` }
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
    const userDoc = await getUserDocByTelegramId(userId);
    if (!userDoc) {
        bot.sendMessage(chatId, 'Please register first using /start and share your phone number.');
        return;
    }

    const userData = await getUserData(userId);
    const balance = userData?.wallet || 0;
    const uid = userData?.uid || '';

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

bot.onText(/💸 Withdraw/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userDoc = await getUserDocByTelegramId(userId);
    if (!userDoc) {
        bot.sendMessage(chatId, 'Please register first using /start and share your phone number.');
        return;
    }

    const userData = await getUserData(userId);
    const uid = userData?.uid || '';

    const withdrawMessage = `
💸 Withdraw Funds

Your balance: ${userData?.wallet || 0} Birr

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

bot.onText(/🌐 Play on Web/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userDoc = await getUserDocByTelegramId(userId);
    if (!userDoc) {
        bot.sendMessage(chatId, 'Please register first using /start and share your phone number.');
        return;
    }

    const userData = await getUserData(userId);
    const uid = userData?.uid || '';

    const webMessage = `
🌐 Play Genius Bingo on Web

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
                    { text: '🌐 Open Web Game', web_app: { url: gameUrl } }
                ],
                [
                    { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                ]
            ]
        }
    });
});

// New: message handler to capture Telebirr SMS when in deposit flow
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Ignore non-text or command messages
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
        if (amount > userData?.withdrawable) {
            bot.sendMessage(chatId, `❌ Insufficient withdrawable balance. Your withdrawable balance: ${userData?.withdrawable || 0} Birr`);
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
New Total Balance: ${updatedUserData?.wallet || 0} Birr
New Withdrawable Balance: ${updatedUserData?.withdrawable || 0} Birr

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
        bot.sendMessage(chatId, '⏳ We are processing your deposit. This will only take less than a minute...');

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

            const normalizedUrl = `https://transactioninfo.ethiotelecom.et/receipt/${(parsed.transactionNumber || '').toUpperCase()}`;
            const receiptCheck = await validateReceiptUrl(normalizedUrl);
            console.log('[telebirr-debug] receiptCheck:', receiptCheck);
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
            let amountFromReceipt = 0;
            if (parsedReceipt) {
                const settled = Number(parsedReceipt.settled_amount) || 0;
                const totalPaid = Number(parsedReceipt.total_amount) || 0;
                amountFromReceipt = settled > 0 ? settled : (totalPaid > 0 ? totalPaid : 0);
            }
            console.log('[telebirr-debug] amountFromReceipt before fallback:', amountFromReceipt);
            if (!amountFromReceipt || amountFromReceipt <= 0) {
                if (receiptCheck.amountFallback && receiptCheck.amountFallback > 0) {
                    amountFromReceipt = receiptCheck.amountFallback;
                }
                // Last-resort fallback: SMS amount
                if ((!amountFromReceipt || amountFromReceipt <= 0) && parsed.amount && parsed.amount > 0) {
                    console.log('[telebirr-debug] using SMS amount fallback:', parsed.amount);
                    amountFromReceipt = parsed.amount;
                }
            }
            console.log('[telebirr-debug] amountFromReceipt after fallback:', amountFromReceipt);
            // Only block if status is explicitly not Completed
            if (!amountFromReceipt || amountFromReceipt <= 0 || receiptCheck.statusOk === false) {
                const balance = await getCurrentBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `Could not determine the deposited amount from the receipt. Please try again later.\nYour current balance: ${balance} Birr`);
                return;
            }

            const finalAmount = amountFromReceipt;
            const txNumber = (parsedReceipt && parsedReceipt.receiptNo) || receiptCheck.receiptNo || parsed.transactionNumber;
            console.log('[telebirr-debug] final credit:', { finalAmount, txNumber });

            const userDoc = await getUserDocByTelegramId(userId);
            if (!userDoc) {
                const balance = await getCurrentBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `User not found. Please register first using /start.\nYour current balance: ${balance} Birr`);
                return;
            }

            const { credited, duplicate, balance, isFirstDeposit, cashbackAmount, totalCredit } = await creditDepositIfNew(userDoc.ref, txNumber, finalAmount, msg.text);
            console.log('[telebirr-debug] transaction result:', { credited, duplicate, balance, isFirstDeposit, cashbackAmount, totalCredit });
            if (duplicate) {
                bot.sendMessage(chatId, `This transaction (${txNumber}) was already used. Your balance is ${balance} Birr.`);
                return;
            }

            userStates.delete(userId);

            if (isFirstDeposit) {
                bot.sendMessage(chatId, `🎉 Welcome! Your first deposit is here!\n\n✅ Telebirr deposit successful!\nAmount: ETB ${finalAmount.toFixed(2)}\nTx: ${txNumber}\nNew total balance: ${balance} Birr\nNew withdrawable balance: ${credited.withdrawable} Birr`);
            } else {
                bot.sendMessage(chatId, `✅ Telebirr deposit successful!\nAmount: ETB ${finalAmount.toFixed(2)}\nTx: ${txNumber}\nNew total balance: ${balance} Birr\nNew withdrawable balance: ${credited.withdrawable} Birr`);
            }
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

            // Check receiver name from the SMS text against our target account
            console.log('[cbe-debug] checking SMS receiver name:', parsed.receiverName, 'against target:', CBE_TARGET_NAME);
            if (!receiverNameMatchesTarget(parsed.receiverName, CBE_TARGET_NAME)) {
                const balance = await getCurrentBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `The receiver name "${parsed.receiverName}" does not match the expected recipient "${CBE_TARGET_NAME}". Please ensure you sent to the correct person.\nYour current balance: ${balance} Birr`);
                return;
            }

            // Validate the receipt URL
            const receiptCheck = await validateCBEReceiptUrl(parsed.receiptUrl, parsed.amount, parsed.transactionNumber);
            console.log('[cbe-debug] CBE receipt check:', receiptCheck);

            if (!receiptCheck.ok) {
                const balance = await getCurrentBalanceByTelegramId(userId);
                const reason = receiptCheck.reason === 'data_mismatch' ? 'The receipt data does not match the transaction.' : 'Could not verify the receipt link.';
                bot.sendMessage(chatId, `${reason} Please double check and try again.\nYour current balance: ${balance} Birr`);
                return;
            }

            // Check receiver name extracted from the official PDF receipt, if available
            if (receiptCheck.parsed && receiptCheck.parsed.receiver && !receiverNameMatchesTarget(receiptCheck.parsed.receiver, CBE_TARGET_NAME)) {
                console.log('[cbe-debug] PDF receiver name mismatch:', receiptCheck.parsed.receiver, 'vs', CBE_TARGET_NAME);
                bot.sendMessage(chatId, `❌ Deposit rejected: The receipt shows the money was sent to "${receiptCheck.parsed.receiver}" instead of "${CBE_TARGET_NAME}". Please ensure you sent to the correct recipient.`);
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

            const { credited, duplicate, balance, isFirstDeposit, cashbackAmount, totalCredit } = await creditDepositIfNew(userDoc.ref, txNumber, finalAmount, msg.text);
            console.log('[cbe-debug] CBE transaction result:', { credited, duplicate, balance, isFirstDeposit, cashbackAmount, totalCredit });

            if (duplicate) {
                bot.sendMessage(chatId, `This CBE Birr transaction (${txNumber}) was already used. Your balance is ${balance} Birr.`);
                return;
            }

            userStates.delete(userId);

            if (isFirstDeposit) {
                bot.sendMessage(chatId, `🎉 Welcome! Your first deposit is here!\n\n✅ CBE Birr deposit successful!\nAmount: ETB ${finalAmount.toFixed(2)}\nTx: ${txNumber}\nNew total balance: ${balance} Birr\nNew withdrawable balance: ${credited.withdrawable} Birr`);
            } else {
                bot.sendMessage(chatId, `✅ CBE Birr deposit successful!\nAmount: ETB ${finalAmount.toFixed(2)}\nTx: ${txNumber}\nNew total balance: ${balance} Birr\nNew withdrawable balance: ${credited.withdrawable} Birr`);
            }
        } catch (error) {
            console.error('CBE Birr deposit handling error:', error);
            const balance = await getCurrentBalanceByTelegramId(userId);
            bot.sendMessage(chatId, `An error occurred while processing your CBE Birr deposit. Please try again.\nYour current balance: ${balance} Birr`);
        }
    }
});

// New: /announce command handler (admin only)
bot.onText(/\/announce (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const message = match[1];

    // Check if user is admin (you can modify this logic)
    const userData = await getUserData(userId);
    if (!userData || userData.role !== 'admin') {
        bot.sendMessage(chatId, '❌ You do not have permission to send announcements.');
        return;
    }

    try {
        bot.sendMessage(chatId, '📤 Sending announcement to all users...');

        const result = await sendAnnouncementToAllUsers(message);

        const responseMessage = `✅ Announcement sent successfully!\n\n📊 Results:\n• Sent: ${result.successCount} users\n• Failed: ${result.errorCount} users\n\nMessage: ${message}`;

        bot.sendMessage(chatId, responseMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Announcement error:', error);
        bot.sendMessage(chatId, '❌ Failed to send announcement. Please try again.');
    }
});

// New: /process-announcements command handler (admin only)
bot.onText(/\/process-announcements/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Check if user is admin (you can modify this logic)
    const userData = await getUserData(userId);
    if (!userData || userData.role !== 'admin') {
        bot.sendMessage(chatId, '❌ You do not have permission to process announcements.');
        return;
    }

    try {
        bot.sendMessage(chatId, '🔄 Processing pending announcements...');

        await processPendingAnnouncements();

        bot.sendMessage(chatId, '✅ Pending announcements processed successfully!');
    } catch (error) {
        console.error('Process announcements error:', error);
        bot.sendMessage(chatId, '❌ Failed to process announcements. Please try again.');
    }
});

// New: /referral command handler
bot.onText(/\/referral/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const userData = await getUserData(userId);
    if (!userData) {
        bot.sendMessage(chatId, 'Please register first using /start and share your phone number.');
        return;
    }

    const referralLink = `${gameUrl}?ref=${userData.uid || userId}`;
    const referralMessage = `
🎯 **Your Referral Link**

Share this link with your friends and earn 10 Birr for each successful registration!

🔗 **Your Link:**
\`${referralLink}\`

💰 **How it works:**
• Share your link with friends
• When they register using your link
• Both you and your friend get 10 Birr bonus!

📊 **Your Stats:**
• Total Referrals: ${userData.referralCount || 0}
• Total Earned: ${(userData.referralCount || 0) * 10} Birr

💡 **Tips:**
• Share on social media
• Send to friends and family
• Post in groups and channels
    `;

    bot.sendMessage(chatId, referralMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🔗 Copy Link', callback_data: 'copy_referral_link' },
                    { text: '📤 Share Link', callback_data: 'share_referral_link' }
                ],
                [
                    { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                ]
            ]
        }
    });
});

// Function to process referral link and award bonus
async function processReferralLink(inviterId, referredPhone) {
    try {
        // Check if this referral has already been processed
        const referralTrackingRef = db.collection('referralTracking').doc(`${inviterId}_${referredPhone}`);
        const existingTracking = await referralTrackingRef.get();

        if (existingTracking.exists) {
            console.log(`Referral bonus already awarded for inviter ${inviterId} and phone ${referredPhone}`);
            return { success: false, message: 'Referral bonus already awarded for this user' };
        }

        // Check if the referred user exists
        const referredUserQuery = await db.collection('users').where('phone', '==', referredPhone).get();
        if (referredUserQuery.empty) {
            return { success: false, message: 'Referred user not found' };
        }

        const referredUserDoc = referredUserQuery.docs[0];
        const referredUserData = referredUserDoc.data();

        // Check if user already has referral bonus
        if (referredUserData.referralBonusAwarded) {
            return { success: false, message: 'User already received referral bonus' };
        }

        // Award the bonus
        const result = await handleReferralBonus(inviterId, referredUserDoc.id, referredPhone);

        if (result) {
            return { success: true, message: 'Referral bonus awarded successfully' };
        } else {
            return { success: false, message: 'Failed to award referral bonus' };
        }
    } catch (error) {
        console.error('Error processing referral link:', error);
        return { success: false, message: 'Error processing referral link' };
    }
}

// New: /process-referral command handler (admin only)
bot.onText(/\/process-referral (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const referralData = match[1];

    // Check if user is admin (you can modify this logic)
    const userData = await getUserData(userId);
    if (!userData || userData.role !== 'admin') {
        bot.sendMessage(chatId, '❌ You do not have permission to process referrals.');
        return;
    }

    try {
        // Parse referral data (format: inviterId:phoneNumber)
        const [inviterId, referredPhone] = referralData.split(':');

        if (!inviterId || !referredPhone) {
            bot.sendMessage(chatId, '❌ Invalid referral data format. Use: /process-referral inviterId:phoneNumber');
            return;
        }

        bot.sendMessage(chatId, '🔄 Processing referral...');

        const result = await processReferralLink(inviterId, referredPhone);

        if (result.success) {
            bot.sendMessage(chatId, `✅ ${result.message}`);
        } else {
            bot.sendMessage(chatId, `❌ ${result.message}`);
        }
    } catch (error) {
        console.error('Process referral error:', error);
        bot.sendMessage(chatId, '❌ Failed to process referral. Please try again.');
    }
});

// Handle errors
bot.on('error', (error) => {
    console.error('Bot error:', error);
});

bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

// Start the bot
console.log('🤖 Genius Bingo Bot is starting...');
console.log('📱 Bot is now running and listening for messages...');
console.log(`🌐 Web game URL: ${gameUrl}`);

// Process pending announcements every 30 seconds
setInterval(async () => {
    try {
        await processPendingAnnouncements();
    } catch (error) {
        console.error('Error in announcement processing interval:', error);
    }
}, 30000); // 30 seconds

module.exports = bot; 