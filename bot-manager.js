const mainBot = require('./bot-deploy');
const happyBot = require('./happy-bot');

class BotManager {
    constructor() {
        this.bots = {
            main: mainBot,
            happy: happyBot
        };
        this.isRunning = false;
        this.startTime = null;
    }

    async startAllBots() {
        if (this.isRunning) {
            console.log('⚠️ Bots are already running!');
            return;
        }

        try {
            console.log('🚀 Starting Bot Manager...');
            console.log('='.repeat(50));

            this.startTime = new Date();
            this.isRunning = true;

            // Start both bots
            console.log('🤖 Starting Main Genius Bingo Bot...');
            this.bots.main.startPolling();

            console.log('🎉 Starting Happy Genius Bingo Bot...');
            this.bots.happy.startPolling();

            console.log('✅ Both bots are now running!');
            console.log('='.repeat(50));
            console.log('📊 Bot Status:');
            console.log(`   🤖 Main Bot: ✅ Running`);
            console.log(`   🎉 Happy Bot: ✅ Running`);
            console.log(`   ⏰ Started at: ${this.startTime.toLocaleString()}`);
            console.log('='.repeat(50));
            console.log('🌟 Bot Manager is ready! Both bots are listening for messages...');
            console.log('');

            // Set up error handling for both bots
            this.setupErrorHandling();

        } catch (error) {
            console.error('❌ Error starting bots:', error);
            this.isRunning = false;
            throw error;
        }
    }

    setupErrorHandling() {
        // Handle errors for main bot
        this.bots.main.on('error', (error) => {
            console.error('❌ Main Bot Error:', error);
            // Don't exit the process, just log the error
        });

        // Handle errors for happy bot
        this.bots.happy.on('error', (error) => {
            console.error('❌ Happy Bot Error:', error);
            // Don't exit the process, just log the error
        });

        // Handle process termination
        process.on('SIGINT', () => {
            console.log('\n🛑 Bot Manager is shutting down...');
            this.shutdown();
        });

        process.on('SIGTERM', () => {
            console.log('\n🛑 Bot Manager is shutting down...');
            this.shutdown();
        });

        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            console.error('❌ Uncaught Exception:', error);
            // Don't shutdown immediately, just log the error
            // this.shutdown();
        });

        process.on('unhandledRejection', (reason, promise) => {
            console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
            // Don't shutdown immediately, just log the error
            // this.shutdown();
        });
    }

    shutdown() {
        console.log('🔄 Shutting down Bot Manager...');
        this.isRunning = false;

        // Stop polling for both bots
        try {
            this.bots.main.stopPolling();
            console.log('🤖 Main Bot polling stopped');
        } catch (error) {
            console.error('Error stopping main bot polling:', error);
        }

        try {
            this.bots.happy.stopPolling();
            console.log('🎉 Happy Bot polling stopped');
        } catch (error) {
            console.error('Error stopping happy bot polling:', error);
        }

        if (this.startTime) {
            const uptime = new Date() - this.startTime;
            console.log(`⏰ Total uptime: ${Math.floor(uptime / 1000)} seconds`);
        }

        console.log('✅ Bot Manager shutdown complete');
        process.exit(0);
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            startTime: this.startTime,
            uptime: this.startTime ? new Date() - this.startTime : 0,
            bots: {
                main: 'running',
                happy: 'running'
            }
        };
    }

    // Method to get bot statistics
    getBotStats() {
        if (!this.isRunning) {
            return { error: 'Bots are not running' };
        }

        const uptime = this.startTime ? new Date() - this.startTime : 0;
        const uptimeSeconds = Math.floor(uptime / 1000);
        const uptimeMinutes = Math.floor(uptimeSeconds / 60);
        const uptimeHours = Math.floor(uptimeMinutes / 60);

        return {
            status: 'running',
            startTime: this.startTime,
            uptime: {
                total: uptime,
                seconds: uptimeSeconds,
                minutes: uptimeMinutes,
                hours: uptimeHours,
                formatted: `${uptimeHours}h ${uptimeMinutes % 60}m ${uptimeSeconds % 60}s`
            },
            bots: {
                main: {
                    name: 'Genius Bingo Bot',
                    status: 'running',
                    description: 'Main bot for regular users'
                },
                happy: {
                    name: 'Happy Genius Bingo Bot',
                    status: 'running',
                    description: 'Happy bot for happy_ prefixed users'
                }
            }
        };
    }

    // Method to restart bots (if needed in the future)
    async restartBots() {
        console.log('🔄 Restarting bots...');
        this.shutdown();
        // Note: In a real implementation, you might want to restart the bots
        // without shutting down the entire process
    }
}

// Create and export the bot manager instance
const botManager = new BotManager();

// Auto-start both bots when this module is required
botManager.startAllBots().catch(error => {
    console.error('❌ Failed to start bots:', error);
    process.exit(1);
});

module.exports = botManager;




