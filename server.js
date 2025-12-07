require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// --- משתני המערכת (החסכוניים והיעילים) ---
const { 
    PORT, VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, 
    XAI_API_KEY, 
    SUNO_API_KEY, 
    SUNO_API_URL 
} = process.env;

// מודלים של xAI (הכי חדשים שיש)
const MODELS = {
    BRAIN: "grok-3",             // המנכ"ל
    ARTIST: "grok-2-image-1212", // הצייר
    EYES: "grok-2-vision-1212"   // העיניים
};

// --- זיכרון קצר-טווח (Context) ---
// זה מה שמאפשר לאמא להגיד "תעשה מ*זה* שיר"
const userContext = new Map();

function getContext(userId) {
    if (!userContext.has(userId)) {
        userContext.set(userId, { history: [], lastImageUrl: null });
    }
    return userContext.get(userId);
}

function updateHistory(userId, role, content) {
    const ctx = getContext(userId);
    ctx.history.push({ role, content });
    if (ctx.history.length > 10) ctx.history.shift(); // שומרים נקי
}

function saveLastImage(userId, imageUrl) {
    const ctx = getContext(userId);
    ctx.lastImageUrl = imageUrl;
}

// --- שרת ---
app.get('/', (req, res) => res.status(200).send('Nabi OS 1.0 - Minimalist & Powerful.'));

app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

// --- הליבה (The Core) ---
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // תגובה מיידית לוואטסאפ (חובה!)

    try {
        const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!message) return;

        const userId = message.from;
        const userName = message.contacts?.[0]?.profile?.name || "חבר";
        
        // 1. טיפול בתמונה (אמא שלחה תמונה)
        if (message.type === 'image') {
            // אנחנו שומרים את ה-ID של התמונה בזיכרון, אבל לא מגיבים מיד.
            // אנחנו מחכים שהיא תגיד מה לעשות איתה ("תעשה אותנו רוקדים").
            const imageId = message.image.id;
            const imageUrl = await getWhatsAppMediaUrl(imageId);
            
            saveLastImage(userId, imageUrl);
            updateHistory(userId, "user", "[המשתמש שלח תמונה]");
            
            await sendWhatsApp(userId, "קיבלתי את התמונה. מה לעשות איתה? 🎨");
            return;
        }

        // 2. טיפול בטקסט (פקודות)
        if (message.type === 'text') {
            const text = message.text.body;
            updateHistory(userId, "user", text);
            
            console.log(`🧠 מעבד בקשה מ-${userName}: ${text}`);

            // מפעילים את הראוטר החכם
            const decision = await nabiBrain(userId, text);
            console.log(`🤖 החלטה: ${decision.type}`);

            switch (decision.type) {
                case 'SONG':
                    await sendWhatsApp(userId, "🎶 על זה! מלחין את השיר שלך...");
                    await createSong(userId, decision.prompt);
                    break;

                case 'IMAGE_EDIT': 
                    // המקרה המורכב: "תעשה אותי מחייכת" על בסיס תמונה קודמת
                    await sendWhatsApp(userId, "🎨 מסתכל על התמונה ומצייר מחדש...");
                    await recreateImage(userId, decision.prompt);
                    break;

                case 'NEW_IMAGE':
                    await sendWhatsApp(userId, "🎨 מתחיל לצייר...");
                    await createImage(userId, decision.prompt);
                    break;

                case 'CHAT':
                default:
                    await sendWhatsApp(userId, decision.response);
                    updateHistory(userId, "assistant", decision.response);
                    break;
            }
        }

    } catch (error) {
        console.error('🔥 Error:', error.message);
    }
});

// --- 🧠 המוח (Grok-3) ---
async function nabiBrain(userId, input) {
    const ctx = getContext(userId);
    const hasImage = !!ctx.lastImageUrl;

    const systemPrompt = `
    אתה Nabi. המטרה: מינימליזם ופשטות.
    תפקידך לנתח את בקשת המשתמש ולהחזיר JSON בלבד.
    
    המצבים האפשריים:
    1. SONG: אם המשתמש רוצה שיר. צור "prompt" באנגלית שמתאר את הסגנון המוזיקלי והמילים (למשל: "Upbeat pop song in Hebrew, style of Hanan Ben Ari").
    2. IMAGE_EDIT: אם המשתמש מבקש לשנות תמונה ששלח קודם (רק אם hasImage=true). למשל "תעשה אותי מחייכת".
    3. NEW_IMAGE: אם המשתמש מבקש תמונה חדשה מאפס.
    4. CHAT: סתם שיחה.
    
    החזר JSON במבנה: { "type": "...", "prompt": "...", "response": "..." }
    `;

    try {
        const response = await axios.post('https://api.x.ai/v1/chat/completions', {
            model: MODELS.BRAIN,
            messages: [
                { role: "system", content: systemPrompt },
                ...ctx.history,
                { role: "user", content: `(Image available: ${hasImage}) ${input}` }
            ],
            response_format: { type: "json_object" },
            temperature: 0.4
        }, { headers: { 'Authorization': `Bearer ${XAI_API_KEY}` } });

        return JSON.parse(response.data.choices[0].message.content);
    } catch (e) {
        return { type: 'CHAT', response: "רגע, מחשבה חלפה לי וברחה. נסה שוב?" };
    }
}

