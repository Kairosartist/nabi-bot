require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const app = express();
app.use(bodyParser.json());

const { PORT, VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, XAI_API_KEY, SUNO_API_KEY, REPLICATE_API_KEY, DATABASE_URL } = process.env;

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Initialize DB tables if not exist
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            phone VARCHAR(20) UNIQUE NOT NULL,
            email VARCHAR(255),
            subscription_start DATE,
            subscription_end DATE,
            free_uses INT DEFAULT 3,
            daily_uses INT DEFAULT 0,
            last_use DATE
        );
        
        CREATE TABLE IF NOT EXISTS creations (
            id SERIAL PRIMARY KEY,
            user_id INT REFERENCES users(id),
            type VARCHAR(50),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log('DB initialized');
}
initDB().catch(e => console.error('DB init error:', e));

// Health check
app.get('/', (req, res) => res.send('Nabi Bot is Alive! 🧞‍♂️'));

// Webhook verification
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        console.log('✅ Webhook verified');
        res.send(req.query['hub.challenge']);
    } else {
        res.sendStatus(400);
    }
});

// Receive messages
app.post('/webhook', async (req, res) => {
    try {
        const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (message) {
            const from = message.from;
            let text = message.text?.body || '';
            let imageUrl = null;
            if (message.type === 'image') {
                const mediaRes = await axios.get(`https://graph.facebook.com/v17.0/${message.image.id}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
                imageUrl = mediaRes.data.url;
                text = message.image.caption || text;
            }
            console.log(`📩 Message from ${from}: ${text} (image: ${imageUrl})`);
            
            // Get or create user
            let userRes = await pool.query('SELECT * FROM users WHERE phone = $1', [from]);
            if (userRes.rows.length === 0) {
                userRes = await pool.query('INSERT INTO users (phone) VALUES ($1) RETURNING *', [from]);
            }
            const user = userRes.rows[0];
            
            // Handle registration
            if (text.startsWith('הרשם ')) {
                const email = text.split(' ')[1];
                await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email, user.id]);
                return sendWhatsApp(from, `✅ נרשמת עם ${email}! שלח "שלם" לקבלת לינק תשלום (60/80 ש"ח לחודש).`);
            } else if (text === 'שלם') {
                // TODO: Generate payment link (Stripe/Paybox)
                return sendWhatsApp(from, '🔗 לינק תשלום: https://example.com/pay (הוסף כאן לינק אמיתי)');
            }
            
            // Check limits
            const today = new Date().toISOString().split('T')[0];
            if (user.subscription_end && new Date() < new Date(user.subscription_end)) {
                if (user.last_use !== today) {
                    await pool.query('UPDATE users SET daily_uses = 0, last_use = $1 WHERE id = $2', [today, user.id]);
                    user.daily_uses = 0;
                }
                if (user.daily_uses >= 20) {
                    return sendWhatsApp(from, '🛑 מגבלה יומית! חכה מחר או שדרג.');
                }
            } else if (user.free_uses <= 0) {
                return sendWhatsApp(from, '🆓 נגמרו השימושים החינמיים! שלח "הרשם [אימייל]" להמשיך.');
            }
            
            // Route with Grok
            const route = await routeWithGrok(text, imageUrl);
            if (route.question) {
                return sendWhatsApp(from, route.question);
            }
            let response;
            if (route.type === 'song') {
                response = await createSong(route.prompt);
            } else if (route.type === 'image') {
                response = await createImage(route.prompt);
            } else if (route.type === 'video') {
                response = await createVideo(route.prompt, imageUrl);
            } else {
                response = { text: route.response };
            }
            
            // Send
            if (response.url) {
                await sendWhatsAppMedia(from, response.url, route.type);
            } else {
                await sendWhatsApp(from, response.text);
            }
            
            // Update usage
            const updateQuery = user.subscription_end ? 'UPDATE users SET daily_uses = daily_uses + 1 WHERE id = $1' : 'UPDATE users SET free_uses = free_uses - 1 WHERE id = $1';
            await pool.query(updateQuery, [user.id]);
            await pool.query('INSERT INTO creations (user_id, type) VALUES ($1, $2)', [user.id, route.type]);
        }
        res.sendStatus(200);
    } catch (e) {
        console.error('Error:', e);
        res.sendStatus(500);
    }
});

async function routeWithGrok(text, imageUrl) {
    const content = `נתח בעברית: "${text}". תמונה: ${imageUrl || 'אין'}. סוג: שיחה/שיר/תמונה/וידאו. אם חסר, שאל. JSON: {type: "chat/song/image/video", prompt: "פרומפט", question: "שאלה", response: "תשובה אם שיחה"}`;
    const res = await axios.post('https://api.x.ai/v1/chat/completions', {
        model: 'grok-4.1-fast',
        messages: [{ role: 'user', content }]
    }, { headers: { Authorization: `Bearer ${XAI_API_KEY}` } });
    return JSON.parse(res.data.choices[0].message.content);
}

async function createSong(prompt) {
    const res = await axios.post('https://api.piapi.ai/v1/suno/generate', { prompt }, { headers: { Authorization: `Bearer ${SUNO_API_KEY}` } });
    return { url: res.data.audio_url };
}

async function createImage(prompt) {
    const res = await axios.post('https://api.x.ai/v1/images/generations', { prompt }, { headers: { Authorization: `Bearer ${XAI_API_KEY}` } });
    return { url: res.data.data[0].url };
}

async function createVideo(prompt, imageUrl) {
    const prediction = await axios.post('https://api.replicate.com/v1/predictions', {
        version: "9222a21c181b707209ef12b5e0d7e94c994b58f01c7b2fec075d2e892362f13c",  // Luma Dream Machine
        input: { image: imageUrl, prompt: prompt }
    }, { headers: { Authorization: `Bearer ${REPLICATE_API_KEY}` } });
    let statusRes;
    do {
        statusRes = await axios.get(`https://api.replicate.com/v1/predictions/${prediction.data.id}`, { headers: { Authorization: `Bearer ${REPLICATE_API_KEY}` } });
        await new Promise(resolve => setTimeout(resolve, 5000));
    } while (statusRes.data.status !== 'succeeded' && statusRes.data.status !== 'failed');
    if (statusRes.data.status === 'failed') throw new Error('Video failed');
    return { url: statusRes.data.output[0] };
}

async function sendWhatsApp(to, text) {
    await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', to, text: { body: text } }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
}

async function sendWhatsAppMedia(to, url, type) {
    const mediaType = type === 'song' ? 'audio' : type === 'video' ? 'video' : 'image';
    await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', to, type: mediaType, [mediaType]: { link: url } }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
}

app.listen(PORT || 3000, () => console.log(`🚀 Nabi running on port ${PORT || 3000}`));
