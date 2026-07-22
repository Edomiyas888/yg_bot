# 🤖 Genius Bingo Telegram Bot

A Telegram bot for the Genius Bingo gaming platform that allows users to play bingo games, manage their balance, and interact with the gaming system.

## 🚀 Features

- **🎮 Play Bingo**: Start games with different stake amounts
- **💰 Balance Management**: Check balance, deposit, and withdraw funds
- **📊 Leaderboard**: View top players and rankings
- **👤 User Profiles**: Track gaming statistics and achievements
- **💳 Payment Integration**: Support for bank transfers and mobile money
- **🎯 Interactive UI**: Inline keyboards and buttons for easy navigation

## 📋 Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- Telegram Bot Token (from @BotFather)

## 🛠️ Installation

1. **Clone or navigate to the bot directory:**
   ```bash
   cd telegram-bot
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables:**
   - Copy `.env.example` to `.env`
   - Add your Telegram bot token and other configuration

4. **Start the bot:**
   ```bash
   npm start
   ```

## 🔧 Configuration

### Getting a Telegram Bot Token

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` command
3. Follow the instructions to create your bot
4. Copy the token provided by BotFather

### Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
BOT_TOKEN=your_telegram_bot_token_here
BOT_USERNAME=your_bot_username_here
HAPPY_BOT_TOKEN=your_happy_bot_token_here
GAME_URL=https://ygbingo.netlify.app
WEBHOOK_URL=https://your-domain.com/webhook
```

Never commit `.env` — only `.env.example` belongs in git.

## 🎮 Bot Commands

- `/start` - Start the bot and show main menu
- `/help` - Show help information
- `/play` - Start a new bingo game
- `/balance` - Check your account balance
- `/deposit` - Add funds to your account
- `/withdraw` - Withdraw your winnings
- `/leaderboard` - View top players
- `/profile` - View your profile and statistics

## 🏗️ Project Structure

```
telegram-bot/
├── bot.js              # Main bot logic and handlers
├── index.js            # Entry point
├── .env.example        # Env template (safe to commit)
├── .env                # Local secrets (gitignored)
├── package.json        # Dependencies and scripts
└── README.md          # This file
```

## 🔄 Development

### Running in Development Mode

```bash
npm run dev
```

This will start the bot with nodemon for automatic restarts on file changes.

### Adding New Features

1. **New Commands**: Add handlers in `bot.js`
2. **Database Integration**: Connect to your preferred database
3. **Payment Processing**: Integrate with payment gateways
4. **Game Logic**: Implement actual bingo game mechanics

## 🌐 Webhook Setup (Optional)

For production deployment, you can use webhooks instead of polling:

```javascript
// In bot.js
const bot = new TelegramBot(token, { webHook: { port: 8443 } });
bot.setWebHook(`${webhookUrl}/bot${token}`);
```

## 🔒 Security Considerations

- Keep your bot token secure
- Use environment variables for sensitive data
- Implement rate limiting for API calls
- Validate user input
- Use HTTPS for webhooks

## 📱 Testing

1. Start the bot: `npm start`
2. Open Telegram and search for your bot
3. Send `/start` to begin testing
4. Test all commands and features

## 🚀 Deployment

### Local Development
```bash
npm start
```

### Production Deployment
- Use PM2 or similar process manager
- Set up environment variables
- Configure webhooks if needed
- Monitor logs and performance

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

This project is licensed under the ISC License.

## 🆘 Support

For support and questions:
- Create an issue in the repository
- Contact the development team
- Check the documentation

## 🔮 Future Enhancements

- [ ] Database integration (MongoDB/PostgreSQL)
- [ ] Real-time game updates
- [ ] Payment gateway integration
- [ ] Multi-language support
- [ ] Advanced analytics
- [ ] Admin panel
- [ ] Push notifications
- [ ] Tournament system

---

**Happy Gaming! 🎰🏆** 