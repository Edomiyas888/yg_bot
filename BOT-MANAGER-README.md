# 🤖 Dual Bot Manager

This component allows you to start both the **Main Genius Bingo Bot** and **Happy Genius Bingo Bot** simultaneously with a single command.

## 🚀 Quick Start

### Start Both Bots
```bash
# Using npm script
npm run both
# or
npm run start:both

# Using direct command
node start-bots.js

# Using bot manager directly
node bot-manager.js
```

### Start Individual Bots
```bash
# Main bot only
npm start
node bot-deploy.js

# Happy bot only
npm run happy
node happy-bot.js
```

## 📋 Available Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `both` | `npm run both` | Start both bots simultaneously |
| `start:both` | `npm run start:both` | Alternative command for both bots |
| `manager` | `npm run manager` | Start bot manager directly |
| `start` | `npm start` | Start main bot only |
| `happy` | `npm run happy` | Start happy bot only |

## 🏗️ Architecture

### Bot Manager (`bot-manager.js`)
- **Purpose**: Manages both bots simultaneously
- **Features**:
  - Unified startup and shutdown
  - Error handling for both bots
  - Status monitoring
  - Uptime tracking
  - Graceful shutdown handling

### Individual Bot Files
- **`bot-deploy.js`**: Main Genius Bingo Bot
- **`happy-bot.js`**: Happy Genius Bingo Bot
- **`start-bots.js`**: Clean entry point for dual bot startup

## 🔧 Features

### ✅ Unified Management
- Start both bots with one command
- Centralized error handling
- Coordinated shutdown process

### ✅ Status Monitoring
- Real-time bot status
- Uptime tracking
- Error logging

### ✅ Graceful Shutdown
- Handles SIGINT and SIGTERM signals
- Proper cleanup on exit
- Uptime reporting

## 📊 Bot Information

### Main Bot (Genius Bingo Bot)
- **Token**: Uses main bot token
- **Users**: Regular users (no prefix)
- **Features**: Full gaming functionality
- **Collection**: Uses standard collections

### Happy Bot (Happy Genius Bingo Bot)
- **Token**: Uses happy bot token
- **Users**: Happy users (happy_ prefix)
- **Features**: Same functionality as main bot
- **Collection**: Uses same collections with happy_ flags

## 🛠️ Configuration

Both bots use the same Firebase configuration but with different:
- Telegram bot tokens
- User ID prefixes (happy_ vs regular)
- Bot source flags for dashboard filtering

## 📝 Logs

When running both bots, you'll see:
```
🚀 Starting Bot Manager...
==================================================
🤖 Starting Main Genius Bingo Bot...
🎉 Starting Happy Genius Bingo Bot...
✅ Both bots are now running!
==================================================
📊 Bot Status:
   🤖 Main Bot: ✅ Running
   🎉 Happy Bot: ✅ Running
   ⏰ Started at: [timestamp]
==================================================
🌟 Bot Manager is ready! Both bots are listening for messages...
```

## 🔄 Shutdown

To stop both bots:
- Press `Ctrl+C` (SIGINT)
- Send SIGTERM signal
- The manager will gracefully shutdown both bots

## 🐛 Troubleshooting

### Bot Not Starting
1. Check if ports are available
2. Verify bot tokens in environment variables
3. Ensure Firebase configuration is correct

### One Bot Fails
- The other bot will continue running
- Check logs for specific error messages
- Restart the bot manager

### Memory Issues
- Both bots run in the same process
- Monitor memory usage
- Consider running bots separately if needed

## 🔮 Future Enhancements

- [ ] Web dashboard for bot management
- [ ] Individual bot restart capability
- [ ] Health check endpoints
- [ ] Performance metrics
- [ ] Auto-restart on failure
- [ ] Load balancing between bots

## 📞 Support

For issues with the bot manager:
1. Check the logs for error messages
2. Verify all dependencies are installed
3. Ensure environment variables are set correctly
4. Test individual bots first before using the manager






