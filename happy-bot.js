const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const https = require('https');
const http = require('http');
const { HttpsProxyAgent } = require('https-proxy-agent');
const axios = require('axios');
const telebirrReceipt = require('./telebirr-receipt-master');
const pdfParse = require('pdf-parse');
let proxyChain = null;
let puppeteer = null;
const fs = require('fs');
const path = require('path');

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

// Bot configuration
const token = process.env.HAPPY_BOT_TOKEN || process.env.BOT_TOKEN;
if (!token || token === 'your_telegram_bot_token_here') {
    console.error('❌ Error: Happy bot token not found!');
    console.error('Set HAPPY_BOT_TOKEN (or BOT_TOKEN) in your .env file.');
    process.exit(1);
}
const bot = new TelegramBot(token, { polling: false });

// Firebase configuration (same as main bot)
const serviceAccount = {
    "type": "service_account",
    "project_id": 'bgeno-8ec4c',
    "private_key_id": process.env.FIREBASE_PRIVATE_KEY_ID,
    "private_key": process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    "client_email": process.env.FIREBASE_CLIENT_EMAIL,
    "client_id": process.env.FIREBASE_CLIENT_ID,
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
    "client_x509_cert_url": process.env.FIREBASE_CLIENT_CERT_URL
};

// Initialize Firebase Admin (use different app name to avoid conflicts)
let db;
try {
    const happyApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://bgeno-8ec4c-default-rtdb.firebaseio.com/"
    }, 'happy-bot');
    db = admin.firestore(happyApp);
} catch (error) {
    console.error('Firebase initialization error:', error);
    // If app already exists, use it
    try {
        const happyApp = admin.app('happy-bot');
        db = admin.firestore(happyApp);
    } catch (e) {
        console.error('Failed to get Firebase app:', e);
        process.exit(1);
    }
}

// Game URL (same as main bot)
const gameUrl = process.env.GAME_URL || 'https://ygbingo.netlify.app/';

// In-memory conversation state per user
const userStates = new Map();

// Helper function to safely send messages with error handling
async function safeSendMessage(chatId, text, options = {}) {
    try {
        return await bot.sendMessage(chatId, text, options);
    } catch (error) {
        console.error('[Happy Bot] Error sending message:', error);
        // Try sending a fallback message without special formatting
        try {
            const fallbackText = text.replace(/[<>]/g, '').replace(/\*\*/g, '').replace(/\*/g, '');
            return await bot.sendMessage(chatId, fallbackText, {});
        } catch (fallbackError) {
            console.error('[Happy Bot] Fallback message also failed:', fallbackError);
            // Last resort - send a simple message
            try {
                return await bot.sendMessage(chatId, 'Message could not be sent. Please try again.');
            } catch (finalError) {
                console.error('[Happy Bot] All message sending attempts failed:', finalError);
            }
        }
    }
}

// Happy Bot deposit configuration
const HAPPY_TELEBIRR_TARGET_PHONE_LOCAL = '0912463281';
const HAPPY_TELEBIRR_TARGET_NAME = 'Destawu Wendmu'; // Expected receiver name
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
const HAPPY_TELEBIRR_TARGET_PHONE_INTL = toInternationalPhone(HAPPY_TELEBIRR_TARGET_PHONE_LOCAL);
console.log('[HAPPY-DEBUG] Phone constants:', {
    HAPPY_TELEBIRR_TARGET_PHONE_LOCAL,
    HAPPY_TELEBIRR_TARGET_PHONE_INTL
});

// Happy CBE Birr deposit configuration
const HAPPY_CBE_TARGET_PHONE_LOCAL = '0912463281';
const HAPPY_CBE_TARGET_PHONE_INTL = toInternationalPhone(HAPPY_CBE_TARGET_PHONE_LOCAL);
const HAPPY_CBE_TARGET_NAME = 'Desta Wendemu';

// Function to get user data from Firebase (HAPPY BOT - happy_ users only)
async function getUserData(userId) {
    try {
        console.log(`[Happy Bot] getUserData called for userId: ${userId}`);
        const userDoc = await db.collection('users').where('telegramId', '==', userId.toString()).get();
        console.log(`[Happy Bot] Found ${userDoc.docs.length} documents for telegram ID ${userId}`);

        if (!userDoc.empty) {
            // HAPPY BOT: Look for happy accounts specifically
            for (const doc of userDoc.docs) {
                const uid = doc.id;
                console.log(`[Happy Bot] Checking document with UID: ${uid}`);
                if (uid.startsWith('happy_')) {
                    // Found a happy account
                    console.log(`[Happy Bot] Found happy account: ${uid}`);
                    return {
                        ...doc.data(),
                        uid: uid
                    };
                }
            }
            // Only main accounts found
            console.log(`[Happy Bot] Only main accounts found, returning null`);
            return null;
        }
        console.log(`[Happy Bot] No documents found for telegram ID ${userId}`);
        return null;
    } catch (error) {
        console.error('[Happy Bot] Error getting user data:', error);
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

// Helper function to get user by phone (matching main bot)
async function getUserByPhone(phone) {
    try {
        const normalizedPhone = phone.replace(/\s+/g, '').replace(/-/g, '');
        const userQuery = await db.collection('users').where('phone', '==', normalizedPhone).get();

        if (!userQuery.empty) {
            const userDoc = userQuery.docs[0];
            return {
                id: userDoc.id,
                ...userDoc.data()
            };
        }
        return null;
    } catch (error) {
        console.error('Error getting user by phone:', error);
        return null;
    }
}

// Function to generate happy_ prefixed UID
function generateHappyUID() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 5);
    return `happy_${timestamp}_${random}`;
}

