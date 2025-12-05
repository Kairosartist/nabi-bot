// server.js – Nabi minimal echo bot for WhatsApp Cloud API

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// ==== ENV VARIABLES ====
const {
  PORT = 3000,
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
} = process.env;

console.log('🚀 Starting Nabi bot...');
console.log('ENV CHECK:', {
  PORT,
  HAS_VERIFY_TOKEN: !!VERIFY_TOKEN,
  HAS_WHATSAPP_TOKEN: !!WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
});

// ===== HEALTH CHECK =====
app.get('/', (req, res) => {
  res.send('Nabi Bot is Alive! 🧞‍♂️');
});

// ===== WEBHOOK VERIFY (GET) =====
app.get('/webhook', (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('🔎 GET /webhook verify:', { mode, token });

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook verified successfully');
      return res.status(200).send(challenge);
    } else {
      console.warn('❌ Webhook verify failed – wrong token or mode');
      return res.sendStatus(403);
    }
  } catch (err) {
    console.error('❌ GET /webhook error:', err);
    return res.sendStatus(500);
  }
});

// ===== WEBHOOK MESSAGES (POST) =====
app.post('/webhook', async (req, res) => {
  try {
    console.log('📦 RAW WEBHOOK BODY:');
    console.log(JSON.stringify(req.body, null, 2));

    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    // אם אין הודעה של משתמש (למשל עדכון סטטוס) – רק מאשרים
    if (!message) {
      console.log('ℹ️ No user message (probably status update)');
      return res.sendStatus(200);
    }

    const from = message.from;
    const text = message.text?.body || '';

    console.log('✅ INCOMING MESSAGE:', { from, text });

    // תגובת טסט – אקו פשוט
    const replyText = `✅ נאבי חי! קיבלתי ממך: "${text}"`;

    await sendWhatsAppText(from, replyText);

    return res.sendStatus(200);
  } catch (err) {
    console.error('❌ POST /webhook error:', err?.response?.data || err);
    // תמיד להחזיר 200 כדי שמטה לא "יענישו" את הוובהוק
    return res.sendStatus(200);
  }
});

// ===== SEND WHATSAPP TEXT =====
async function sendWhatsAppText(to, text) {
  try {
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
      console.error('❌ Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID');
      return;
    }

    const url = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    };

    console.log('📤 Sending WhatsApp message:', { to, text });

    const res = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    console.log('✅ WhatsApp API response:', res.data);
  } catch (err) {
    console.error('❌ Error sending WhatsApp message:', err?.response?.data || err);
  }
}

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`🧞‍♂️ Nabi running on port ${PORT}`);
});
