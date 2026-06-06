# Channels — สั่งงานออฟฟิศจาก Telegram / Discord / LINE

ข้อความจากภายนอกวิ่งตรงเข้า **Director**: เขาอ่าน ตอบ และมีอำนาจมอบงานต่อ
(DELEGATE) เหมือนคุณสั่งเองในแชท — คำตอบส่งกลับทางช่องทางเดิม
ทุกข้อความขาเข้าโชว์ใน 📡 feed ด้วย (`📨 [telegram] ...`)

ตั้งค่าทั้งหมดที่ **⚙ → 🔗 CONNECT** — แต่ละช่องมีไฟสถานะ ● on / connecting / error

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

---

## ลูกเล่นที่ใช้ได้เลย

- *"ฝากดูหน่อยว่าโปรเจค X ไปถึงไหนแล้ว"* — Director เช็คสถานะออฟฟิศให้
- *"สั่ง Flamingo สร้างหน้า landing ในโปรเจค Y"* — มอบงานจริงจากมือถือ
- ตอนนี้คำตอบที่ส่งกลับ = คำตอบแรกของ Director (แผน/คำตอบ) — ผลงานละเอียด
  ของลูกทีมตามดูได้ในแอป (round-trip กลับ channel อยู่ใน roadmap)
