// server.js
const WebSocket = require('ws');
const { Pool } = require('pg'); // 👈 Added 'pg' library

// WebSocket server setup
const wss = new WebSocket.Server({ port: 3000 });
console.log('WebSocket server started on ws://localhost:3000');

// Database setup
const pool = new Pool({
    connectionString: process.env.newsdb, // 👈 Uses the 'newsdb' environment variable
    ssl: {
        rejectUnauthorized: false,
    },
});

/**
 * Initializes the database tables if they don't exist.
 */
async function initDb() {
    try {
        const client = await pool.connect();
        await client.query(`
            CREATE TABLE IF NOT EXISTS articles (
                id SERIAL PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                imageUrl TEXT,
                timestamp BIGINT NOT NULL
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS comments (
                id SERIAL PRIMARY KEY,
                article_id INTEGER NOT NULL,
                userName TEXT NOT NULL,
                commentText TEXT NOT NULL,
                timestamp BIGINT NOT NULL,
                FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS reactions (
                id SERIAL PRIMARY KEY,
                article_id INTEGER NOT NULL,
                clientId TEXT NOT NULL,
                type TEXT NOT NULL,
                timestamp BIGINT NOT NULL,
                FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
            )
        `);
        console.log('✅ PostgreSQL tables ensured.');
        client.release();
    } catch (err) {
        console.error('❌ Error creating PostgreSQL tables:', err.message);
    }
}
initDb();

// ----------------------------------------------------

/**
 * Fetches all articles along with their comments and reactions.
 * @returns {Promise<Array>} A promise that resolves to an array of article objects.
 */
async function getAllArticles() {
    try {
        const result = await pool.query("SELECT * FROM articles ORDER BY timestamp DESC");
        const articles = result.rows;

        const articlesWithDetails = [];
        for (const article of articles) {
            const commentsResult = await pool.query(
                "SELECT userName, commentText, timestamp FROM comments WHERE article_id = $1 ORDER BY timestamp ASC",
                [article.id]
            );

            const reactionsResult = await pool.query(
                "SELECT clientId, type, timestamp FROM reactions WHERE article_id = $1",
                [article.id]
            );

            articlesWithDetails.push({
                id: article.id,
                title: article.title,
                content: article.content,
                imageUrl: article.imageurl,
                timestamp: article.timestamp,
                comments: commentsResult.rows,
                reactions: reactionsResult.rows
            });
        }
        return articlesWithDetails;
    } catch (error) {
        console.error('Error fetching articles:', error);
        throw error;
    }
}

/**
 * Adds a new article to the database.
 * @param {object} article - The article data.
 * @returns {Promise<object>} A promise that resolves to the inserted article with its ID.
 */
async function addArticle(article) {
    try {
        const result = await pool.query(
            "INSERT INTO articles (title, content, imageUrl, timestamp) VALUES ($1, $2, $3, $4) RETURNING id",
            [article.title, article.content, article.imageUrl, article.timestamp]
        );
        return { id: result.rows[0].id, ...article };
    } catch (error) {
        console.error('Error adding article:', error);
        throw error;
    }
}

/**
 * Adds a new comment to the database.
 * @param {number} articleId - The ID of the article.
 * @param {object} comment - The comment data.
 * @returns {Promise<object>} A promise that resolves to the inserted comment.
 */
async function addComment(articleId, comment) {
    try {
        const result = await pool.query(
            "INSERT INTO comments (article_id, userName, commentText, timestamp) VALUES ($1, $2, $3, $4) RETURNING id",
            [articleId, comment.userName, comment.commentText, comment.timestamp]
        );
        return { id: result.rows[0].id, ...comment };
    } catch (error) {
        console.error('Error adding comment:', error);
        throw error;
    }
}

/**
 * Adds a new reaction to the database.
 * @param {number} articleId - The ID of the article.
 * @param {object} reaction - The reaction data.
 * @returns {Promise<object>} A promise that resolves to the inserted reaction.
 */
async function addReaction(articleId, reaction) {
    try {
        const result = await pool.query(
            "INSERT INTO reactions (article_id, clientId, type, timestamp) VALUES ($1, $2, $3, $4) RETURNING id",
            [articleId, reaction.clientId, reaction.type, reaction.timestamp]
        );
        return { id: result.rows[0].id, ...reaction };
    } catch (error) {
        console.error('Error adding reaction:', error);
        throw error;
    }
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

// ----------------------------------------------------

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
