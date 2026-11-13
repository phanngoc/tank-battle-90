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

## tank.bomclaw.org (đã chuyển 13/11/2026)
`wrangler.jsonc` có **Worker route** `tank.bomclaw.org/*` (zone bomclaw.org) — không phải custom domain.
Bản ghi DNS `tank` vẫn là CNAME proxied về cloudflared tunnel của Mac; Cloudflare chạy Worker route
TRƯỚC khi tới origin, nên mọi request vào Worker và tunnel không còn nhận traffic tank.
Không phải xoá DNS hay restart cloudflared (token CF hiện không có quyền DNS).

## Rollback về server Mac
Server cũ không bị đụng: platform `com.ngocp.arcade` (:8090) vẫn phục vụ `games/tank-battle`,
và `~/.cloudflared/config.yml` vẫn có ingress `tank.bomclaw.org → :8090`.
1. Xoá dòng `routes` trong `wrangler.jsonc` rồi `npx wrangler@4 deploy`
   (hoặc dashboard → Workers → tank-battle-90 → Settings → Domains & Routes → xoá route).
2. Xong — request rơi lại xuống tunnel → Mac. Kiểm: `curl https://tank.bomclaw.org/v1/health`
   không còn trả `"runtime":"cloudflare"`.
Rollback một bản Worker lỗi (giữ route): `npx wrangler@4 rollback`.

## Chi phí
Mỗi phòng có người = một DO chạy liên tục (~30 tin/s/người chiều ra; tin chiều vào tính như request).
Phòng trống tự giải phóng sau 60s; rớt mạng giữ slot 15s để SDK `rejoin`.

## Mỹ phẩm / thanh toán (D1 `tank-entitlements`)
Chỉ trang trí — không SKU nào đổi chỉ số xe (`test/cosmetics.test.js` khẳng định engine giống hệt có/không skin).
- Dev: `npm run dev:cf` (D1 local + `--local-upstream` để wsUrl không trỏ ra tank.bomclaw.org), rồi
  `npm run smoke:cf` và `npm run smoke:cf:economy` (đơn → sandbox confirm → skin trong phòng, phòng lễ hội).
- Deploy lần đầu:
  1. `npx wrangler@4 d1 create tank-entitlements` → dán `database_id` vào wrangler.jsonc (thay REPLACE_AFTER_D1_CREATE)
  2. `npx wrangler@4 d1 migrations apply tank-entitlements --remote`
  3. `npx wrangler@4 secret put AUTH_SECRET` (bắt buộc khi PAYMENTS_LIVE=true; sandbox có giá trị dev mặc định)
  4. `npm run deploy:cf`
- Thanh toán thật: đặt `PAYMENTS_LIVE="true"`, `secret put PAYMENT_CHECKSUM_KEY`, PAY_BANK/PAY_ACCOUNT/PAY_ACCOUNT_NAME thật,
  trỏ webhook provider về `/v1/pay/webhook`. Khi live, `/v1/pay/sandbox/confirm` trả 404.
