require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const { Pool } = require('pg');

const app = express();
app.use(bodyParser.json());

// ───────────────────────
//  ENV VARS
// ───────────────────────
const {
  PORT,
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  XAI_API_KEY,
  SUNO_API_KEY,
  REPLICATE_API_KEY,
  DATABASE_URL,
  NODE_ENV,
} = process.env;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL is not defined. Set it in Railway Variables.');
  process.exit(1);
}

// ───────────────────────
//  DB POOL
// ───────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ───────────────────────
//  INIT DB
// ───────────────────────
async function initDB() {
  try {
    await pool.query('SELECT 1');
    console.log('✅ DB connection OK');

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

    console.log('✅ DB tables initialized');
  } catch (e) {
    console.error('❌ DB init error:', e);
    process.exit(1);
  }
}

// ───────────────────────
//  HELPERS – ROUTING
// ───────────────────────

// זיהוי בסיסי של מילות מפתח בטקסט
function containsAny(text, words) {
  if (!text) return false;
  return words.some((w) => text.includes(w));
}

// Router פשטני לפי האפיון שלך
function decideRoute({ text, hasImage }) {
  text = text || '';

  // 1. אם יש תמונה
  if (hasImage) {
    if (!text.trim()) {
      return {
        type: 'question',
        question: '📸 קיבלתי את התמונה 🙂 מה תרצה שאעשה איתה? תמונה / וידאו / שיר?',
      };
    }

    // תמונה + טקסט
    if (containsAny(text, ['רוקדים', 'וידאו', 'הנפשה', 'תנפיש', 'תזיז'])) {
      return {
        type: 'video_from_image',
        prompt: `Create a short fun animated video based on this Hebrew request and the provided photo. Make the people move/dance, keep them similar to the original photo. User text (Hebrew): "${text}"`,
      };
    }

    // "שבת שלום", טקסט על תמונה וכו'
    if (
      containsAny(text, ['שבת שלום', 'כתוב', 'טקסט', 'ברכה', 'פירורים', 'פרפרים'])
    ) {
      return {
        type: 'image_edit_from_image',
        prompt: `Create a new image based on the provided photo, adding Hebrew text and decorative elements as requested. User text (Hebrew): "${text}"`,
      };
    }

    // ברירת מחדל לתמונה + טקסט → עריכת תמונה
    return {
      type: 'image_edit_from_image',
      prompt: `Edit or stylize the provided photo according to this Hebrew request: "${text}"`,
    };
  }

  // 2. טקסט בלבד
  if (containsAny(text, ['שיר', 'בסגנון', 'מילים לשיר', 'מילים של שיר'])) {
    return {
      type: 'song_from_text',
      prompt: `Create a Hebrew song (lyrics + melody) based on this request. Keep the lyrics in Hebrew. If a style is mentioned (e.g. חנן בן ארי), follow that style. User text: "${text}"`,
    };
  }

  if (containsAny(text, ['תמונה', 'צייר', 'איור', 'ציור', 'פרפרים'])) {
    return {
      type: 'image_from_text',
      prompt: `Create a high-quality image/illustration based on this Hebrew description: "${text}"`,
    };
  }

  if (containsAny(text, ['וידאו', 'סרטון', 'הנפשה', 'תנפיש'])) {
    return {
      type: 'video_from_text',
      prompt: `Create a short video based on this Hebrew description: "${text}"`,
    };
  }

  // לא ברור → שאלה פשוטה
  return {
    type: 'question',
    question:
      '🤖 כדי שאעזור, כתוב מה תרצה שאייצר: תמונה, וידאו או שיר? אפשר גם לצרף תמונה.',
  };
}

// ───────────────────────
//  ROUTES
// ───────────────────────

// Health check
app.get('/', (req, res) => res.send('Nabi Bot is Alive! 🧞‍♂️'));

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    console.warn('❌ Webhook verification failed');
    res.sendStatus(400);
  }
});

