require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// --- משתני סביבה וקונפיגורציה ---
const { 
    PORT, VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, 
    XAI_API_KEY, 
    SUNO_API_KEY, 
    SUNO_API_URL // חייב להיות: https://api.piapi.ai/api/v1
} = process.env;

// מודלים
const MODELS = {
    BRAIN: "grok-3",
    IMAGE: "grok-2-image-1212",
    VISION: "grok-2-vision-1212"
};

// --- ניהול זיכרון (Context) ---
const chatHistory = new Map();
function updateHistory(userId, role, content) {
    if (!chatHistory.has(userId)) chatHistory.set(userId, []);
    const history = chatHistory.get(userId);
    history.push({ role, content });
    if (history.length > 15) history.shift(); 
}
function getHistory(userId) { return chatHistory.get(userId) || []; }

// --- שרת ---
app.get('/', (req, res) => res.status(200).send('💎 Nabi Enterprise is Online using PiAPI & Grok-3'));

app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

// --- Pipeline ראשי ---
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // אישור מיידי למניעת לופים

    try {
        const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!message) return;

        const userPhone = message.from;
        const userName = message.contacts?.[0]?.profile?.name || "לקוח";

        console.log(`📥 הודעה חדשה מ-${userName} (${message.type})`);

        // 1. טיפול בתמונות (VISION)
        if (message.type === 'image') {
            // אם המשתמש שלח תמונה, נשלח לניתוח ראייה
            await sendWhatsAppText(userPhone, "👀 אני מסתכל על התמונה...");
            // כאן נדרש לוגיקה להורדת התמונה ושימוש ב-Grok Vision (יפותח בשלב הבא)
            // כרגע נגיב בטקסט
            await sendWhatsAppText(userPhone, "ראיתי את התמונה! (מודול הראייה המלא בפיתוח)");
            return;
        }

        // 2. טיפול בטקסט (TEXT)
        if (message.type === 'text') {
            const userText = message.text.body;
            updateHistory(userPhone, "user", userText);

            // הפעלת המוח (Router)
            const action = await nabiBrain(userText, getHistory(userPhone));
            console.log(`🤖 החלטת מוח: ${action.type}`);

            switch (action.type) {
                case 'SONG':
                    await sendWhatsAppText(userPhone, "🎵 קיבלתי! יוצר להיט ב-Suno (זה לוקח כ-2 דקות)...");
                    await generatePiApiMusic(userPhone, action.prompt);
                    break;
                case 'IMAGE':
                    await sendWhatsAppText(userPhone, "🎨 רעיון אש. אני מצייר את זה...");
                    await generateGrokImage(userPhone, action.prompt);
                    break;
                case 'CHAT':
                default:
                    await sendWhatsAppText(userPhone, action.response);
                    updateHistory(userPhone, "assistant", action.response);
                    break;
            }
        }

    } catch (error) {
        console.error('🔥 CRITICAL ERROR:', error.message);
    }
});

// --- 🧠 המוח (Grok-3 Router) ---
async function nabiBrain(text, history) {
    try {
        const systemPrompt = `אתה Nabi, בינה מלאכותית עילית. עליך לנתח מה המשתמש רוצה ולהחזיר JSON בלבד.
        סוגי פעולות:
        1. "SONG" - אם המשתמש רוצה שיר. prompt = תיאור השיר באנגלית (Style, Lyrics topic).
        2. "IMAGE" - אם המשתמש רוצה תמונה. prompt = תיאור ויזואלי באנגלית.
        3. "CHAT" - כל דבר אחר. response = תשובה חכמה, קצרה וזורמת בעברית.
        `;

        const response = await axios.post('https://api.x.ai/v1/chat/completions', {
            model: MODELS.BRAIN,
            messages: [{role: "system", content: systemPrompt}, ...history, {role: "user", content: text}],
            temperature: 0.3,
            stream: false,
            response_format: { type: "json_object" }
        }, { headers: { 'Authorization': `Bearer ${XAI_API_KEY}` } });

        return JSON.parse(response.data.choices[0].message.content);
    } catch (e) {
        console.error('Brain Error:', e.response?.data || e.message);
        return { type: 'CHAT', response: "המוח שלי מתחמם, נסה שוב עוד רגע 😅" };
    }
}