// Function to create user with happy_ prefix (matching main bot structure)
async function createHappyUser(userId, userName, phone, referralCode = null) {
    try {
        // Check if phone number is already registered to a different user
        const existingUser = await getUserByPhone(phone);
        if (existingUser) {
            // If the existing user has the same telegramId, allow happy account creation
            if (existingUser.telegramId === userId.toString()) {
                console.log(`[Happy Bot] Phone ${phone} is registered to the same Telegram user ${userId}, allowing happy account creation`);
            } else {
                throw new Error('Phone number already registered to another user');
            }
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

        const happyUID = generateHappyUID();

        const userRef = db.collection('users').doc(happyUID);
        await userRef.set({
            userName: userName, // Match web app field name
            phone: normalizedPhoneNumber, // Match web app field name and normalization
            telegramId: userId.toString(), // Additional field for Telegram users
            wallet: 0, // Start with 0 balance (no registration bonus for happy users)
            withdrawable: 0, // Track withdrawable balance
            isAdult: true,
            agreeTerms: true,
            referredBy: referredBy, // Add referral tracking
            referralCount: 0, // Initialize referral count
            referralBonusAwarded: false, // Track if referral bonus was awarded
            firstDepositMade: false, // Track if user has made their first deposit
            registrationBonusAwarded: false, // No registration bonus for happy users
            uid: happyUID, // Happy-specific UID
            botSource: 'happy-bot', // Track which bot created this user
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Handle referral bonus if applicable
        if (referredBy) {
            try {
                await handleReferralBonus(referredBy, happyUID, normalizedPhoneNumber);
            } catch (error) {
                console.error('Error handling referral bonus:', error);
                // Don't fail registration if referral bonus fails
            }
        }

        console.log(`Created happy user with UID: ${happyUID}`);
        return happyUID;
    } catch (error) {
        console.error('Error creating happy user:', error);
        throw error;
    }
}

// Function to handle referral bonus (same logic as main bot)
async function handleReferralBonus(inviterId, newUserId, phoneNumber) {
    try {
        // Check if this referral has already been processed
        const referralTrackingRef = db.collection('referralTracking').doc(`${inviterId}_${phoneNumber}`);
        const existingTracking = await referralTrackingRef.get();

        if (existingTracking.exists) {
            console.log(`Referral bonus already awarded for inviter ${inviterId} and phone ${phoneNumber}`);
            return null;
        }

        // Get inviter data
        const inviterDoc = await db.collection('users').doc(inviterId).get();
        if (!inviterDoc.exists) {
            console.log(`Inviter ${inviterId} not found`);
            return null;
        }

        const inviterData = inviterDoc.data();
        const newInviterBalance = (inviterData.wallet || 0) + 10;

        // Get new user data
        const newUserDoc = await db.collection('users').doc(newUserId).get();
        if (!newUserDoc.exists) {
            console.log(`New user ${newUserId} not found`);
            return null;
        }

        const newUserData = newUserDoc.data();
        const newUserBalance = (newUserData.wallet || 0) + 10;

        // Update both users' balances
        await db.collection('users').doc(inviterId).update({
            wallet: newInviterBalance,
            totalReferrals: (inviterData.totalReferrals || 0) + 1,
            lastReferralAt: admin.firestore.FieldValue.serverTimestamp()
        });

        await db.collection('users').doc(newUserId).update({
            wallet: newUserBalance,
            referralBonusReceived: true,
            referralBonusAwarded: true
        });

        // Track this referral to prevent duplicates
        await referralTrackingRef.set({
            inviterId: inviterId,
            newUserId: newUserId,
            phoneNumber: phoneNumber,
            bonusAmount: 10,
            processedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`Referral bonus processed: ${inviterId} -> ${newUserId}`);
        return {
            inviterBonus: 10,
            newUserBonus: 10
        };
    } catch (error) {
        console.error('Error handling referral bonus:', error);
        return null;
    }
}

// Function to create withdrawal request for happy users (matching main bot structure)
async function createHappyWithdrawalRequest(userId, amount, method, phone) {
    try {
        const userData = await getUserData(userId);
        if (!userData) {
            throw new Error('Happy user not found');
        }

        // Check wallet balance for withdrawal validation
        const walletBalance = Number(userData.wallet || 0);
        const withdrawableBalance = Number(userData.withdrawable || 0);

        if (walletBalance < amount) {
            throw new Error('Insufficient wallet balance');
        }

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

            // Validate both wallet and withdrawable balances
            if (currentBalance < amount) {
                throw new Error('Insufficient wallet balance');
            }

            if (currentWithdrawable < amount) {
                throw new Error('Insufficient withdrawable balance');
            }

            // Deduct from both wallet and withdrawable
            const newBalance = currentBalance - Number(amount);
            const newWithdrawable = currentWithdrawable - Number(amount);

            // Create withdrawal request in happy-specific collection
            const withdrawalRef = db.collection('happy_withdrawals').doc();
            transaction.set(withdrawalRef, {
                userId: userId.toString(),
                userName: currentUserData.userName || 'Unknown',
                phone: phone,
                amount: Number(amount),
                method: method,
                status: 'pending',
                userUid: userData.uid, // Happy-specific field
                botSource: 'happy-bot', // Happy-specific field
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
        console.error('Error creating happy withdrawal request:', error);
        throw error;
    }
}

// Advanced TeleBirr receipt parsing (from main bot, adapted for Happy Bot)
function parseHappyTelebirrReceipt(messageText) {
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

// Advanced CBE receipt parsing (from main bot, adapted for Happy Bot)
function parseHappyCBEBirrReceipt(messageText) {
    const text = messageText || '';

    // Parse amount: "you have sent 10.00Br." - improved patterns
    const amountMatch = text.match(/sent\s+([\d,.]+)Br\./i) ||
        text.match(/transferred\s+([\d,.]+)Br\./i) ||
        text.match(/amount\s+([\d,.]+)Br\./i);

    // Parse transaction ID: "Txn ID CHO1SN9RQX" - improved patterns
    const txMatch = text.match(/Txn\s+ID\s+([A-Z0-9]+)/i) ||
        text.match(/Transaction\s+ID\s+([A-Z0-9]+)/i) ||
        text.match(/TID[:\s]*([A-Z0-9]+)/i) ||
        text.match(/Order\s+ID\s+([A-Z0-9]+)/i);

    // Parse receipt URL: "https://cbepay1.cbe.com.et/aureceipt?TID=CHO1SN9RQX&PH=251913503182"
    const linkMatch = text.match(/https?:\/\/cbepay1\.cbe\.com\.et\/aureceipt\?[^\s]+/i);

    // Parse receiver name: "to destawu wendmu" - improved patterns
    const receiverNameMatch = text.match(/to\s+([^,]+?)\s+on/i) ||
        text.match(/Receiver[:\s]*([^\n]+)/i) ||
        text.match(/Credit\s*Account\s*\d+\s*-\s*([^\n]+)/i) ||
        text.match(/Receiver\s*Name\s*\d+\s*-\s*([^\n]+)/i);

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

// Utility functions for validation
function maskedPhoneMatchesTarget(maskedPhone, targetPhone) {
    console.log('[PHONE-DEBUG] Input:', { maskedPhone, targetPhone });
    if (!maskedPhone || !targetPhone) {
        console.log('[PHONE-DEBUG] Missing input, returning false');
        return false;
    }

    // Remove non-digits from target, but keep asterisks in masked phone
    const normalized = maskedPhone.replace(/[^\d*]/g, ''); // Keep digits and asterisks
    const target = targetPhone.replace(/\D/g, ''); // Remove all non-digits
    console.log('[PHONE-DEBUG] After normalization:', { normalized, target });

    // Convert both to same format (remove 251 prefix if present)
    const normalizePhone = (phone) => {
        if (phone.startsWith('251')) {
            return phone.substring(3);
        }
        if (phone.startsWith('0')) {
            return phone.substring(1);
        }
        return phone;
    };

    const normalizedMasked = normalizePhone(normalized);
    const normalizedTarget = normalizePhone(target);
    console.log('[PHONE-DEBUG] After prefix removal:', { normalizedMasked, normalizedTarget });

    // Check if the non-masked parts match
    // Example: 9****3281 should match 912463281
    const pattern = normalizedMasked.replace(/\*/g, '\\d');
    const regex = new RegExp(`^${pattern}$`);
    console.log('[PHONE-DEBUG] Pattern and test:', { pattern, regex: regex.source, result: regex.test(normalizedTarget) });

    return regex.test(normalizedTarget);
}

function receiverNameMatchesTarget(receiverName, targetName) {
    if (!receiverName || !targetName) return false;

    // Normalize both names (lowercase, remove extra spaces)
    const normalize = (name) => name.toLowerCase().replace(/\s+/g, ' ').trim();
    const normalizedReceiver = normalize(receiverName);
    const normalizedTarget = normalize(targetName);

    // Check for exact match or close match
    return normalizedReceiver === normalizedTarget ||
        normalizedReceiver.includes(normalizedTarget) ||
        normalizedTarget.includes(normalizedReceiver);
}

// Copy exact receipt validation from main bot (bot-deploy.js)

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

async function validateHappyReceiptUrl(url) {
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
            const target = HAPPY_TELEBIRR_TARGET_PHONE_INTL.replace(/\D/g, '');
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

// CBE Birr receipt PDF fetching function (direct approach without proxy)
async function fetchHappyCBEReceiptPdf(url) {
    console.log('[happy-cbe-debug] fetching CBE receipt URL:', url);

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
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, compress, deflate, br'
            },
            // Always allow insecure connections for CBE receipts due to certificate issues
            rejectUnauthorized: false,
            // Add timeout for the entire request
            timeout: 15000
        };

        return new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                console.log('[happy-cbe-debug] response status:', res.statusCode);
                console.log('[happy-cbe-debug] response headers:', res.headers);

                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    console.log('[happy-cbe-debug] received PDF data, size:', buffer.length);
                    resolve(buffer);
                });
            });

            req.on('error', (err) => {
                console.log('[happy-cbe-debug] request error:', err.message);
                reject(err);
            });

            req.setTimeout(15000, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.end();
        });
    } catch (error) {
        console.log('[happy-cbe-debug] fetch error:', error.message);
        return null;
    }
}

// CBE Birr receipt URL validation with PDF parsing (from main bot)
async function validateHappyCBEReceiptUrl(url) {
    try {
        console.log('[happy-cbe-debug] validating CBE receipt URL:', url);

        const pdfData = await fetchHappyCBEReceiptPdf(url);
        if (!pdfData) {
            console.log('[happy-cbe-debug] could not fetch CBE receipt PDF - REJECTING DEPOSIT');
            return { ok: false, reason: 'pdf_fetch_failed' };
        }

        // Convert PDF data to text for parsing using proper PDF parser
        try {
            const buffer = Buffer.from(pdfData);
            console.log('[happy-cbe-debug] PDF buffer size:', buffer.length);

            const pdfDataParsed = await pdfParse(buffer);
            const textContent = pdfDataParsed.text;

            console.log('[happy-cbe-debug] PDF text content (first 500 chars):', textContent.substring(0, 500));

            // Look for key information in the PDF text - updated for CBE Birr format
            console.log('[happy-cbe-debug] full PDF text for debugging:', textContent);

            // Amount patterns for CBE Birr receipts - look for the specific format in the PDF
            const amountMatch = textContent.match(/Paid\s*amount\s*(\d+\.\d{2})/i) ||
                textContent.match(/Total\s*Paid\s*Amount\s*(\d+\.\d{2})/i) ||
                textContent.match(/(\d+\.\d{2})\s*Paid\s*amount/i) ||
                textContent.match(/(\d+\.\d{2})\s*Total\s*Paid\s*Amount/i);

            // Transaction ID patterns - based on actual PDF structure
            const txMatch = textContent.match(/Order\s*ID\s*([A-Z0-9]+)/i) ||
                textContent.match(/Transaction\s*ID[:\s]*([A-Z0-9]+)/i) ||
                textContent.match(/TID[:\s]*([A-Z0-9]+)/i) ||
                textContent.match(/Receipt\s*Number[:\s]*([A-Z0-9]+)/i);

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
                } else if (amountMatch[2]) {
                    extractedAmount = Number(amountMatch[2].replace(/[^\d.,]/g, '').replace(/,/g, ''));
                }
            }

            console.log('[happy-cbe-debug] amountMatch result:', amountMatch);
            console.log('[happy-cbe-debug] initial extractedAmount:', extractedAmount);

            // Additional fallback: Look for "Paid amount" line
            if (!extractedAmount || extractedAmount <= 0) {
                const paidAmountMatch = textContent.match(/Paid\s*amount\s*(\d+\.\d{2})/i);
                if (paidAmountMatch) {
                    extractedAmount = Number(paidAmountMatch[1]);
                    console.log('[happy-cbe-debug] fallback paidAmountMatch:', paidAmountMatch);
                }
            }

            // Additional fallback: Look for "Total Paid Amount" line
            if (!extractedAmount || extractedAmount <= 0) {
                const totalPaidMatch = textContent.match(/Total\s*Paid\s*Amount\s*(\d+\.\d{2})/i);
                if (totalPaidMatch) {
                    extractedAmount = Number(totalPaidMatch[1]);
                    console.log('[happy-cbe-debug] fallback totalPaidMatch:', totalPaidMatch);
                }
            }

            // Final fallback: Look for the specific pattern in your PDF
            if (!extractedAmount || extractedAmount <= 0) {
                // Look for the pattern: "5.00\nPaid amount" or similar
                const specificMatch = textContent.match(/(\d+\.\d{2})\s*\n\s*Paid\s*amount/i);
                if (specificMatch) {
                    extractedAmount = Number(specificMatch[1]);
                    console.log('[happy-cbe-debug] fallback specificMatch:', specificMatch);
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
                    console.log('[happy-cbe-debug] extracted receiver from Credit Account:', receiverName);
                }
            }

            if (!receiverName) {
                const receiverNameMatch = textContent.match(/Receiver\s*Name\s*\d+\s*-\s*([^\n]+)/i);
                if (receiverNameMatch) {
                    receiverName = receiverNameMatch[1].trim();
                    console.log('[happy-cbe-debug] extracted receiver from Receiver Name:', receiverName);
                }
            }

            console.log('[happy-cbe-debug] extracted from PDF:', {
                amount: extractedAmount,
                txId: extractedTxId,
                status: statusOk,
                receiver: receiverName
            });

            // Validate extracted data
            if (!extractedAmount || extractedAmount <= 0) {
                console.log('[happy-cbe-debug] could not extract sufficient data from PDF - REJECTING DEPOSIT');
                return { ok: false, reason: 'pdf_parse_failed' };
            }

            if (!extractedTxId) {
                console.log('[happy-cbe-debug] could not extract transaction ID from PDF - REJECTING DEPOSIT');
                return { ok: false, reason: 'pdf_parse_failed' };
            }

            if (!statusOk) {
                console.log('[happy-cbe-debug] transaction status not completed - REJECTING DEPOSIT');
                return { ok: false, reason: 'transaction_not_completed' };
            }

            // Check receiver name matches target
            if (receiverName && !receiverNameMatchesTarget(receiverName, HAPPY_CBE_TARGET_NAME)) {
                console.log('[happy-cbe-debug] receiver name mismatch:', receiverName, 'vs', HAPPY_CBE_TARGET_NAME);
                return { ok: false, reason: 'data_mismatch', details: 'receiver_name_mismatch' };
            }

            return {
                ok: true,
                amount: extractedAmount,
                txId: extractedTxId,
                status: statusOk,
                receiver: receiverName
            };

        } catch (pdfError) {
            console.error('[happy-cbe-debug] PDF parsing error:', pdfError);
            return { ok: false, reason: 'pdf_parse_error', error: pdfError.message };
        }

    } catch (error) {
        console.error('[happy-cbe-debug] CBE receipt validation error:', error);
        return { ok: false, reason: 'network_error', error: error.message };
    }
}

