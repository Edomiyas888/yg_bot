const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config({ path: './config.env' });

// Bot configuration
const token = process.env.BOT_TOKEN;
const gameUrl = process.env.GAME_URL;
const bot = new TelegramBot(token, { polling: true });

// Store user data (in production, use a database)
const userData = new Map();

// Bot commands
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name;

    const welcomeMessage = `
🎰 Welcome to Genius Bingo Bot, ${userName}! 🏆

I'm here to help you with your bingo gaming experience.

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
                    { text: '🌐 Play on Web', url: gameUrl }
                ]
            ]
        }
    });
});

bot.onText(/\/web/, (msg) => {
    const chatId = msg.chat.id;

    const webMessage = `
🌐 Play Genius Bingo on Web

Click the button below to play on our web platform:

${gameUrl}

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
                    { text: '🌐 Open Web Game', url: gameUrl }
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

bot.onText(/\/play/, (msg) => {
    const chatId = msg.chat.id;

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
                    { text: '🌐 Play on Web', url: gameUrl }
                ],
                [
                    { text: '🔙 Back to Menu', callback_data: 'back_to_main' }
                ]
            ]
        }
    });
});

bot.onText(/\/balance/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Get user balance (in production, fetch from database)
    const balance = userData.get(userId)?.balance || 0;

    const balanceMessage = `
💰 Your Balance: ${balance} Birr

Recent transactions:
• No recent activity

🌐 Check detailed balance on web: ${gameUrl}
  `;

    bot.sendMessage(chatId, balanceMessage, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🌐 View on Web', url: gameUrl }
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
                            { text: '🌐 Play on Web', url: gameUrl }
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
            const balance = userData.get(userId)?.balance || 0;
            const balanceMessage = `
💰 Your Balance: ${balance} Birr

Recent transactions:
• No recent activity

🌐 Check detailed balance on web: ${gameUrl}
      `;

            bot.editMessageText(balanceMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🌐 View on Web', url: gameUrl }
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

🌐 View full leaderboard: ${gameUrl}
      `;

            bot.editMessageText(leaderboardMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🌐 View Full Leaderboard', url: gameUrl }
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
• Current Balance: ${userData.get(userId)?.balance || 0} Birr

🎯 Achievement: New Player

🌐 View detailed profile: ${gameUrl}
      `;

            bot.editMessageText(profileMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🌐 View Full Profile', url: gameUrl }
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

🌐 For instant deposits, visit: ${gameUrl}
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
                            { text: '🌐 Deposit on Web', url: gameUrl }
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

Your balance: ${userData.get(userId)?.balance || 0} Birr

Choose withdrawal method:

🌐 For instant withdrawals, visit: ${gameUrl}
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
                            { text: '🌐 Withdraw on Web', url: gameUrl }
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
                            { text: '🌐 Play on Web', url: gameUrl }
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

🌐 For better gaming experience, play on web: ${gameUrl}
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
                    { text: '🌐 Play on Web', url: gameUrl }
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

🌐 For full gaming experience, play on web: ${gameUrl}
        `;

                bot.editMessageText(cartelaMessage, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '🌐 Play Full Game on Web', url: gameUrl }
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