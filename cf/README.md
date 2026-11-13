# Tank Battle 90 trên Cloudflare Workers

Bản này chạy **không cần Mac**: static `public/` qua Workers Static Assets, mỗi phòng là
một Durable Object (`TankRoom`) chạy `server/room.js` ở 30Hz bằng `setInterval`.
Không dùng WebSocket Hibernation (tick liên tục, DO không ngủ được).

- Worker: `cf/worker.mjs` — `/v1/auth/guest|refresh`, `/v1/rooms/pick|join`, `/ws?room=CODE`,
  `/v1/events` + `/v1/leaderboard/*` (chấp nhận rồi bỏ — **chưa có leaderboard/analytics trên CF**).
- Engine: `cf/room-factory.mjs` TỰ SINH từ `server/room.js` (bọc trong factory để mỗi DO có `game` riêng).
- URL: https://tank-battle-90.lequidon-1993.workers.dev (tài khoản CF dùng cho deal.bomclaw.org).

## Deploy lại
```bash
node server/build-room.js && node cf/build.js     # sau mỗi lần sửa game.js / room.part.js
npm test                                           # unit test engine
npx wrangler@4 deploy                              # cần CLOUDFLARE_API_TOKEN (Workers Scripts:Edit)
node test/cf-smoke.js https://tank-battle-90.lequidon-1993.workers.dev   # 2 người chơi thật qua mạng
node test/playtest.js https://tank-battle-90.lequidon-1993.workers.dev/  # Chrome headless, cổng BOOT
```
Deploy làm rớt phòng đang chơi (DO khởi động lại) — deploy lúc vắng.

## Chuyển tank.bomclaw.org sang Cloudflare
1. Gỡ hostname `tank.bomclaw.org` khỏi cloudflared tunnel của Mac (đang trỏ về platform :8090),
   nếu không custom domain sẽ báo trùng record.
2. Bỏ comment dòng `routes` trong `wrangler.jsonc`, `npx wrangler@4 deploy`.
3. Chạy lại `cf-smoke.js` + `playtest.js` với `https://tank.bomclaw.org`.

## Rollback về server Mac
Server cũ không bị đụng: platform `com.ngocp.arcade` (:8090) vẫn phục vụ `games/tank-battle`.
1. Xoá route: comment lại `routes` rồi `npx wrangler@4 deploy` (hoặc dashboard → Workers → tank-battle-90 → Domains → Remove).
2. Thêm lại `tank.bomclaw.org` vào cloudflared tunnel trỏ `http://localhost:8090`.
3. Bản workers.dev có thể giữ hoặc `npx wrangler@4 delete`.
Rollback một bản Worker lỗi (không đổi domain): `npx wrangler@4 rollback`.

## Chi phí
Mỗi phòng có người = một DO chạy liên tục (~30 tin/s/người chiều ra; tin chiều vào tính như request).
Phòng trống tự giải phóng sau 60s; rớt mạng giữ slot 15s để SDK `rejoin`.