// Get current balance helper
async function getCurrentHappyBalanceByTelegramId(userId) {
    try {
        const userData = await getUserData(userId);
        return userData?.wallet || 0;
    } catch (error) {
        console.error('[Happy Bot] Error getting balance:', error);
        return 0;
    }
}

// Function to credit happy user deposit
async function creditHappyUserDeposit(userUID, amount, transactionId) {
    console.log('[CREDIT-DEBUG] Crediting happy user with UID:', userUID);

    // Check for duplicates first
    const txDocRef = db.collection('happy_transactions').doc(transactionId);
    const existingTx = await txDocRef.get();
    if (existingTx.exists) {
        console.log('[CREDIT-DEBUG] Transaction already exists:', transactionId);
        return { credited: false, duplicate: true };
    }

    // Check for duplicates in deposits collection too
    const depositDocRef = db.collection('happy_deposits').doc(transactionId);
    const existingDeposit = await depositDocRef.get();
    if (existingDeposit.exists) {
        console.log('[CREDIT-DEBUG] Deposit already exists:', transactionId);
        return { credited: false, duplicate: true };
    }

    return db.runTransaction(async (t) => {
        // Get user directly by UID
        const userRef = db.collection('users').doc(userUID);
        const userDoc = await t.get(userRef);

        if (!userDoc.exists) {
            console.log('[CREDIT-DEBUG] User not found with UID:', userUID);
            return { credited: false, error: 'Happy user not found' };
        }

        // Verify this is a happy user
        if (!userUID.startsWith('happy_')) {
            console.log('[CREDIT-DEBUG] User is not a happy user:', userUID);
            return { credited: false, error: 'User is not a happy user - use main bot' };
        }

        console.log('[CREDIT-DEBUG] Found happy user:', userUID);
        const userId = userUID;

        const userSnap = await t.get(userRef);
        const userData = userSnap.data() || {};
        const currentBalance = Number(userData.wallet || 0);
        const currentWithdrawable = Number(userData.withdrawable || 0);
        const isFirstDeposit = !userData.firstDepositMade;

        // Calculate total credit (amount + any bonuses)
        const totalCredit = Number(amount);
        const newBalance = currentBalance + totalCredit;
        // For happy users, deposits are immediately withdrawable
        const newWithdrawable = currentWithdrawable + totalCredit;

        // Create transaction record
        t.set(txDocRef, {
            userId: userId,
            userUid: userId,
            userName: userData.username || userData.userName || userData.name || 'Unknown',
            phone: userData.phone || userData.phoneNumber || 'N/A',
            type: 'deposit',
            provider: 'happy_telebirr',
            amount: Number(amount),
            cashbackAmount: 0,
            totalCredit: totalCredit,
            isFirstDeposit: isFirstDeposit,
            transactionNumber: transactionId,
            status: 'completed',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            processedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Update user wallet, withdrawable balance, and mark first deposit as made
        t.update(userRef, {
            wallet: newBalance,
            withdrawable: newWithdrawable,
            firstDepositMade: true
        });

        // Save to happy-specific deposits collection to avoid mixing with main bot
        const happyDepositRef = db.collection('happy_deposits').doc(transactionId);
        t.set(happyDepositRef, {
            userId: userId,
            userUid: userId,
            userName: userData.username || userData.userName || userData.name || 'Unknown',
            phone: userData.phone || userData.phoneNumber || 'N/A',
            type: 'deposit',
            provider: 'happy_transfer', // Distinguish happy deposits
            amount: Number(amount),
            cashbackAmount: 0, // No cashback for happy users
            totalCredit: totalCredit,
            isFirstDeposit: isFirstDeposit,
            transactionNumber: transactionId,
            status: 'credited',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
            botSource: 'happy-bot'
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

// /start command handler
bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name || msg.from.username || 'User';
    const referralCode = match[1] ? match[1].trim().replace(/\s+/g, '') : '';

    console.log(`Happy Bot: /start command from ${userName} (${userId}) with referral: ${referralCode}`);

    // Check if user has a happy account specifically
    const existingHappyUser = await getUserData(userId);

    if (!existingHappyUser) {
        // Check if user has any account at all
        const hasAnyAccount = await checkUserExists(userId);

        // Sanitize userName to prevent parsing issues
        const sanitizedUserName = userName ? userName.replace(/[<>]/g, '') : 'User';

        let welcomeText = hasAnyAccount ?
            `🎉 Welcome to Happy Genius Bingo Bot, ${sanitizedUserName}! 

🎯 You can have BOTH regular and HAPPY accounts!
🆔 This will create a separate HAPPY account with special benefits!
🎁 Happy accounts get immediately withdrawable deposits!

To create your HAPPY account, please share your phone number:` :
            `🎉 Welcome to Happy Genius Bingo Bot, ${sanitizedUserName}! 

🎯 You're using the HAPPY version of our bot!
🎁 All users get happy_ prefixed accounts with special benefits!

To complete your registration, please share your phone number:`;

        // New user registration (or new happy account)
        try {
            await bot.sendMessage(chatId, welcomeText, {
                reply_markup: {
                    keyboard: [
                        [{
                            text: '📱 Share Phone Number',
                            request_contact: true
                        }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
        } catch (error) {
            console.error('[Happy Bot] Error sending welcome message:', error);
            // Fallback message without special characters
            await bot.sendMessage(chatId, `Welcome to Happy Genius Bingo Bot! Please share your phone number to register.`, {
                reply_markup: {
                    keyboard: [
                        [{
                            text: '📱 Share Phone Number',
                            request_contact: true
                        }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
        }

        // Store referral code if provided
        if (referralCode) {
            userStates.set(userId, { referralCode: referralCode });
            console.log(`Stored referral code for ${userId}: ${referralCode}`);
        }
    } else {
        // User is already registered
        // Sanitize userName to prevent parsing issues
        const sanitizedUserName = userName ? userName.replace(/[<>]/g, '') : 'User';

        const welcomeMessage = `
🎰 Welcome back to Happy Genius Bingo Bot, ${sanitizedUserName}! 🏆

Your Happy Balance: ${existingHappyUser?.wallet || 0} Birr
Your Happy UID: ${existingHappyUser?.uid || 'N/A'}

Available commands:
/start - Show this welcome message
/play - Start a new game
/balance - Check your balance
/web - Play on web

🌟 Happy gaming! 🌟
        `;

        try {
            await bot.sendMessage(chatId, welcomeMessage, {
                reply_markup: {
                    keyboard: [
                        [{ text: '🎮 Play Game' }, { text: '💰 Check Balance' }],
                        [{ text: '💳 Deposit' }, { text: '💸 Withdraw' }],
                        [{ text: '🌐 Play on Web' }]
                    ],
                    resize_keyboard: true,
                    persistent: true
                }
            });
        } catch (error) {
            console.error('[Happy Bot] Error sending existing user welcome message:', error);
            // Fallback message without special characters
            await bot.sendMessage(chatId, `Welcome back to Happy Genius Bingo Bot! Your balance: ${existingHappyUser?.wallet || 0} Birr`, {
                reply_markup: {
                    keyboard: [
                        [{ text: '🎮 Play Game' }, { text: '💰 Check Balance' }],
                        [{ text: '💳 Deposit' }, { text: '💸 Withdraw' }],
                        [{ text: '🌐 Play on Web' }]
                    ],
                    resize_keyboard: true,
                    persistent: true
                }
            });
        }
    }
});

// Handle contact (phone number) sharing
bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name || msg.from.username || 'User';
    const phoneNumber = msg.contact.phone_number;

    console.log(`Happy Bot: Contact received from ${userName} (${userId}): ${phoneNumber}`);

    try {
        // Check if user already has a happy account
        const existingHappyUser = await getUserData(userId);
        if (existingHappyUser) {
            await safeSendMessage(chatId, '✅ You already have a Happy account! Use /start to see your options.');
            return;
        }

        // Additional check: prevent phone number from being used by multiple users
        // But allow the same Telegram user to have both main and happy accounts
        try {
            const phoneQuery = await db.collection('users').where('phone', '==', phoneNumber).get();
            if (!phoneQuery.empty) {
                // Check if this phone belongs to a different telegram user
                const existingPhoneUser = phoneQuery.docs[0];
                const existingTelegramId = existingPhoneUser.data().telegramId;

                // If the phone is registered to a different Telegram user, block it
                if (existingTelegramId && existingTelegramId !== userId.toString()) {
                    await safeSendMessage(chatId, '❌ This phone number is already registered with another Telegram account.');
                    return;
                }

                // If the phone is registered to the same Telegram user, allow it (for happy account creation)
                console.log(`[Happy Bot] Phone ${phoneNumber} is already registered to the same Telegram user ${userId}, allowing happy account creation`);
            }
        } catch (error) {
            console.error('[Happy Bot] Error checking phone:', error);
        }

        // Get referral code from user state
        const userState = userStates.get(userId);
        const referralCode = userState?.referralCode;

        // Create new happy user using the updated function signature
        const happyUID = await createHappyUser(userId, userName, phoneNumber, referralCode);

        // Get the final user data to show correct balance
        const finalUserData = await getUserData(userId);
        const finalBalance = finalUserData?.wallet || 0;

        // Check if referral bonus was applied
        let referralMessage = '';
        if (referralCode && finalBalance > 0) {
            referralMessage = `\n\n🎁 Referral Bonus: You and your inviter each received 10 Birr!`;
        }

        // Clear user state
        userStates.delete(userId);

        // Success message
        // Sanitize userName to prevent parsing issues
        const sanitizedUserName = userName ? userName.replace(/[<>]/g, '') : 'User';

        const successMessage = `
🎉 Welcome to Happy Genius Bingo, ${sanitizedUserName}! 

✅ Registration Successful!
🆔 Your Happy UID: ${happyUID}
💰 Starting Balance: ${finalBalance} Birr${referralMessage}

🎮 Ready to play? Choose an option below:
        `;

        try {
            await bot.sendMessage(chatId, successMessage, {
                reply_markup: {
                    keyboard: [
                        [{ text: '🎮 Play Game' }, { text: '💰 Check Balance' }],
                        [{ text: '💳 Deposit' }, { text: '💸 Withdraw' }],
                        [{ text: '🌐 Play on Web' }]
                    ],
                    resize_keyboard: true,
                    persistent: true
                }
            });
        } catch (error) {
            console.error('[Happy Bot] Error sending success message:', error);
            // Fallback message without special characters
            await bot.sendMessage(chatId, `Registration successful! Your Happy UID: ${happyUID}. Balance: ${finalBalance} Birr`, {
                reply_markup: {
                    keyboard: [
                        [{ text: '🎮 Play Game' }, { text: '💰 Check Balance' }],
                        [{ text: '💳 Deposit' }, { text: '💸 Withdraw' }],
                        [{ text: '🌐 Play on Web' }]
                    ],
                    resize_keyboard: true,
                    persistent: true
                }
            });
        }

    } catch (error) {
        console.error('Registration error:', error);
        await safeSendMessage(chatId, '❌ Registration failed. Please try again later.');
    }
});

// /play command
bot.onText(/\/play/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const userData = await getUserData(userId);
    if (!userData) {
        await safeSendMessage(chatId, 'Please register first using /start and share your phone number.');
        return;
    }

    const uid = userData?.uid || '';
    const playMessage = `
🎮 Choose Your Platform:

Where would you like to play Happy Genius Bingo?
    `;

    await safeSendMessage(chatId, playMessage, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🌐 Play on Web', web_app: { url: gameUrl } }
                ],
                [
                    { text: '📱 Play on Telegram', callback_data: 'play_telegram' }
                ]
            ]
        }
    });
});

// /balance command
bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const userData = await getUserData(userId);
    if (!userData) {
        await safeSendMessage(chatId, 'Please register first using /start and share your phone number.');
        return;
    }

    const balance = userData?.wallet || 0;
    const uid = userData?.uid || '';

    const balanceMessage = `
💰 Your Happy Balance: ${balance} Birr
🆔 Your Happy UID: ${uid}

🌐 Check detailed balance on web: ${gameUrl}?uid=${uid}
    `;

    await safeSendMessage(chatId, balanceMessage, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🌐 Open Web App', web_app: { url: gameUrl } }
                ]
            ]
        }
    });
});

// /referral command
bot.onText(/\/referral/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const userData = await getUserData(userId);
    if (!userData) {
        bot.sendMessage(chatId, 'Please register first using /start and share your phone number.');
        return;
    }

    const referralLink = `https://t.me/YourHappyBotUsername?start=${userData.uid || userId}`;
    const referralMessage = `
🎯 **Your Happy Referral Link**

Share this link with your friends and earn 10 Birr for each successful registration!

${referralLink}

💰 **Rewards:**
• You get: 10 Birr
• Your friend gets: 10 Birr

🌟 Happy referrals = Happy earnings!
    `;

    bot.sendMessage(chatId, referralMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📤 Share Link', switch_inline_query: `Join Happy Genius Bingo and get 10 Birr bonus! ${referralLink}` }
                ]
            ]
        }
    });
});