// --- 🎵 מוזיקה (PiAPI / Suno) ---
async function generatePiApiMusic(to, prompt) {
    try {
        if (!SUNO_API_KEY || !SUNO_API_URL) throw new Error("Missing PiAPI Config");

        // 1. יצירת משימה (Task)
        const taskPayload = {
            model: "suno-v3.5", // המודל הכי חדש של PiAPI
            task_type: "generate_music",
            input: {
                gpt_description_prompt: prompt, // התיאור מ-Grok
                make_instrumental: false,
                mv: "chirp-v3-0"
            }
        };

        const createRes = await axios.post(`${SUNO_API_URL}/task`, taskPayload, {
            headers: { 
                'x-api-key': SUNO_API_KEY, // PiAPI משתמש ב-header הזה
                'Content-Type': 'application/json' 
            }
        });

        const taskId = createRes.data.data.task_id;
        console.log(`🎵 PiAPI Task Created: ${taskId}`);

        // 2. המתנה לתוצאה (Polling)
        let attempts = 0;
        let audioUrl = null;
        
        while (attempts < 30) { // ננסה במשך 2.5 דקות (30 * 5 שניות)
            await new Promise(r => setTimeout(r, 5000)); // חכה 5 שניות
            attempts++;

            const statusRes = await axios.get(`${SUNO_API_URL}/task/${taskId}`, {
                headers: { 'x-api-key': SUNO_API_KEY }
            });

            const status = statusRes.data.data.status;
            console.log(`🎵 Status Check (${attempts}): ${status}`);

            if (status === 'completed') {
                // PiAPI מחזיר לינק אודיו
                // שים לב: המבנה עשוי להשתנות, אנחנו לוקחים את הראשון
                audioUrl = statusRes.data.data.output.audio_url || statusRes.data.data.output[0].audio_url; 
                break;
            }
            if (status === 'failed') throw new Error("PiAPI Task Failed");
        }

        if (audioUrl) {
            await sendWhatsAppMedia(to, 'audio', audioUrl);
            await sendWhatsAppText(to, "🎵 הנה השיר שלך! (נוצר ע'י Suno v3.5)");
        } else {
            await sendWhatsAppText(to, "לקח יותר מדי זמן ליצור את השיר, נסה שוב מאוחר יותר.");
        }

    } catch (e) {
        console.error('Music Error:', e.message);
        await sendWhatsAppText(to, "הייתה בעיה ביצירת השיר דרך PiAPI.");
    }
}

// --- 🎨 תמונות (Grok Image) ---
async function generateGrokImage(to, prompt) {
    try {
        const response = await axios.post('https://api.x.ai/v1/image/generations', {
            prompt: prompt,
            model: MODELS.IMAGE,
            size: "1024x1024"
        }, { headers: { 'Authorization': `Bearer ${XAI_API_KEY}` } });

        const url = response.data.data[0].url;
        await sendWhatsAppMedia(to, 'image', url, "הנה היצירה שלך 🎨");
    } catch (e) {
        console.error('Image Error:', e.message);
        await sendWhatsAppText(to, "לא הצלחתי לצייר כרגע.");
    }
}

// --- עזרים לשליחת הודעות ---
async function sendWhatsAppText(to, text) {
    return sendMeta(to, { text: { body: text } });
}
async function sendWhatsAppMedia(to, type, url, caption) {
    const payload = { type: type };
    payload[type] = { link: url, caption: caption };
    return sendMeta(to, payload);
}
async function sendMeta(to, data) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, 
        { messaging_product: 'whatsapp', to, ...data }, 
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (e) {
        console.error('Meta Send Error:', e.response?.data || e.message);
    }
}

app.listen(PORT || 3000, () => console.log(`🚀 Nabi Enterprise is Running!`));
