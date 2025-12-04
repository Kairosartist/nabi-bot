require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const { PORT, VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID } = process.env;

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
            const text = message.text?.body || '';
            console.log(`📩 Message from ${from}: ${text}`);
            
            await sendWhatsApp(from, `היי! אני Nabi 🧞‍♂️\nקיבלתי: "${text}"\nבקרוב אדע ליצור קסמים!`);
        }
        res.sendStatus(200);
    } catch (e) {
        console.error('Error:', e.message);
        res.sendStatus(500);
    }
});

async function sendWhatsApp(to, text) {
    try {
        await axios.post(
            `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
            { messaging_product: 'whatsapp', to, text: { body: text } },
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
        );
        console.log('✅ Message sent');
    } catch (e) {
        console.error('Send error:', e.response?.data || e.message);
    }
}

app.listen(PORT || 3000, () => console.log(`🚀 Nabi running on port ${PORT || 3000}`));