// /web command
bot.onText(/\/web/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const userData = await getUserData(userId);
    if (!userData) {
        bot.sendMessage(chatId, 'Please register first using /start and share your phone number.');
        return;
    }

    const uid = userData?.uid || '';
    const webMessage = `
🌐 Play Happy Genius Bingo on Web

Click the button below to play on our web platform:

${gameUrl}?uid=${uid}

Features on web:
• 🎮 Full game experience
• 💰 Real-time balance updates
• 🎯 Leaderboards
• 💸 Instant withdrawals

🌟 Happy gaming awaits! 🌟
    `;

    bot.sendMessage(chatId, webMessage, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🌐 Open Happy Game', web_app: { url: gameUrl } }
                ]
            ]
        }
    });
});

// /deposit command for happy users
bot.onText(/\/deposit/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const userData = await getUserData(userId);
    if (!userData) {
        bot.sendMessage(chatId, 'Please register first using /start and share your phone number.');
        return;
    }

    const depositMessage = `
💳 **Choose Happy Deposit Method:**

Select your preferred payment method:
    `;

    bot.sendMessage(chatId, depositMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📱 TeleBirr', callback_data: 'happy_deposit_telebirr' },
                    { text: '🏦 CBE Birr', callback_data: 'happy_deposit_cbe' }
                ],
                [
                    { text: '🌐 Deposit via Web', url: `${gameUrl}?uid=${userData.uid}` }
                ],
                [
                    { text: '❌ Cancel', callback_data: 'cancel_deposit' }
                ]
            ]
        }
    });
});