// Receive messages
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;
    let text = message.text?.body || '';
    let imageUrl = null;
    const hasImage = message.type === 'image';

    // אם יש תמונה – מביאים את ה־URL
    if (hasImage && message.image?.id) {
      const mediaRes = await axios.get(
        `https://graph.facebook.com/v17.0/${message.image.id}`,
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
      );
      imageUrl = mediaRes.data.url;
      text = message.image.caption || text;
    }

    console.log(`📩 Message from ${from}: ${text} (image: ${!!imageUrl})`);

    // ----- Get or create user -----
    let userRes = await pool.query('SELECT * FROM users WHERE phone = $1', [from]);
    if (userRes.rows.length === 0) {
      userRes = await pool.query(
        'INSERT INTO users (phone) VALUES ($1) RETURNING *',
        [from]
      );
    }
    const user = userRes.rows[0];

    // ----- Registration -----
    if (text.startsWith('הרשם ')) {
      const parts = text.split(' ');
      const email = parts[1] || null;

      if (!email) {
        await sendWhatsApp(
          from,
          '❗ אנא שלח "הרשם האימייל-שלך" למשל: הרשם user@gmail.com'
        );
        return res.sendStatus(200);
      }

      await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email, user.id]);
      await sendWhatsApp(
        from,
        `✅ נרשמת עם ${email}! שלח "שלם" לקבלת לינק תשלום (60/80 ש"ח לחודש).`
      );
      return res.sendStatus(200);
    }

    if (text === 'שלם') {
      await sendWhatsApp(
        from,
        '🔗 לינק תשלום: https://example.com/pay (החלף ללינק אמיתי לתשלום)'
      );
      return res.sendStatus(200);
    }

    // ----- Usage limits -----
    const today = new Date().toISOString().split('T')[0];
    const isSubscribed =
      user.subscription_end && new Date() < new Date(user.subscription_end);

    if (isSubscribed) {
      if (!user.last_use || !user.last_use.toISOString().startsWith(today)) {
        await pool.query(
          'UPDATE users SET daily_uses = 0, last_use = $1 WHERE id = $2',
          [today, user.id]
        );
        user.daily_uses = 0;
      }

      if (user.daily_uses >= 20) {
        await sendWhatsApp(
          from,
          '🛑 חרגת ממגבלת השימוש היומית! חכה למחר או שדרג חבילה.'
        );
        return res.sendStatus(200);
      }
    } else {
      if (user.free_uses <= 0) {
        await sendWhatsApp(
          from,
          '🆓 ניצלת את כל השימושים החינמיים! שלח "הרשם האימייל-שלך" כדי להמשיך להשתמש בנאבי.'
        );
        return res.sendStatus(200);
      }
    }

    // ----- Routing לפי החוקים -----
    const route = decideRoute({ text, hasImage: !!imageUrl });

    if (route.type === 'question') {
      await sendWhatsApp(from, route.question);
      return res.sendStatus(200);
    }

    let response;

    if (route.type === 'song_from_text') {
      response = await createSong(route.prompt);
    } else if (route.type === 'image_from_text') {
      response = await createImage(route.prompt);
    } else if (route.type === 'video_from_image') {
      response = await createVideo(route.prompt, imageUrl);
    } else if (route.type === 'image_edit_from_image') {
      response = await createImageFromImage(route.prompt, imageUrl);
    } else if (route.type === 'video_from_text') {
      // אפשר להוסיף תמיכה בוידאו מטקסט בהמשך; עכשיו נחזיר הודעה
      await sendWhatsApp(
        from,
        'כרגע אני יודע להנפיש וידאו רק מתוך תמונה. שלח לי תמונה עם מה שתרצה שיקרה בה 🙂'
      );
      return res.sendStatus(200);
    } else {
      await sendWhatsApp(
        from,
        '🤖 הייתה בעיה בעיבוד הבקשה. נסה לנסח שוב או שלח תמונה + טקסט.'
      );
      return res.sendStatus(200);
    }

    // ----- Send back -----
    if (response.url) {
      const mediaType =
        route.type === 'song_from_text'
          ? 'song'
          : route.type.startsWith('video')
          ? 'video'
          : 'image';
      await sendWhatsAppMedia(from, response.url, mediaType);
    } else if (response.text) {
      await sendWhatsApp(from, response.text);
    }

    // ----- Update usage & log creation -----
    if (isSubscribed) {
      await pool.query(
        'UPDATE users SET daily_uses = daily_uses + 1, last_use = $1 WHERE id = $2',
        [today, user.id]
      );
    } else {
      await pool.query('UPDATE users SET free_uses = free_uses - 1 WHERE id = $1', [
        user.id,
      ]);
    }

    await pool.query(
      'INSERT INTO creations (user_id, type) VALUES ($1, $2)',
      [user.id, route.type]
    );

    res.sendStatus(200);
  } catch (e) {
    console.error('❌ Error in /webhook handler:', e?.response?.data || e);
    res.sendStatus(500);
  }
});

