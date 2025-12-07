require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const app = express();
app.use(bodyParser.json());

// --- משתני סביבה (רזה ומאובטח) ---
const {
  PORT = 3000,
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  XAI_API_KEY,
  SUNO_API_KEY,
  SUNO_API_URL = 'https://api.piapi.ai/api/v1' // Default ל-PiAPI
} = process.env;

// מודלים (החדשים ביותר, כמו שמאסק אוהב)
const MODELS = {
  BRAIN: 'grok-3', // Router + Chat
  IMAGE: 'grok-2-image-1212', // יצירת תמונות
  VISION: 'grok-2-vision-1212' // ניתוח תמונות
};

// --- זיכרון מינימלי (Context per user) ---
const userContexts = new Map(); // { history: [], lastImageUrl: null }
function getContext(userId) {
  if (!userContexts.has(userId)) {
    userContexts.set(userId, { history: [], lastImageUrl: null });
  }
  return userContexts.get(userId);
}
function updateHistory(userId, role, content) {
  const ctx = getContext(userId);
  ctx.history.push({ role, content });
  if (ctx.history.length > 10) ctx.history.shift(); // חיסכון בזיכרון
}
function saveLastImage(userId, imageUrl) {
  getContext(userId).lastImageUrl = imageUrl;
}

// --- שרת בסיסי (Minimalist) ---
app.get('/', (req, res) => res.send('Nabi v1.0 by xAI - Ready 🚀'));
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// --- Pipeline ראשי (Efficient flow) ---
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Quick ACK to Meta
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const userId = message.from;
    const ctx = getContext(userId);

    if (message.type === 'image') {
      const imageId = message.image.id;
      const imageUrl = await getMediaUrl(imageId);
      saveLastImage(userId, imageUrl);
      updateHistory(userId, 'user', '[תמונה נשלחה]');
      await sendText(userId, 'קיבלתי תמונה! מה לעשות איתה? (למשל: "תעשה אותי מחייכת")');
      return;
    }

    if (message.type === 'text') {
      const text = message.text.body.trim();
      if (!text) return; // Skip empty
      updateHistory(userId, 'user', text);

      const decision = await brainRouter(userId, text);
      switch (decision.type) {
        case 'SONG':
          await sendText(userId, '🎵 יוצר שיר... (כ-2 דקות)');
          await generateSong(userId, decision.prompt);
          break;
        case 'IMAGE_EDIT':
          if (!ctx.lastImageUrl) {
            await sendText(userId, 'אין תמונה אחרונה. שלח תמונה קודם.');
            return;
          }
          await sendText(userId, '🎨 משנה תמונה...');
          await editImage(userId, decision.prompt, ctx.lastImageUrl);
          break;
        case 'NEW_IMAGE':
          await sendText(userId, '🎨 מצייר חדש...');
          await generateImage(userId, decision.prompt);
          break;
        case 'CHAT':
        default:
          await sendText(userId, decision.response);
          updateHistory(userId, 'assistant', decision.response);
          break;
      }
    }
  } catch (e) {
    console.error('Core Error:', e.message);
  }
});

// --- Brain Router (Grok-3, מינימלי וחכם) ---
async function brainRouter(userId, input) {
  const ctx = getContext(userId);
  const hasImage = !!ctx.lastImageUrl;
  const system = `
  אתה Nabi - AI פשוט וחזק. נתח בקשה בעברית והחזר JSON בלבד.
  סוגים:
  - SONG: שיר. prompt: תיאור באנגלית (סגנון, מילים).
  - IMAGE_EDIT: שינוי תמונה (אם hasImage=true). prompt: שינוי באנגלית.
  - NEW_IMAGE: תמונה חדשה. prompt: תיאור באנגלית.
  - CHAT: שיחה. response: תשובה קצרה בעברית.
  JSON: {type: "...", prompt: "...", response: "..."}
  `;
  try {
    const res = await axios.post('https://api.x.ai/v1/chat/completions', {
      model: MODELS.BRAIN,
      messages: [
        { role: 'system', content: system },
        ...ctx.history,
        { role: 'user', content: `(Has image: ${hasImage}) ${input}` }
      ],
      temperature: 0.4,
      response_format: { type: 'json_object' }
    }, { headers: { Authorization: `Bearer ${XAI_API_KEY}` } });
    return JSON.parse(res.data.choices[0].message.content);
  } catch (e) {
    return { type: 'CHAT', response: 'משהו השתבש, נסה שוב.' };
  }
}

// --- Image Edit (Vision + Generation, כמו מאסק - יעיל) ---
async function editImage(userId, request, imageUrl) {
  try {
    const visionRes = await axios.post('https://api.x.ai/v1/chat/completions', {
      model: MODELS.VISION,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe in detail for recreation: people, clothes, background.' },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }]
    }, { headers: { Authorization: `Bearer ${XAI_API_KEY}` } });
    const desc = visionRes.data.choices[0].message.content;

    const finalPrompt = `${desc}. Modify per request: ${request}. Photorealistic, 8K.`;
    await generateImage(userId, finalPrompt);
  } catch (e) {
    await sendText(userId, 'בעיה בשינוי התמונה.');
  }
}

// --- Generate Image (רזה) ---
async function generateImage(userId, prompt) {
  try {
    const res = await axios.post('https://api.x.ai/v1/images/generations', {
      prompt,
      model: MODELS.IMAGE,
      size: '1024x1024'
    }, { headers: { Authorization: `Bearer ${XAI_API_KEY}` } });
    const url = res.data.data[0].url;
    await sendMedia(userId, 'image', url);
  } catch (e) {
    await sendText(userId, 'לא הצלחתי לצייר.');
  }
}

// --- Generate Song (Polling יעיל, חיסכון בקריאות) ---
async function generateSong(userId, prompt) {
  try {
    const res = await axios.post(`${SUNO_API_URL}/task`, {
      model: 'suno-v3.5',
      task_type: 'generate_music',
      input: { gpt_description_prompt: prompt, make_instrumental: false, mv: 'chirp-v3-0' }
    }, { headers: { 'x-api-key': SUNO_API_KEY, 'Content-Type': 'application/json' } });
    const taskId = res.data.data.task_id;

    let attempts = 0;
    while (attempts < 36) { // 3 דקות מקס
      await new Promise(r => setTimeout(r, 5000));
      attempts++;
      const check = await axios.get(`${SUNO_API_URL}/task/${taskId}`, { headers: { 'x-api-key': SUNO_API_KEY } });
      if (check.data.data.status === 'completed') {
        const audioUrl = check.data.data.output.audio_url || check.data.data.output[0].audio_url;
        await sendMedia(userId, 'audio', audioUrl);
        return;
      }
      if (check.data.data.status === 'failed') break;
    }
    await sendText(userId, 'השיר לא יצא... נסה שוב.');
  } catch (e) {
    await sendText(userId, 'בעיה בשיר.');
  }
}

// --- Send Functions (רזה, עם בדיקת ריק) ---
async function sendText(to, text) {
  if (!text.trim()) return;
  try {
    await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      text: { body: text }
    }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  } catch (e) {}
}

async function sendMedia(to, type, url) {
  try {
    const payload = { messaging_product: 'whatsapp', to, type };
    payload[type] = { link: url };
    await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, payload, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  } catch (e) {}
}

async function getMediaUrl(mediaId) {
  const res = await axios.get(`https://graph.facebook.com/v17.0/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  return res.data.url;
}

app.listen(PORT, () => console.log(`🚀 Nabi v1.0 Running on ${PORT}`));
