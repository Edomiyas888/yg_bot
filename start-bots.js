#!/usr/bin/env node

/**
 * Dual Bot Startup Script
 * 
 * This script starts both the Main Genius Bingo Bot and Happy Genius Bingo Bot
 * simultaneously using the BotManager component.
 * 
 * Usage:
 *   node start-bots.js
 *   npm run start:both
 */

const botManager = require('./bot-manager');

// The bot manager will automatically start both bots
// This script just provides a clean entry point

console.log('🎯 Dual Bot Startup Script');
console.log('==========================');
console.log('');

// Display startup information
console.log('📋 Bot Configuration:');
console.log('   🤖 Main Bot: Genius Bingo Bot');
console.log('   🎉 Happy Bot: Happy Genius Bingo Bot');
console.log('   🌐 Web Game: https://geno-831c6.web.app');
console.log('');

// The bot manager handles everything from here
// Both bots will start automatically and run concurrently






