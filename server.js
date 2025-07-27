// server.js
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// WebSocket server setup
const wss = new WebSocket.Server({ port: 3000 });
console.log('WebSocket server started on ws://localhost:3000');

// Database setup
const DB_PATH = path.resolve(__dirname, 'news.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initDb();
    }
});

/**
 * Initializes the database tables if they don't exist.
 */
function initDb() {
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS articles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                imageUrl TEXT,
                timestamp INTEGER NOT NULL
            )
        `, (err) => {
            if (err) console.error('Error creating articles table:', err.message);
            else console.log('Articles table ensured.');
        });

        db.run(`
            CREATE TABLE IF NOT EXISTS comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                article_id INTEGER NOT NULL,
                userName TEXT NOT NULL,
                commentText TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
            )
        `, (err) => {
            if (err) console.error('Error creating comments table:', err.message);
            else console.log('Comments table ensured.');
        });

        db.run(`
            CREATE TABLE IF NOT EXISTS reactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                article_id INTEGER NOT NULL,
                clientId TEXT NOT NULL,
                type TEXT NOT NULL, -- 'thumbs_up', 'love', 'sad'
                timestamp INTEGER NOT NULL,
                FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
            )
        `, (err) => {
            if (err) console.error('Error creating reactions table:', err.message);
            else console.log('Reactions table ensured.');
        });
    });
}

/**
 * Fetches all articles along with their comments and reactions.
 * @returns {Promise<Array>} A promise that resolves to an array of article objects.
 */
async function getAllArticles() {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM articles ORDER BY timestamp DESC", async (err, articles) => {
            if (err) {
                return reject(err);
            }

            const articlesWithDetails = [];
            for (const article of articles) {
                const comments = await new Promise((res, rej) => {
                    db.all("SELECT userName, commentText, timestamp FROM comments WHERE article_id = ? ORDER BY timestamp ASC", [article.id], (err, rows) => {
                        if (err) rej(err);
                        else res(rows);
                    });
                });

                const reactions = await new Promise((res, rej) => {
                    db.all("SELECT clientId, type, timestamp FROM reactions WHERE article_id = ?", [article.id], (err, rows) => {
                        if (err) rej(err);
                        else res(rows);
                    });
                });

                articlesWithDetails.push({
                    id: article.id,
                    title: article.title,
                    content: article.content,
                    imageUrl: article.imageUrl,
                    timestamp: article.timestamp,
                    comments: comments,
                    reactions: reactions
                });
            }
            resolve(articlesWithDetails);
        });
    });
}

/**
 * Adds a new article to the database.
 * @param {object} article - The article data.
 * @returns {Promise<object>} A promise that resolves to the inserted article with its ID.
 */
async function addArticle(article) {
    return new Promise((resolve, reject) => {
        db.run(
            "INSERT INTO articles (title, content, imageUrl, timestamp) VALUES (?, ?, ?, ?)",
            [article.title, article.content, article.imageUrl, article.timestamp],
            function(err) { // Use function() for 'this' context
                if (err) {
                    return reject(err);
                }
                resolve({ id: this.lastID, ...article });
            }
        );
    });
}

/**
 * Adds a new comment to the database.
 * @param {number} articleId - The ID of the article.
 * @param {object} comment - The comment data.
 * @returns {Promise<object>} A promise that resolves to the inserted comment.
 */
async function addComment(articleId, comment) {
    return new Promise((resolve, reject) => {
        db.run(
            "INSERT INTO comments (article_id, userName, commentText, timestamp) VALUES (?, ?, ?, ?)",
            [articleId, comment.userName, comment.commentText, comment.timestamp],
            function(err) {
                if (err) {
                    return reject(err);
                }
                resolve({ id: this.lastID, ...comment });
            }
        );
    });
}

/**
 * Adds a new reaction to the database.
 * @param {number} articleId - The ID of the article.
 * @param {object} reaction - The reaction data.
 * @returns {Promise<object>} A promise that resolves to the inserted reaction.
 */
async function addReaction(articleId, reaction) {
    return new Promise((resolve, reject) => {
        db.run(
            "INSERT INTO reactions (article_id, clientId, type, timestamp) VALUES (?, ?, ?, ?)",
            [articleId, reaction.clientId, reaction.type, reaction.timestamp],
            function(err) {
                if (err) {
                    return reject(err);
                }
                resolve({ id: this.lastID, ...reaction });
            }
        );
    });
}


/**
 * Sends a message to all connected WebSocket clients.
 * @param {object} message - The message object to send.
 */
function broadcast(message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

// WebSocket connection handling
wss.on('connection', async (ws) => {
    console.log('Client connected.');

    // Send all existing articles to the newly connected client
    try {
        const articles = await getAllArticles();
        ws.send(JSON.stringify({ type: 'ALL_ARTICLES', articles: articles }));
    } catch (error) {
        console.error('Error sending initial articles:', error);
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Failed to load articles.' }));
    }

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Received:', data.type, 'from client');

            switch (data.type) {
                case 'PUBLISH_ARTICLE':
                    const newArticle = await addArticle(data.article);
                    // Broadcast the newly published article (with its ID from DB) to all clients
                    broadcast({ type: 'NEW_ARTICLE', article: newArticle });
                    break;
                case 'POST_COMMENT':
                    const { articleId: commentArticleId, comment } = data;
                    const addedComment = await addComment(commentArticleId, comment);
                    // Broadcast the new comment to all clients
                    broadcast({ type: 'NEW_COMMENT', articleId: commentArticleId, comment: addedComment });
                    break;
                case 'POST_REACTION':
                    const { articleId: reactionArticleId, reaction } = data;
                    const addedReaction = await addReaction(reactionArticleId, reaction);
                    // Broadcast the new reaction to all clients
                    broadcast({ type: 'NEW_REACTION', articleId: reactionArticleId, reaction: addedReaction });
                    break;
                case 'GET_ALL_ARTICLES': // This case is primarily for initial connection, but kept for clarity
                    const articles = await getAllArticles();
                    ws.send(JSON.stringify({ type: 'ALL_ARTICLES', articles: articles }));
                    break;
                default:
                    console.warn('Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('Error processing message:', error);
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Server error processing your request.' }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected.');
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});
