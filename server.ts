import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import { fileURLToPath } from 'url';
import next from 'next';
import { Server, Socket } from 'socket.io';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import sanitizeHtml from 'sanitize-html';

const __dirname = path.dirname(fileURLToPath(import.meta.url));


// Rate Limiters
// Message limiter: 5 messages per second per socket
const messageLimiter = new RateLimiterMemory({
    points: 5,
    duration: 1,
});

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = 3000;
// when using middleware `hostname` and `port` must be provided below
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

async function main() {
    // Open SQLite database
    const db: Database<sqlite3.Database, sqlite3.Statement> = await open({
        filename: path.join(__dirname, 'chat.db'),
        driver: sqlite3.Database
    });

    // Create table (Ensure schema)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user TEXT,
            text TEXT,
            time TEXT
        )
    `);

    await app.prepare();

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        try {
            if (!req.url) {
                res.statusCode = 400;
                res.end('Bad Request');
                return;
            }
            const parsedUrl = parse(req.url, true);
            await handle(req, res, parsedUrl);
        } catch (err) {
            console.error('Error occurred handling', req.url, err);
            res.statusCode = 500;
            res.end('internal server error');
        }
    });

    const io = new Server(server, {
        path: '/api/socket/io', // Use a specific path to avoid conflicts
        addTrailingSlash: false,
    });

    io.on('connection', async (socket: Socket) => {
        // Log connection for auditing (simplified)
        // console.log(`New connection from ${socket.handshake.address}`);

        // Send existing messages (limit 50)
        try {
            const messages = await db.all('SELECT * FROM messages ORDER BY id DESC LIMIT 50');
            socket.emit('init_messages', messages.reverse());

            // Send user count
            io.emit('users', io.engine.clientsCount);
        } catch (e) {
            console.error("Error fetching messages:", e);
        }

        socket.on('message', async (data: { user: string; text: string }) => {
            try {
                // Rate Limiting
                try {
                    await messageLimiter.consume(socket.id);
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                } catch (rejRes) {
                    // Rate limit exceeded
                    // Optionally emit an error to the client
                    // socket.emit('error', 'Rate limit exceeded');
                    return;
                }

                // Input Validation
                // Must be a string, must exist, must have user
                if (!data.user || !data.text || typeof data.text !== 'string') return;

                // Max length check (e.g. 500 characters)
                if (data.text.length > 500) return;

                // Sanitization (Strip all HTML tags to prevent XSS)
                const cleanText = sanitizeHtml(data.text, {
                    allowedTags: [],
                    allowedAttributes: {}
                });

                if (!cleanText.trim()) return; // Don't save empty messages

                const time = new Date().toISOString();
                const result = await db.run(
                    'INSERT INTO messages (user, text, time) VALUES (?, ?, ?)',
                    data.user,
                    cleanText,
                    time
                );

                // Broadcast to all (including sender)
                io.emit('message', {
                    id: (result.lastID || 0).toString(),
                    user: data.user,
                    text: cleanText,
                    time: time
                });
            } catch (e) {
                console.error("Error saving message:", e);
            }
        });

        socket.on('disconnect', () => {
            io.emit('users', io.engine.clientsCount);
        });
    });

    server.listen(port, () => {
        console.log(`> Ready on http://${hostname}:${port}`);
    });
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
