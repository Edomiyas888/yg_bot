const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
const serviceAccount = {
    "type": "service_account",
    "project_id": "geno-5e7f5",
    "private_key_id": process.env.FIREBASE_PRIVATE_KEY_ID,
    "private_key": process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    "client_email": process.env.FIREBASE_CLIENT_EMAIL,
    "client_id": process.env.FIREBASE_CLIENT_ID,
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
    "client_x509_cert_url": process.env.FIREBASE_CLIENT_CERT_URL
};

// Initialize Firebase Admin
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://geno-5e7f5-default-rtdb.firebaseio.com"
    });
}

const db = admin.firestore();

// Load environment variables - try config file first, then use process.env directly
let configLoaded = false;
try {
    require('dotenv').config({ path: './config.env' });
    configLoaded = true;
    console.log('📁 Loaded configuration from config.env file');
} catch (error) {
    console.log('📁 Using environment variables (deployment mode)');
}

// Bot configuration with validation
const token = process.env.BOT_TOKEN;
const gameUrl = process.env.GAME_URL || 'https://GeniusBingoBot.netlify.app';

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
    console.error('Please check your config.env file and ensure BOT_TOKEN is set correctly.');
    console.error('Current token value:', token);
    console.error('Available environment variables:', Object.keys(process.env).filter(key => key.includes('BOT')));

    // For deployment, provide specific instructions
    if (!configLoaded) {
        console.error('\n🚀 DEPLOYMENT SETUP:');
        console.error('Please set the following environment variables in your deployment platform:');
        console.error('BOT_TOKEN=8318709913:AAHXq3iMDq3gIZ4ymK_qD743VvQ09Rpt-II');
        console.error('GAME_URL=https://GeniusBingoBot.netlify.app');
        console.error('BOT_USERNAME=GeniusBingoBot');
    }

    process.exit(1);
}

// Validate game URL
if (!gameUrl || gameUrl === 'https://your-domain.com/webhook') {
    console.warn('⚠️  Warning: Game URL not configured properly');
    console.warn('Please update GAME_URL in config.env file');
}

console.log('✅ Bot token loaded successfully');
console.log('✅ Game URL:', gameUrl);

const bot = new TelegramBot(token, { polling: true });

// Store user data (in production, use a database)
const userData = new Map();

// Function to check if user is registered
async function isUserRegistered(userId) {
    try {
        const userDoc = await db.collection('users').where('telegramId', '==', userId.toString()).get();
        return !userDoc.empty;
    } catch (error) {
        console.error('Error checking user registration:', error);
        return false;
    }
}

// Function to get user data from Firebase
async function getUserData(userId) {
    try {
        const userDoc = await db.collection('users').where('telegramId', '==', userId.toString()).get();
        if (!userDoc.empty) {
            return userDoc.docs[0].data();
        }
        return null;
    } catch (error) {
        console.error('Error getting user data:', error);
        return null;
    }
}

// Function to create user in Firebase
async function createUser(userId, userName, phone) {
    try {
        const userRef = await db.collection('users').add({
            telegramId: userId.toString(),
            userName: userName,
            phone: phone,
            wallet: 10, // Default 10 birr
            isAdult: true,
            agreeTerms: true,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return userRef.id;
    } catch (error) {
        console.error('Error creating user:', error);
        throw error;
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
🎰 Welcome to Genius Bingo Bot t, ${userName}! 🏆

I'm here to help you with your bingo gaming experience.

To get started, please register with your phone number to receive 10 Birr bonus!
  `;

        bot.sendMessage(chatId, welcomeMessage, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: '📱 Register with Phone', request_contact: true }]
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
/leaderboard - View top players
/profile - View your profile
/web - Play on web platform

How can I help you today?
  `;

        bot.sendMessage(chatId, welcomeMessage, {
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
                        { text: '🌐 Play on Web', url: `${gameUrl}?uid=${userData?.uid || ''}` }
                    ]
                ]
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
            // Create user in Firebase
            const uid = await createUser(userId, userName, contact.phone_number);

            const successMessage = `
✅ Registration Successful!

Welcome to Genius Bingo, ${userName}!
Your account has been created with 10 Birr bonus.

Your UID: ${uid}

You can now start playing!
  `;

            bot.sendMessage(chatId, successMessage, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🎮 Play Now', callback_data: 'play' },
                            { text: '💰 Check Balance', callback_data: 'balance' }
                        ],
                        [
                            { text: '🌐 Play on Web', url: `${gameUrl}?uid=${uid}` }
                        ]
                    ]
                }
            });
        } catch (error) {
            console.error('Registration error:', error);
            bot.sendMessage(chatId, '❌ Registration failed. Please try again later.');
        }
    } else {
        bot.sendMessage(chatId, '❌ Please share your own phone number for registration.');
    }
});

bot.onText(/\/web/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

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
                    { text: '🌐 Open Web Game', url: `${gameUrl}?uid=${uid}` }
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
                            { text: '🌐 Play on Web', url: `${gameUrl}?uid=${uid}` }
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

        case 'balance':
            const balance = userData?.wallet || 0;
            const balanceMessage = `
💰 Your Balance: ${balance} Birr

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
• Current Balance: ${userData?.wallet || 0} Birr

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
💳 Deposit Funds

Choose deposit method:

🌐 For instant deposits, visit: ${gameUrl}?uid=${uid}
      `;

            bot.editMessageText(depositMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '💳 Bank Transfer', callback_data: 'deposit_bank' },
                            { text: '📱 Mobile Money', callback_data: 'deposit_mobile' }
                        ],
                        [
                            { text: '🌐 Deposit on Web', url: `${gameUrl}?uid=${uid}` }
                        ],
                        [
                            { text: '🔙 Back', callback_data: 'back_to_main' }
                        ]
                    ]
                }
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
                            { text: '🏦 Bank Account', callback_data: 'withdraw_bank' },
                            { text: '📱 Mobile Money', callback_data: 'withdraw_mobile' }
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

module.exports = bot; 