// ───────────────────────
//  AI HELPERS
// ───────────────────────
async function createSong(prompt) {
  const res = await axios.post(
    'https://api.piapi.ai/v1/suno/generate',
    { prompt },
    { headers: { Authorization: `Bearer ${SUNO_API_KEY}` } }
  );
  return { url: res.data.audio_url };
}

async function createImage(prompt) {
  const res = await axios.post(
    'https://api.x.ai/v1/images/generations',
    { prompt },
    { headers: { Authorization: `Bearer ${XAI_API_KEY}` } }
  );
  return { url: res.data.data[0].url };
}

// עריכת תמונה קיימת (image-to-image) – אם ה-API תומך בזה
async function createImageFromImage(prompt, imageUrl) {
  const res = await axios.post(
    'https://api.x.ai/v1/images/edits',
    { prompt, image: imageUrl },
    { headers: { Authorization: `Bearer ${XAI_API_KEY}` } }
  );
  return { url: res.data.data[0].url };
}

async function createVideo(prompt, imageUrl) {
  const prediction = await axios.post(
    'https://api.replicate.com/v1/predictions',
    {
      version:
        '9222a21c181b707209ef12b5e0d7e94c994b58f01c7b2fec075d2e892362f13c',
      input: { image: imageUrl, prompt },
    },
    { headers: { Authorization: `Bearer ${REPLICATE_API_KEY}` } }
  );

  let statusRes;
  do {
    statusRes = await axios.get(
      `https://api.replicate.com/v1/predictions/${prediction.data.id}`,
      { headers: { Authorization: `Bearer ${REPLICATE_API_KEY}` } }
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } while (
    statusRes.data.status !== 'succeeded' &&
    statusRes.data.status !== 'failed'
  );

  if (statusRes.data.status === 'failed') {
    throw new Error('Video generation failed');
  }

  return { url: statusRes.data.output[0] };
}

// ───────────────────────
//  WHATSAPP HELPERS
// ───────────────────────
async function sendWhatsApp(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.error('❌ WHATSAPP_TOKEN or PHONE_NUMBER_ID missing');
    return;
  }

  await axios.post(
    `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      text: { body: text },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

async function sendWhatsAppMedia(to, url, type) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.error('❌ WHATSAPP_TOKEN or PHONE_NUMBER_ID missing');
    return;
  }

  const mediaType = type === 'song' ? 'audio' : type === 'video' ? 'video' : 'image';

  await axios.post(
    `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: mediaType,
      [mediaType]: { link: url },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

// ───────────────────────
//  START SERVER
// ───────────────────────
async function start() {
  await initDB();
  const port = PORT || 3000;
  app.listen(port, () => {
    console.log(`🚀 Nabi running on port ${port}`);
  });
}

start().catch((e) => {
  console.error('❌ Fatal start error:', e);
  process.exit(1);
});
