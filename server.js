const WebSocket = require('ws');
const { Pool } = require('pg'); 
// WebSocket server setup
const wss = new WebSocket.Server({ port: 3000 });
console.log('WebSocket server started on ws://localhost:3000');

// Database setup
const pool = new Pool({
    connectionString: process.env.newsdb,
    ssl: {
        rejectUnauthorized: false,
    },
    // 👇 Add this line to disable prepared statements for Supabase's pooler
    prepare: false,
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
 * Fetches all articles along with their comments and reactions efficiently.
 * This refactored version avoids the N+1 query problem by fetching all related data
 * in separate, optimized queries and then combining them in memory.
 * @returns {Promise<Array>} A promise that resolves to an array of article objects.
 */
async function getAllArticles() {
    try {
        // Fetch all articles
        const articlesResult = await pool.query("SELECT * FROM articles ORDER BY timestamp DESC");
        const articles = articlesResult.rows;
        
        // Fetch all comments and group them by article_id, using aliasing to fix casing
        const commentsResult = await pool.query(`
            SELECT article_id, username AS "userName", commenttext AS "commentText", timestamp
            FROM comments
            ORDER BY article_id, timestamp ASC
        `);
        const commentsMap = commentsResult.rows.reduce((map, comment) => {
            if (!map[comment.article_id]) map[comment.article_id] = [];
            map[comment.article_id].push(comment);
            return map;
        }, {});
        
        // Fetch all reactions and group them by article_id, using aliasing to fix casing
        const reactionsResult = await pool.query(`
            SELECT article_id, clientid AS "clientId", type, timestamp
            FROM reactions
            ORDER BY article_id
        `);
        const reactionsMap = reactionsResult.rows.reduce((map, reaction) => {
            if (!map[reaction.article_id]) map[reaction.article_id] = [];
            map[reaction.article_id].push(reaction);
            return map;
        }, {});

        // Combine the data
        const articlesWithDetails = articles.map(article => ({
            id: article.id,
            title: article.title,
            content: article.content,
            imageUrl: article.imageurl, // Note the lowercase 'imageurl' from PostgreSQL
            timestamp: article.timestamp,
            comments: commentsMap[article.id] || [],
            reactions: reactionsMap[article.id] || []
        }));
        
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
                    if (!data.article || !data.article.title || !data.article.content || !data.article.timestamp) {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Missing required article data.' }));
                        return;
                    }
                    const newArticle = await addArticle(data.article);
                    // Broadcast the newly published article (with its ID from DB) to all clients
                    broadcast({ type: 'NEW_ARTICLE', article: newArticle });
                    break;
                case 'POST_COMMENT':
                    const { articleId: commentArticleId, comment } = data;
                    if (!comment || !comment.commentText || !comment.timestamp) {
                         ws.send(JSON.stringify({ type: 'ERROR', message: 'Missing required comment data.' }));
                         return;
                    }
                    const addedComment = await addComment(commentArticleId, comment);
                    // Broadcast the new comment to all clients
                    broadcast({ type: 'NEW_COMMENT', articleId: commentArticleId, comment: addedComment });
                    break;
                case 'POST_REACTION':
                    const { articleId: reactionArticleId, reaction } = data;
                    if (!reaction || !reaction.type || !reaction.clientId || !reaction.timestamp) {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Missing required reaction data.' }));
                        return;
                    }
                    try {
                        const addedReaction = await addReaction(reactionArticleId, reaction);
                        // Broadcast the new reaction to all clients
                        broadcast({ type: 'NEW_REACTION', articleId: reactionArticleId, reaction: addedReaction });
                    } catch (error) {
                        // Check for the specific PostgreSQL foreign key violation error code (23503)
                        if (error.code === '23503') {
                            console.error('❌ Foreign key violation:', error.message);
                            ws.send(JSON.stringify({
                                type: 'ERROR',
                                message: 'Cannot add reaction: The article ID provided does not exist.',
                                articleId: reactionArticleId
                            }));
                        } else {
                            // Re-throw the error if it's not a foreign key violation
                            throw error;
                        }
                    }
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

