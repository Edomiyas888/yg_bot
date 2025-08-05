require('dotenv').config({ path: './config.env' });

console.log('🔍 Testing Configuration...\n');

// Test bot token
const token = process.env.BOT_TOKEN;
console.log('Bot Token Status:', token ? '✅ Found' : '❌ Missing');
if (token) {
    console.log('Token Preview:', token.substring(0, 10) + '...' + token.substring(token.length - 4));
}

// Test game URL
const gameUrl = process.env.GAME_URL;
console.log('Game URL Status:', gameUrl ? '✅ Found' : '❌ Missing');
if (gameUrl) {
    console.log('Game URL:', gameUrl);
}

// Test bot username
const botUsername = process.env.BOT_USERNAME;
console.log('Bot Username Status:', botUsername ? '✅ Found' : '❌ Missing');
if (botUsername) {
    console.log('Bot Username:', botUsername);
}

console.log('\n📋 All Environment Variables:');
console.log('BOT_TOKEN:', token ? 'SET' : 'NOT SET');
console.log('GAME_URL:', gameUrl ? 'SET' : 'NOT SET');
console.log('BOT_USERNAME:', botUsername ? 'SET' : 'NOT SET');

if (!token || token === 'your_telegram_bot_token_here') {
    console.log('\n❌ Configuration Error: Bot token is not properly configured!');
    console.log('Please check your config.env file.');
    process.exit(1);
} else {
    console.log('\n✅ Configuration looks good! You can start the bot.');
} 