# Channels — สั่งงานออฟฟิศจาก Telegram / Discord / LINE / Slack / WhatsApp / Messenger

ข้อความจากภายนอกวิ่งตรงเข้า **Director**: เขาอ่าน ตอบ และมีอำนาจมอบงานต่อ
(DELEGATE) เหมือนคุณสั่งเองในแชท — คำตอบส่งกลับทางช่องทางเดิม
ทุกข้อความขาเข้าโชว์ใน 📡 feed ด้วย (`📨 [telegram] ...`)

ตั้งค่าทั้งหมดที่ **⚙ → 📡 CHANNELS** (แยกเป็นแท็บของตัวเองแล้ว) — แต่ละช่องมีไฟสถานะ ● on / connecting / error

---

## ✈️ Telegram (ง่ายสุด แนะนำเริ่มที่นี่ — ไม่ต้องมี public URL)

1. ใน Telegram คุยกับ **@BotFather** → `/newbot` → ตั้งชื่อ → ได้ **bot token**
2. วาง token ใน CONNECT → เปิดสวิตช์ → 💾 บันทึก
3. ทักหา bot ของคุณใน Telegram ได้เลย

**จำกัดให้คุยได้เฉพาะคุณ (แนะนำ):** ทัก bot 1 ครั้ง แล้วเปิด
`https://api.telegram.org/bot<TOKEN>/getUpdates` ในเบราว์เซอร์ — ดูเลข
`chat.id` ของคุณ เอามาใส่ช่อง chat id

> เทคนิค: long-polling — เครื่องคุณอยู่หลัง NAT/ไฟร์วอลล์ก็ใช้ได้

## 🎮 Discord

1. [discord.com/developers](https://discord.com/developers/applications) → New Application → Bot
2. เปิด **MESSAGE CONTENT INTENT** (สำคัญ! ใน Bot → Privileged Gateway Intents)
3. คัดลอก **Bot token** มาใส่ CONNECT
4. เชิญ bot เข้า server: OAuth2 → URL Generator → scope `bot` + permission
   `Send Messages`, `Read Message History` → เปิดลิงก์ที่ได้
5. (ไม่บังคับ) ใส่ **channel id** เพื่อจำกัดห้อง (เปิด Developer Mode ใน Discord
   แล้วคลิกขวาห้อง → Copy Channel ID)

> เทคนิค: ต่อ Discord gateway (WebSocket) ตรงๆ — รับข้อความเรียลไทม์ ตอบผ่าน REST

## 💬 LINE (ต้องมี public HTTPS URL)

LINE Messaging API ส่งข้อความผ่าน webhook เท่านั้น จึงต้องเปิดทางจาก
อินเทอร์เน็ตเข้าเครื่องคุณ — ง่ายสุดคือ cloudflared:

1. [developers.line.biz](https://developers.line.biz) → สร้าง Messaging API channel
   → ได้ **Channel access token** + **Channel secret** → ใส่ใน CONNECT
2. เปิดอุโมงค์: `cloudflared tunnel --url http://127.0.0.1:8787`
   (ได้ URL เช่น `https://xxx.trycloudflare.com`)
3. ตั้ง Webhook URL ใน LINE console:
   `https://xxx.trycloudflare.com/channels/line/webhook` → เปิด Use webhook
4. แอด bot เป็นเพื่อนจาก QR ใน console แล้วทักได้เลย

> ระบบตรวจลายเซ็น `X-Line-Signature` ด้วย channel secret และตอบกลับแบบ push
> (reply token ของ LINE หมดอายุเร็วกว่าที่ agent คิดงานเสร็จ)

## 🔷 Slack (ต้องมี public HTTPS URL · ทดลอง 🧪)

1. [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch
2. **OAuth & Permissions** → เพิ่ม scope `chat:write`, `app_mentions:read`, `im:history`,
   `channels:history` → Install to Workspace → ได้ **Bot User OAuth Token** (`xoxb-…`)
3. เปิดอุโมงค์: `cloudflared tunnel --url http://127.0.0.1:8787`
4. **Event Subscriptions** → เปิด → Request URL = `https://xxx.trycloudflare.com/channels/slack/webhook`
   (Slack จะยืนยัน URL อัตโนมัติ) → subscribe `message.channels` / `message.im`
5. ใส่ token + **Signing Secret** (จากหน้า Basic Information) ใน **CHANNELS** → เปิดสวิตช์ → 💾

## 🟢 WhatsApp (Cloud API · ต้องมี public HTTPS URL · ทดลอง 🧪)

1. [developers.facebook.com](https://developers.facebook.com) → สร้างแอป → เพิ่ม **WhatsApp**
   → ได้ **Access token** + **Phone number ID**
2. เปิดอุโมงค์ cloudflared (เหมือนด้านบน)
3. ใน **CHANNELS** ใส่ access token + phone number id + **Verify token** (ตั้งสตริงอะไรก็ได้
   ให้ตรงกับที่จะกรอกใน Meta) → เปิดสวิตช์ → 💾
4. ใน Meta → WhatsApp → Configuration → Callback URL =
   `https://xxx.trycloudflare.com/channels/whatsapp/webhook` + Verify token เดียวกัน → Verify and save

## 💠 Messenger (Facebook Page · ต้องมี public HTTPS URL · ทดลอง 🧪)

1. แอปเดียวกับ WhatsApp ได้ → เพิ่ม **Messenger** → ผูก Facebook Page → ได้ **Page access token**
2. ใน **CHANNELS** ใส่ page access token + **Verify token** → เปิดสวิตช์ → 💾
3. ใน Meta → Messenger → Webhooks → Callback URL =
   `https://xxx.trycloudflare.com/channels/messenger/webhook` + Verify token เดียวกัน → subscribe `messages`

> 🧪 Slack / WhatsApp / Messenger เป็นของใหม่ — ถ้าตั้งแล้วติดตรงไหน แจ้ง
> [issue](https://github.com/bagidea/bagidea-office/issues) พร้อมขั้นที่ติดได้เลย

---

## ลูกเล่นที่ใช้ได้เลย

- *"ฝากดูหน่อยว่าโปรเจค X ไปถึงไหนแล้ว"* — Director เช็คสถานะออฟฟิศให้
- *"สั่ง Flamingo สร้างหน้า landing ในโปรเจค Y"* — มอบงานจริงจากมือถือ
- ตอนนี้คำตอบที่ส่งกลับ = คำตอบแรกของ Director (แผน/คำตอบ) — ผลงานละเอียด
  ของลูกทีมตามดูได้ในแอป (round-trip กลับ channel อยู่ใน roadmap)