// /withdraw command for happy users  
bot.onText(/\/withdraw/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const userData = await getUserData(userId);
    if (!userData) {
        bot.sendMessage(chatId, 'Please register first using /start and share your phone number.');
        return;
    }

    const withdrawMessage = `
💸 **Happy Withdrawal**

Your Happy balances:
💰 Total Balance: ${userData?.wallet || 0} Birr
💸 Withdrawable: ${userData?.withdrawable || 0} Birr

Choose withdrawal method:

🌟 Happy withdrawals are processed instantly! 🌟
    `;

    bot.sendMessage(chatId, withdrawMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📱 CBE Pay', callback_data: 'withdraw_cbe' },
                    { text: '💳 TeleBirr', callback_data: 'withdraw_telebirr' }
                ],
                [
                    { text: '🌐 Withdraw via Web', url: `${gameUrl}?uid=${userData.uid}` }
                ]
            ]
        }
    });
});


// Handle callback queries
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

    const userData = await getUserData(userId);
    const uid = userData?.uid || '';

    switch (data) {
        case 'play_telegram':
            bot.sendMessage(chatId, '📱 Telegram mini-game coming soon! For now, use the web version for the full Happy experience!', {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🌐 Play on Web', web_app: { url: gameUrl } }
                        ]
                    ]
                }
            });
            break;

        case 'happy_deposit_telebirr':
            const telebirrMessage = `
💳 TELEBIRR በኩል ገንዘብ አስገባ

1) TELEBIRR ክፍት እና የሚፈልጉትን መጠን ወደ ይላኩ:
• ስም: DESTAWU WENDMU
• ስልክ: ${HAPPY_TELEBIRR_TARGET_PHONE_LOCAL}

2) ከክፍያ በኋላ፣ ሙሉውን የTELEBIRR መልዕክት ይቅዱ እና እዚህ ይላኩ።

የምሳሌ መልዕክት (እንደሚገኘው በትክክል ይላኩ):
"Dear Kaleb\\nYou have transferred ETB 20.00 to Destawu Wendmu (2519****3281) on 11/08/2025 21:30:07. Your transaction number is CHB657ZKOA. ... To download your payment information please click this link: https://transactioninfo.ethiotelecom.et/receipt/CHB657ZKOA.\\n\\nThank you for using telebirr\\nEthio telecom"

🎁 **Happy Bonus:** Your deposit is immediately withdrawable!
            `;

            userStates.set(userId, { waitingForTelebirrReceipt: true });
            bot.sendMessage(chatId, telebirrMessage, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ ይሰርዙ', callback_data: 'cancel_deposit' }]
                    ]
                }
            });
            break;

        case 'happy_deposit_cbe':
            const cbeMessage = `
💳 **CBE Birr Happy Deposit**

To deposit via CBE Birr to your Happy account:

🏦 **Step 1:** Open CBE Birr app and send money to:
• **Phone:** 0912463281  
• **Name:** Desta

📝 **Step 2:** Copy the FULL transaction message and paste it here

💰 **Minimum Deposit:** 10 Birr
🎁 **Happy Bonus:** All deposits are immediately withdrawable!

**Example message format:**
"Dear Customer, you have sent 50.00Br. to Desta on DD/MM/YY HH:MM, Txn ID CHO123456. Your CBE Birr account balance is XXX.XXBr. For invoice https://..."

🌟 Happy deposits = Happy gaming! 🌟
            `;

            bot.sendMessage(chatId, cbeMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ Cancel', callback_data: 'cancel_deposit' }]
                    ]
                }
            });

            // Set user state to wait for CBE receipt
            userStates.set(userId, { waitingForCBEReceipt: true });
            break;

        case 'cancel_deposit':
            userStates.delete(userId);
            bot.sendMessage(chatId, 'Deposit canceled. Use /deposit whenever you are ready.');
            break;

        case 'withdraw_cbe':
        case 'withdraw_telebirr':
            const method = data === 'withdraw_cbe' ? 'CBE Pay' : 'TeleBirr';
            bot.sendMessage(chatId, `💸 **${method} Withdrawal**

Your withdrawable balance: ${userData?.withdrawable || 0} Birr

Please enter the amount you want to withdraw (max: ${userData?.withdrawable || 0} Birr):`, {
                parse_mode: 'Markdown'
            });

            // Set user state for withdrawal
            userStates.set(userId, {
                waitingForWithdrawalAmount: true,
                withdrawalMethod: data === 'withdraw_cbe' ? 'cbe' : 'telebirr'
            });
            break;
    }

    await safeAnswerCallback(query.id);
});

