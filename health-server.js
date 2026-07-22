const http = require('http');

/**
 * Tiny HTTP server so Northflank public URLs / health checks work.
 * The Telegram bot itself uses long-polling and does not need this.
 */
function startHealthServer() {
    const port = Number(process.env.PORT || process.env.NF_PORT || 8080);

    const server = http.createServer((req, res) => {
        if (req.url === '/health' || req.url === '/healthz' || req.url === '/') {
            const body = JSON.stringify({
                ok: true,
                service: 'yg-bingo-bot',
                gameUrl: process.env.GAME_URL || 'https://ygbingo.netlify.app/',
                time: new Date().toISOString(),
            });
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
            });
            res.end(body);
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not_found' }));
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(`✅ Health server listening on 0.0.0.0:${port}`);
    });

    server.on('error', (err) => {
        console.error('❌ Health server error:', err.message);
    });

    return server;
}

module.exports = { startHealthServer };
