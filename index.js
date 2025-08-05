const bot = require('./bot');

// Start the bot
console.log('🚀 Starting Genius Bingo Telegram Bot...');

// Handle process termination
process.on('SIGINT', () => {
    console.log('\n🛑 Bot is shutting down...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Bot is shutting down...');
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
}); 