// Handle withdrawal flow and deposit receipts
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    // Skip if it's a command, contact, or button press
    if (text?.startsWith('/') || msg.contact || !text) return;

    const state = userStates.get(userId);

    // If user is in a deposit flow, process immediately without registration check
    if (state && (state.waitingForTelebirrReceipt || state.waitingForCBEReceipt)) {
        console.log('[HAPPY-DEBUG] User in deposit flow, processing receipt...');
        await processHappyDepositReceipt(chatId, userId, text, state);
        return;
    }

    // For other flows, check if user is registered
    const userData = await getUserData(userId);
    if (!userData) {
        bot.sendMessage(chatId, 'Please register first using /start and share your phone number.');
        return;
    }

    // Handle withdrawal amount input
    if (state?.waitingForWithdrawalAmount) {
        const amount = parseFloat(text);

        if (isNaN(amount) || amount <= 0) {
            bot.sendMessage(chatId, '❌ Please enter a valid amount greater than 0.');
            return;
        }

        // Validate both wallet and withdrawable balances
        if (amount > userData?.wallet) {
            bot.sendMessage(chatId, `❌ Insufficient wallet balance. Your wallet balance: ${userData?.wallet || 0} Birr`);
            return;
        }

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

        bot.sendMessage(chatId, `💸 **Withdrawal Request**

Amount: ${amount} Birr
Method: ${state.withdrawalMethod === 'cbe' ? 'CBE Pay' : 'TeleBirr'}

Please enter your ${state.withdrawalMethod === 'cbe' ? 'CBE Pay' : 'TeleBirr'} phone number:`, {
            parse_mode: 'Markdown'
        });
        return;
    }

    // Handle withdrawal phone input
    if (state?.waitingForWithdrawalPhone) {
        const phone = text.trim();

        try {
            const withdrawalId = await createHappyWithdrawalRequest(
                userId,
                state.withdrawalAmount,
                state.withdrawalMethod,
                phone
            );

            userStates.delete(userId);

            // Get updated user data to show new balance
            const updatedUserData = await getUserData(userId);

            const successMessage = `
✅ **Happy Withdrawal Request Submitted!**

Amount: ${state.withdrawalAmount} Birr
Method: ${state.withdrawalMethod === 'cbe' ? 'CBE Pay' : 'TeleBirr'}
Account/Phone: ${phone}
Request ID: ${withdrawalId}
New Total Balance: ${updatedUserData?.wallet || 0} Birr
New Withdrawable Balance: ${updatedUserData?.withdrawable || 0} Birr

🌟 Your happy withdrawal request is now pending approval. You will be notified once it's processed instantly! 🌟
            `;

            bot.sendMessage(chatId, successMessage, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Happy withdrawal error:', error);
            bot.sendMessage(chatId, '❌ Failed to create withdrawal request. Please try again.');
            userStates.delete(userId);
        }
        return;
    }

    // Handle keyboard button presses and other messages
    if (text && !text.startsWith('/') && !msg.contact) {
        const uid = userData?.uid || '';

        switch (text) {
            case '🎮 Play Game':
                const playMessage = `
🎮 Choose Your Platform:

Where would you like to play Happy Genius Bingo?
                `;

                bot.sendMessage(chatId, playMessage, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '🌐 Play on Web', web_app: { url: gameUrl } }
                            ],
                            [
                                { text: '📱 Play on Telegram', callback_data: 'play_telegram' }
                            ]
                        ]
                    }
                });
                return;

            case '💰 Check Balance':
                const balance = userData?.wallet || 0;
                const balanceMessage = `
💰 Your Happy Balance: ${balance} Birr
🆔 Your Happy UID: ${uid}

🌐 Check detailed balance on web: ${gameUrl}?uid=${uid}
                `;

                bot.sendMessage(chatId, balanceMessage, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '🌐 Open Web App', web_app: { url: gameUrl } }
                            ]
                        ]
                    }
                });
                return;

            case '🌐 Play on Web':
                const webMessage = `
🌐 Play Happy Genius Bingo on Web

${gameUrl}?uid=${uid}

🌟 Happy gaming! 🌟
                `;

                bot.sendMessage(chatId, webMessage, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '🌐 Open Happy Game', web_app: { url: gameUrl } }
                            ]
                        ]
                    }
                });
                return;

            case '💳 Deposit':
                const depositMessage = `
💳 **Choose Happy Deposit Method:**

Select your preferred payment method:
                `;

                bot.sendMessage(chatId, depositMessage, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '📱 TeleBirr', callback_data: 'happy_deposit_telebirr' },
                                { text: '🏦 CBE Birr', callback_data: 'happy_deposit_cbe' }
                            ],
                            [
                                { text: '🌐 Deposit via Web', url: `${gameUrl}?uid=${uid}` }
                            ],
                            [
                                { text: '❌ Cancel', callback_data: 'cancel_deposit' }
                            ]
                        ]
                    }
                });
                return;

            case '💸 Withdraw':
                const withdrawMessage = `
💸 **Happy Withdrawal**

Your Happy balances:
💰 Total Balance: ${userData?.wallet || 0} Birr
💸 Withdrawable: ${userData?.withdrawable || 0} Birr

Choose withdrawal method:

🌟 Happy withdrawals are processed instantly! 🌟
                `;

                bot.sendMessage(chatId, withdrawMessage, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '📱 CBE Pay', callback_data: 'withdraw_cbe' },
                                { text: '💳 TeleBirr', callback_data: 'withdraw_telebirr' }
                            ],
                            [
                                { text: '🌐 Withdraw via Web', url: `${gameUrl}?uid=${uid}` }
                            ]
                        ]
                    }
                });
                return;

            default:
                // Handle other unrecognized text messages
                bot.sendMessage(chatId, `🌟 Happy message received! 

For assistance, use the menu buttons or commands:
• /play - Start gaming
• /balance - Check balance  
• /deposit - Deposit funds
• /withdraw - Withdraw winnings

🌟 Happy gaming! 🌟`);
                return;
        }
    }
});

