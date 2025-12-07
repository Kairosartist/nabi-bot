require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const { PORT, VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, XAI_API_KEY } = process.env;

// בדיקת דופק
app.get('/', (req, res) => res.send('Nabi Brain is Active! 🧠'));

// אימות Webhook מול Meta
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        console.log('✅ Webhook verified');
        res.send(req.query['hub.challenge']);
    } else {
        res.sendStatus(400);
    }
});

// קבלת הודעות וטיפול בהן
app.post('/webhook', async (req, res) => {
    try {
        const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        
        // נתעלם מהודעות סטטוס (כמו "נשלח", "נקרא") ונטפל רק בהודעות טקסט
        if (message && message.type === 'text') {
            const from = message.from;
            const userText = message.text.body;
            const userName = message.contacts?.[0]?.profile?.name || "חבר";
            
            console.log(`📩 הודעה מ-${userName} (${from}): ${userText}`);

            // 1. שליחת הודעת "מקליד..." (כדי שהמשתמש ידע שאנחנו חושבים)
            // (אופציונלי - נשמור את זה לשלב הבא לשיפור חוויה)

            // 2. קבלת תשובה חכמה מ-Grok
            const aiResponse = await getGrokResponse(userText, userName);

            // 3. שליחת התשובה לוואטסאפ
            await sendWhatsApp(from, aiResponse);
        }
        res.sendStatus(200);
    } catch (e) {
        console.error('❌ Error processing message:', e.message);
        res.sendStatus(500);
    }
});

// פונקציה לתקשורת עם Grok (המוח)
async function getGrokResponse(userText, userName) {
    try {
        const response = await axios.post(
            'https://api.x.ai/v1/chat/completions',
            {
                model: "grok-3", // המודל החכם של xAI
                messages: [
                    { 
                        role: "system", 
                        content: `אתה Nabi, עוזר יצירתי חכם וידידותי בווצאפ.
                        כרגע אתה בשלב שיחה בלבד. דבר בעברית טבעית, זורמת וקצרה.
                        המשתמש כרגע הוא: ${userName}.`
                    },
                    { role: "user", content: userText }
                ],
                temperature: 0.7
            },
            {
                headers: {
                    'Authorization': `Bearer ${XAI_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('❌ Error from Grok:', error.response?.data || error.message);
        return "אופס, קצת הסתבכו לי המחשבות. נסה שוב עוד רגע 😅";
    }
}

// פונקציה לשליחת הודעה לוואטסאפ
async function sendWhatsApp(to, text) {
    try {
        await axios.post(
            `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
            { 
                messaging_product: 'whatsapp', 
                to: to, 
                text: { body: text } 
            },
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
        );
        console.log('✅ תשובה נשלחה בהצלחה');
    } catch (e) {
        console.error('❌ Error sending WhatsApp:', e.response?.data || e.message);
    }
}

app.listen(PORT || 3000, () => console.log(`🚀 Nabi Server is running on port ${PORT || 3000}`));