// --- 🎨 "פוטושופ" חכם (Vision + Generation) ---
async function recreateImage(userId, userRequest) {
    const ctx = getContext(userId);
    if (!ctx.lastImageUrl) {
        await sendWhatsApp(userId, "לא מצאתי תמונה... תשלח לי קודם תמונה ואז תבקש לשנות אותה.");
        return;
    }

    try {
        // שלב 1: העיניים רואות מה יש בתמונה המקורית
        const visionResponse = await axios.post('https://api.x.ai/v1/chat/completions', {
            model: MODELS.EYES,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Describe this image in extreme detail so an artist can recreate it exactly. Focus on the people, clothes, and setting." },
                        { type: "image_url", image_url: { url: ctx.lastImageUrl } }
                    ]
                }
            ]
        }, { headers: { 'Authorization': `Bearer ${XAI_API_KEY}` } });

        const originalDescription = visionResponse.data.choices[0].message.content;
        
        // שלב 2: משלבים את התיאור עם הבקשה ("מחייכת")
        const finalPrompt = `Create a photorealistic image based on this description: ${originalDescription}. 
        BUT modify it according to this request: ${userRequest}. High quality, 8k.`;

        // שלב 3: יוצרים את התמונה החדשה
        await createImage(userId, finalPrompt);

    } catch (e) {
        console.error("Image Edit Error:", e);
        await sendWhatsApp(userId, "הסתבכתי עם התמונה הזאת... אולי ננסה אחרת?");
    }
}

// --- 🎨 יצירת תמונה (Grok Image) ---
async function createImage(userId, prompt) {
    try {
        const res = await axios.post('https://api.x.ai/v1/image/generations', {
            prompt: prompt,
            model: MODELS.ARTIST,
            size: "1024x1024"
        }, { headers: { 'Authorization': `Bearer ${XAI_API_KEY}` } });

        const url = res.data.data[0].url;
        await sendMedia(userId, 'image', url);
    } catch (e) {
        await sendWhatsApp(userId, "הצייר שלי בהפסקת קפה. נסה שוב עוד דקה.");
    }
}

// --- 🎵 יצירת שיר (PiAPI / Suno) ---
async function createSong(userId, prompt) {
    try {
        // 1. שליחת משימה
        const res = await axios.post(`${SUNO_API_URL}/task`, {
            model: "suno-v3.5",
            task_type: "generate_music",
            input: { gpt_description_prompt: prompt, make_instrumental: false, mv: "chirp-v3-0" }
        }, { headers: { 'x-api-key': SUNO_API_KEY, 'Content-Type': 'application/json' } });

        const taskId = res.data.data.task_id;
        
        // 2. בדיקה אם מוכן (Polling)
        let attempts = 0;
        while (attempts < 40) { // מחכים עד 3 דקות בערך
            await new Promise(r => setTimeout(r, 5000));
            attempts++;
            
            const check = await axios.get(`${SUNO_API_URL}/task/${taskId}`, {
                headers: { 'x-api-key': SUNO_API_KEY }
            });

            if (check.data.data.status === 'completed') {
                const audioUrl = check.data.data.output.audio_url || check.data.data.output[0].audio_url;
                await sendMedia(userId, 'audio', audioUrl);
                return;
            }
            if (check.data.data.status === 'failed') throw new Error("Generation Failed");
        }
    } catch (e) {
        await sendWhatsApp(userId, "לא הצלחתי להלחין את השיר הפעם. אולי המילים מורכבות מדי?");
    }
}

// --- תשתיות וואטסאפ (Infrastructure) ---
async function getWhatsAppMediaUrl(mediaId) {
    // 1. קבלת ה-URL הזמני
    const res1 = await axios.get(`https://graph.facebook.com/v17.0/${mediaId}`, {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
    // 2. קבלת ה-Binary (כרגע אנחנו מחזירים את ה-URL הציבורי אם יש, או משתמשים בפרוקסי. 
    // לצורך פשטות ה-VISION של GROK דורש URL ציבורי. 
    // בגרסת אנטרפרייז מלאה נצטרך להוריד ולהעלות ל-S3. כרגע נשתמש ב-URL של פייסבוק בתקווה ש-Grok יקבל אותו)
    return res1.data.url; 
}

async function sendWhatsApp(to, text) {
    await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, 
        { messaging_product: 'whatsapp', to, text: { body: text } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
}

async function sendMedia(to, type, url) {
    const payload = { messaging_product: 'whatsapp', to, type: type };
    payload[type] = { link: url };
    await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, 
        payload, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
}

const PORT_NUM = PORT || 3000;
app.listen(PORT_NUM, () => console.log(`🚀 Nabi OS Online on port ${PORT_NUM}`));