// Advanced Happy Bot deposit receipt processing (based on main bot)
async function processHappyDepositReceipt(chatId, userId, receiptText, userState) {
    console.log(`[Happy Bot] Processing ${userState.waitingForTelebirrReceipt ? 'TeleBirr' : 'CBE'} deposit receipt for user ${userId}`);
    console.log('[HAPPY-DEBUG] Receipt text received:', receiptText);

    // Clear user state first
    userStates.delete(userId);

    if (userState.waitingForTelebirrReceipt) {
        // Process TeleBirr receipt with advanced validation
        bot.sendMessage(chatId, '⏳ We are processing your Happy TeleBirr deposit. This will only take less than a minute...');

        try {
            const parsed = parseHappyTelebirrReceipt(receiptText);
            console.log('[happy-telebirr-debug] SMS parsed:', parsed);

            if (!parsed.transactionNumber || !parsed.receiptUrl || !parsed.maskedPhone) {
                const balance = await getCurrentHappyBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `Could not parse your TeleBirr message. Please paste the full message including the receipt link.\nYour current Happy balance: ${balance} Birr`);
                return;
            }

            console.log('[HAPPY-DEBUG] Phone validation check:', {
                parsedMaskedPhone: parsed.maskedPhone,
                targetPhoneIntl: HAPPY_TELEBIRR_TARGET_PHONE_INTL,
                targetPhoneLocal: HAPPY_TELEBIRR_TARGET_PHONE_LOCAL
            });

            if (!maskedPhoneMatchesTarget(parsed.maskedPhone, HAPPY_TELEBIRR_TARGET_PHONE_INTL)) {
                const balance = await getCurrentHappyBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `The destination phone number does not match ${HAPPY_TELEBIRR_TARGET_PHONE_LOCAL}. Please ensure you sent to the correct number.\nYour current Happy balance: ${balance} Birr`);
                return;
            }

            // Check receiver name
            console.log('[happy-telebirr-debug] checking receiver name:', parsed.receiverName, 'against target:', HAPPY_TELEBIRR_TARGET_NAME);
            if (!receiverNameMatchesTarget(parsed.receiverName, HAPPY_TELEBIRR_TARGET_NAME)) {
                const balance = await getCurrentHappyBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `The receiver name "${parsed.receiverName}" does not match the expected recipient "${HAPPY_TELEBIRR_TARGET_NAME}". Please ensure you sent to the correct person.\nYour current Happy balance: ${balance} Birr`);
                return;
            }

            const receiptCheck = await validateHappyReceiptUrl(parsed.receiptUrl);
            console.log('[RECEIPT-DEBUG] Receipt validation result:', receiptCheck);
            if (!receiptCheck.ok) {
                const balance = await getCurrentHappyBalanceByTelegramId(userId);
                const reason = receiptCheck.reason === 'invalid_receipt' ? 'The receipt link is invalid.' : 'Could not verify the receipt link.';
                console.log('[RECEIPT-DEBUG] Receipt validation failed:', receiptCheck.reason, receiptCheck.details);
                bot.sendMessage(chatId, `${reason} Please double check and try again.\nYour current Happy balance: ${balance} Birr\nError: ${receiptCheck.reason} - ${receiptCheck.details || 'Unknown'}`);
                return;
            }

            // Check credited party name from receipt (more secure than SMS)
            const receiptCreditedName = receiptCheck.parsed?.credited_party_name || receiptCheck.creditedPartyName;
            console.log('[happy-telebirr-debug] checking receipt credited party name:', receiptCreditedName, 'against target:', HAPPY_TELEBIRR_TARGET_NAME);
            if (receiptCreditedName && !receiverNameMatchesTarget(receiptCreditedName, HAPPY_TELEBIRR_TARGET_NAME)) {
                const balance = await getCurrentHappyBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `❌ Happy deposit rejected: The receipt shows the money was sent to "${receiptCreditedName}" instead of "${HAPPY_TELEBIRR_TARGET_NAME}". Please ensure you sent to the correct recipient.\nYour current Happy balance: ${balance} Birr`);
                return;
            }

            const parsedReceipt = receiptCheck.parsed || null;
            let amountFromReceipt = parsedReceipt && (Number(parsedReceipt.settled_amount) || Number(parsedReceipt.total_amount)) || 0;
            if (!amountFromReceipt || amountFromReceipt <= 0) {
                if (receiptCheck.amountFallback && receiptCheck.amountFallback > 0) {
                    amountFromReceipt = receiptCheck.amountFallback;
                } else {
                    amountFromReceipt = parsed.amount || 0;
                }
            }

            if (!amountFromReceipt || amountFromReceipt <= 0) {
                const balance = await getCurrentHappyBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `Could not determine the deposit amount from your receipt. Please try again.\nYour current Happy balance: ${balance} Birr`);
                return;
            }

            // Get user data and credit the deposit
            const userData = await getUserData(userId);
            if (!userData) {
                bot.sendMessage(chatId, `❌ User not found. Please register first using /start`);
                return;
            }

            const transactionId = `happy_telebirr_${parsed.transactionNumber}`;
            const creditResult = await creditHappyUserDeposit(
                userData.uid,
                amountFromReceipt,
                transactionId
            );

            if (creditResult.credited) {
                const successMessage = `
✅ **Happy TeleBirr Deposit Successful!**

💰 **Amount:** ${amountFromReceipt} Birr
🆔 **Transaction ID:** ${parsed.transactionNumber}
💳 **Method:** TeleBirr
📱 **Phone:** ${HAPPY_TELEBIRR_TARGET_PHONE_LOCAL}
👤 **Recipient:** ${HAPPY_TELEBIRR_TARGET_NAME}

📊 **Account Update:**
• New Balance: ${creditResult.balance} Birr
• Withdrawable: ${creditResult.withdrawable} Birr

🎁 **Happy Bonus:** Your deposit is immediately withdrawable!

🌟 Thank you for your Happy deposit! Start playing now! 🌟
                `;

                bot.sendMessage(chatId, successMessage, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '🎮 Play Game', url: `${gameUrl}?uid=${userData.uid}` }
                            ],
                            [
                                { text: '💰 Check Balance', callback_data: 'balance' },
                                { text: '💸 Withdraw', callback_data: 'withdraw' }
                            ]
                        ]
                    }
                });

                console.log(`[Happy Bot] TeleBirr deposit processed successfully: ${amountFromReceipt} Birr for user ${userId}`);

            } else if (creditResult.duplicate) {
                bot.sendMessage(chatId, `❌ **Error processing deposit**

Please try again or contact support if the issue persists.`, { parse_mode: 'Markdown' });

            } else {
                bot.sendMessage(chatId, `❌ **Happy Deposit Processing Failed**

${creditResult.error || 'Unknown error occurred'}

Please try again or contact support if the issue persists.`, { parse_mode: 'Markdown' });
            }

        } catch (error) {
            console.error('[Happy Bot] TeleBirr processing error:', error);
            const balance = await getCurrentHappyBalanceByTelegramId(userId);
            bot.sendMessage(chatId, `❌ **Error processing deposit**

Please try again or contact support if the issue persists.

Your current Happy balance: ${balance} Birr`, { parse_mode: 'Markdown' });
        }

    } else if (userState.waitingForCBEReceipt) {
        // Process CBE receipt with advanced validation
        bot.sendMessage(chatId, '⏳ We are processing your Happy CBE Birr deposit. This will only take less than a minute...');

        try {
            const parsed = parseHappyCBEBirrReceipt(receiptText);
            console.log('[happy-cbe-debug] SMS parsed:', parsed);

            if (!parsed.transactionNumber || !parsed.receiptUrl) {
                const balance = await getCurrentHappyBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `Could not parse your CBE Birr message. Please paste the full transaction message including the receipt link.\nYour current Happy balance: ${balance} Birr`);
                return;
            }

            // Validate the receipt URL with PDF parsing
            const receiptCheck = await validateHappyCBEReceiptUrl(parsed.receiptUrl);
            console.log('[happy-cbe-debug] CBE receipt check:', receiptCheck);

            if (!receiptCheck.ok) {
                const balance = await getCurrentHappyBalanceByTelegramId(userId);
                let errorMessage = 'Could not verify the receipt. Please try again.';

                if (receiptCheck.reason === 'data_mismatch') {
                    errorMessage = `The receipt data does not match the expected recipient. Please ensure you sent to the correct person (${HAPPY_CBE_TARGET_NAME}).`;
                } else if (receiptCheck.reason === 'pdf_parse_failed') {
                    errorMessage = 'Could not extract transaction details from the receipt. Please try again.';
                } else if (receiptCheck.reason === 'transaction_not_completed') {
                    errorMessage = 'The transaction is not completed yet. Please wait and try again.';
                }

                bot.sendMessage(chatId, `${errorMessage}\nYour current Happy balance: ${balance} Birr`);
                return;
            }

            // Use amount from PDF validation ONLY (no SMS fallback)
            const finalAmount = receiptCheck.amount;
            if (!finalAmount || finalAmount <= 0) {
                const balance = await getCurrentHappyBalanceByTelegramId(userId);
                bot.sendMessage(chatId, `Could not determine the deposit amount from receipt validation. Please try again.\nYour current Happy balance: ${balance} Birr`);
                return;
            }

            // Get user data and credit the deposit
            const userData = await getUserData(userId);
            if (!userData) {
                bot.sendMessage(chatId, `❌ User not found. Please register first using /start`);
                return;
            }

            const transactionId = `happy_cbe_${parsed.transactionNumber}`;
            const creditResult = await creditHappyUserDeposit(
                userData.uid,
                finalAmount,
                transactionId
            );

            if (creditResult.credited) {
                const successMessage = `
✅ **Happy CBE Birr Deposit Successful!**

💰 **Amount:** ${finalAmount} Birr
🆔 **Transaction ID:** ${parsed.transactionNumber}
💳 **Method:** CBE Birr
📱 **Phone:** ${HAPPY_CBE_TARGET_PHONE_LOCAL}
👤 **Recipient:** ${HAPPY_CBE_TARGET_NAME}

📊 **Account Update:**
• New Balance: ${creditResult.balance} Birr
• Withdrawable: ${creditResult.withdrawable} Birr

🎁 **Happy Bonus:** Your deposit is immediately withdrawable!

🌟 Thank you for your Happy deposit! Start playing now! 🌟
                `;

                bot.sendMessage(chatId, successMessage, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '🎮 Play Game', url: `${gameUrl}?uid=${userData.uid}` }
                            ],
                            [
                                { text: '💰 Check Balance', callback_data: 'balance' },
                                { text: '💸 Withdraw', callback_data: 'withdraw' }
                            ]
                        ]
                    }
                });

                console.log(`[Happy Bot] CBE deposit processed successfully: ${finalAmount} Birr for user ${userId}`);

            } else if (creditResult.duplicate) {
                bot.sendMessage(chatId, `❌ **Error processing deposit**

Please try again or contact support if the issue persists.`, { parse_mode: 'Markdown' });

            } else {
                bot.sendMessage(chatId, `❌ **Happy Deposit Processing Failed**

${creditResult.error || 'Unknown error occurred'}

Please try again or contact support if the issue persists.`, { parse_mode: 'Markdown' });
            }

        } catch (error) {
            console.error('[Happy Bot] CBE processing error:', error);
            const balance = await getCurrentHappyBalanceByTelegramId(userId);
            bot.sendMessage(chatId, `❌ **Error Processing Happy CBE Deposit**

An unexpected error occurred while processing your deposit.
Please try again or contact support.

Your current Happy balance: ${balance} Birr
Error details: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }
}

// Handle errors
bot.on('error', (error) => {
    console.error('Happy Bot error:', error);
});

// Global error handlers to prevent crashes
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection in Happy Bot:', reason);
    // Don't exit the process, just log the error
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception in Happy Bot:', error);
    // Don't exit the process, just log the error
});

// Bot is ready to be started
// Note: Bot will be started by bot-manager.js when both bots are needed

// Start polling if this file is run directly (not required as module)
if (require.main === module) {
    console.log('🚀 Starting Happy Bot directly...');
    bot.startPolling();
}

module.exports = bot;
