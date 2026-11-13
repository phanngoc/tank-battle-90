# Tank Battle 90 — Cửa hàng cosmetic (thiết kế v1, chờ owner chốt)

> Trạng thái: **BẢN THIẾT KẾ — chưa code.** Owner chốt mục §10 xong mới implement.
> Repo: phanngoc/tank-battle-90 (CF Worker + DO `TankRoom`, D1 `tank-entitlements`, SePay sandbox `PAYMENTS_LIVE=false`).
> Viết bởi bomclaw2, 13/11/2026, task t_d361676c.

## 0. Tóm tắt 1 phút
- Cửa hàng mới có **4 tab**: 🛡️ Xe tăng · 💥 Đạn · 🦅 Đại bàng · 🗺️ Bản đồ, cộng tab **🎁 Combo** và **🎒 Tủ đồ** (đồ đã có + trang bị).
- **22 món lẻ** (20 món mới + Ngọc Bích, Hoàng Kim), giá 9k–49k theo 4 bậc hiếm; **4 combo** rẻ hơn mua lẻ ~30%, giá combo **tự trừ món đã có**.
- Mỗi món có **xem trước sống** (canvas mini-scene vẽ bằng đúng hàm vẽ trong game: xe chạy, bắn, đạn trúng gạch, đại bàng, ô map) ⇒ preview = thứ thấy trong ván.
- **Chỉ đổi hình ảnh/hiệu ứng.** Hitbox, tốc độ, sát thương, máu, kích thước đạn giữ nguyên; engine (`game`) không đọc cosmetic. Test chứng minh: cùng seed, ván có/không cosmetic cho ra trạng thái giống hệt.
- **Đồng đội thấy nhau:** skin xe + kiểu đạn là **của từng người** (ai cũng thấy). Đại bàng + bản đồ là **của phòng** — lấy theo chủ phòng (host) đang trang bị; mọi người trong phòng thấy giống nhau.
- Đồ cũ giữ nguyên: Skin Ngọc Bích 19k, Hoàng Kim 29k, Pass Co-op 39k/28 ngày, Phòng Lễ Hội 29k.

## 1. Tham khảo shop cùng thể loại
| Game | Học được gì | Link |
|---|---|---|
| World of Tanks — Customization (sơn, decal, 2D/3D style) | Phân slot rõ (camo / paint / decal / style); style trọn bộ thay toàn bộ ngoại hình; cosmetic thuần, không đổi chỉ số | https://wiki.wargaming.net/en/Customization |
| Tanki Online — Paints & Shot effects | Sơn xe + **hiệu ứng phát bắn** bán riêng — đúng ý "đạn bắn" của owner; hiệu ứng có hoạt ảnh là món đắt nhất | https://en.tankiwiki.com/Paints · https://en.tankiwiki.com/Shot_effects |
| Valorant — Bundles | Combo theo chủ đề (skin + hiệu ứng + phụ kiện), **giá combo trừ món đã sở hữu**, xem trước video từng món | https://valorant.fandom.com/wiki/Bundles |
| Fortnite — Item Shop | Tab theo loại, nhãn bậc hiếm theo màu, nút "Xem trước" toàn màn hình trước khi mua, mục "Đã sở hữu" | https://fortnite.fandom.com/wiki/Item_Shop |
| Brawl Stars — Skins | Bậc giá cố định (Rare/Super Rare/Epic/Legendary), skin đắt có hoạt ảnh + hiệu ứng đạn riêng | https://brawlstars.fandom.com/wiki/Skins |

Bài học áp dụng: (1) giá theo **bậc** dễ hiểu hơn giá lẻ từng món; (2) món đắt phải **chuyển động** (hoạt ảnh/hạt), món rẻ chỉ đổi màu; (3) combo trừ món đã có để người mua lẻ trước không bị phạt; (4) preview phải đúng thứ thấy trong ván; (5) không bán sức mạnh — người chơi co-op ghét pay-to-win.

## 2. Bậc hiếm & giá (VND)
| Bậc | Màu nhãn | Giá | Đặc điểm hình ảnh |
|---|---|---|---|
| Thường | xám | 9 000 | đổi màu tĩnh |
| Hiếm | xanh dương | 19 000 | màu + hoạ tiết (vằn, sọc, viền) |
| Sử thi | tím | 29 000 | hoạ tiết + 1 hiệu ứng động (nhấp nháy, vệt đuôi) |
| Huyền thoại | vàng cam | 39 000–49 000 | hoạt ảnh liên tục + hạt (particle) + âm/hiệu ứng nổ riêng |

## 3. Danh mục món
Mã SKU theo dạng `tank.<slot>.<id>`. "Mô tả" là thứ người chơi thấy; mọi món vẽ procedural (pixel 8-bit như game hiện tại), không cần file ảnh.

### 3.1 🛡️ Xe tăng (slot `tank`, của từng người)
| SKU | Tên | Bậc | Giá | Mô tả / ảnh |
|---|---|---|---|---|
| (mặc định) | Thép Tiêu Chuẩn | — | 0 | màu theo số người chơi (P1 vàng, P2 xanh lá…) như hiện tại |
| tank.skin.camo | Rằn Ri Rừng | Hiếm | 19k | thân xanh rêu, vằn nâu–đen 3 mảng, nòng đen |
| tank.skin.desert | Bão Cát | Hiếm | 19k | be cát, sọc chéo nâu nhạt, xích màu đất |
| tank.skin.jade *(đã có)* | Ngọc Bích | Hiếm | 19k | xanh ngọc #36c79a + chấm sáng |
| tank.skin.carbon | Carbon Đêm | Sử thi | 29k | đen than vân chéo, viền đỏ, đèn trước nhấp nháy khi bắn |
| tank.skin.gold *(đã có)* | Hoàng Kim | Sử thi | 29k | vàng #f2c230, tia lấp lánh chạy dọc thân mỗi 2 s |
| tank.skin.neon | Cyber Neon | Huyền thoại | 39k | thân tối, viền neon cyan/hồng **phát sáng nhịp**, vệt sáng khi di chuyển |
| tank.skin.dragon | Rồng Lửa | Huyền thoại | 49k | đỏ thẫm vảy rồng, đầu nòng hình hàm rồng, khói than bay sau xích |
| tank.pass.coop *(đã có)* | Tím Đồng Đội | Pass | trong Pass 39k | tím #8a7dff + 2 vạch trắng |
| tank.room.festival *(đã có)* | Lễ Hội | Phòng | 29k/phòng | cầu vồng đổi màu — áp cho cả 4 người trong 1 phòng |

### 3.2 💥 Đạn (slot `bullet`, của từng người)
Kích thước + hitbox đạn **giữ nguyên 1 ô đạn hiện tại**; chỉ đổi màu lõi, vệt đuôi và hiệu ứng khi trúng.
| SKU | Tên | Bậc | Giá | Mô tả |
|---|---|---|---|---|
| (mặc định) | Đạn Pháo | — | 0 | trắng, nổ chuẩn |
| tank.bullet.laser | Tia Laser | Thường | 9k | lõi cyan, vệt đuôi 3 px mờ dần |
| tank.bullet.plasma | Plasma | Hiếm | 19k | cầu tím phát sáng, nổ vòng tím khi trúng |
| tank.bullet.fire | Hoả Tiễn | Hiếm | 19k | lõi cam, đuôi lửa 4 hạt, tàn lửa khi trúng gạch |
| tank.bullet.firework | Pháo Hoa | Sử thi | 29k | khi trúng nổ bông pháo hoa 6 tia nhiều màu |
| tank.bullet.meteor | Sao Băng | Sử thi | 29k | đuôi dài sao trắng–xanh, rung nhẹ khi trúng thép |
| tank.bullet.dragon | Hơi Thở Rồng | Huyền thoại | 39k | cầu lửa đỏ–vàng, đuôi khói, nổ hình đầu rồng (chỉ trong combo Rồng hoặc mua lẻ) |

### 3.3 🦅 Đại bàng (slot `eagle`, của phòng — theo host)
Cùng kích thước 2×2 ô, cùng trạng thái "bị phá" (đổi sang sprite đổ nát riêng của món đó) — người chơi luôn nhận ra căn cứ.
| SKU | Tên | Bậc | Giá | Mô tả |
|---|---|---|---|---|
| (mặc định) | Đại Bàng Cổ Điển | — | 0 | như hiện tại |
| tank.eagle.golden | Đại Bàng Vàng | Hiếm | 19k | lông vàng, viền nâu, lấp lánh nhẹ |
| tank.eagle.ice | Đại Bàng Băng | Hiếm | 19k | trắng–xanh băng, tinh thể quanh chân |
| tank.eagle.lac | Chim Lạc | Sử thi | 29k | hoạ tiết trống đồng Đông Sơn, đồng xanh — món "bản sắc Việt" |
| tank.eagle.phoenix | Phượng Hoàng Lửa | Huyền thoại | 39k | cánh lửa vỗ (2 frame), tàn lửa bay lên; khi bị phá: tro tàn |

### 3.4 🗺️ Bản đồ (slot `map`, của phòng — theo host)
Chỉ đổi **bảng màu/hoạ tiết** của 5 loại ô (nền, gạch, thép, nước, cây/băng). Layout màn chơi, va chạm, ô nào phá được — giữ nguyên. Quy tắc dễ đọc: gạch và thép phải khác nhau rõ (độ tương phản ≥ 3:1), cây vẫn che xe như cũ.
| SKU | Tên | Bậc | Giá | Mô tả |
|---|---|---|---|---|
| (mặc định) | Cổ Điển | — | 0 | nền đen, gạch cam, thép xám |
| tank.map.jungle | Rừng Nhiệt Đới | Hiếm | 19k | nền đất xanh thẫm, gạch đá rêu, nước xanh lục, cây dày |
| tank.map.desert | Sa Mạc | Hiếm | 19k | nền cát, gạch sa thạch, thép gỉ, nước ốc đảo |
| tank.map.snow | Bão Tuyết | Hiếm | 19k | nền tuyết trắng xanh, gạch băng, thép tối, tuyết rơi nhẹ (overlay mờ, không che xe) |
| tank.map.neon | Đêm Neon | Sử thi | 29k | nền lưới tối, gạch viền hồng, thép viền cyan, nước sóng tím |
| tank.map.tet | Tết Việt | Sử thi | 29k | nền đỏ thẫm, gạch hoa văn, thép vàng đồng, cây = cành mai vàng; *bán theo mùa (01/01–28/02)* |

## 4. 🎁 Combo
Giá combo = 70% tổng giá lẻ, **trừ phần món đã có** (tính ở server): `price = round_1000(0.7 × Σ giá lẻ món chưa có)`; nếu đã có hết → nút "Đã sở hữu".
| SKU | Tên | Gồm | Giá lẻ | Giá combo |
|---|---|---|---|---|
| tank.bundle.rookie | Tân Binh *(1 lần/tài khoản)* | Rằn Ri Rừng + Tia Laser | 28k | **15k** (khuyến mãi người mới, cố định) |
| tank.bundle.dragon | Bộ Rồng Lửa | xe Rồng Lửa + đạn Hơi Thở Rồng + Phượng Hoàng Lửa | 127k | **89k** |
| tank.bundle.neon | Bộ Cyber Neon | xe Cyber Neon + đạn Plasma + map Đêm Neon | 87k | **61k** |
| tank.bundle.tet | Bộ Tết | xe Hoàng Kim + đạn Pháo Hoa + Chim Lạc + map Tết Việt *(theo mùa)* | 116k | **81k** |

Một đơn combo = 1 giao dịch SePay = cấp N dòng entitlement trong **một batch D1**, idempotent theo `sepay:<id>` như hiện tại.

## 5. Trải nghiệm cửa hàng (UI)
```
┌ 🛒 Cửa hàng ─────────────────────── [🎒 Tủ đồ] ┐
│ [🛡️ Xe] [💥 Đạn] [🦅 Đại bàng] [🗺️ Map] [🎁 Combo] │
│ ┌──────────── XEM TRƯỚC (canvas) ────────────┐ │
│ │  map của món/đang trang bị, xe chạy qua lại,│ │
│ │  bắn vào gạch, đại bàng ở đáy; ◀ ▶ đổi món  │ │
│ └─────────────────────────────────────────────┘ │
│  Cyber Neon · HUYỀN THOẠI · 39 000đ             │
│  "Viền neon phát sáng nhịp, vệt sáng khi chạy"  │
│  [ Mua 39 000đ ]   hoặc   [ Trang bị ] [ Bỏ ]    │
│  Lưới món: ô vuông 64px, viền màu bậc, ✓ đã có   │
└──────────── Chỉ trang trí — không đổi sức mạnh ┘
```
- **Xem trước:** chọn ô nào thì canvas hiển thị món đó cùng các món đang trang bị ở slot khác (thấy được "outfit" tổng). Món chưa mua vẫn xem được. Hàm vẽ dùng chung với game (`drawTank/drawBullet/drawEagle/drawTile` nhận `cos`), nên preview không lệch với trong ván.
- **Tủ đồ:** liệt kê đồ đã có theo slot, nút Trang bị / Bỏ trang bị (về mặc định). Lưu ngay lên server ⇒ còn sau khi tải lại trang và trên mọi tab.
- **Sau khi thanh toán xong:** popup "Đã nhận ✓" + nút **Trang bị ngay**.
- **Trong sảnh phòng:** dưới tên mỗi người hiện icon xe + đạn của họ; host thấy dòng "Map: Đêm Neon · Đại bàng: Chim Lạc".

## 6. Đồng đội thấy cosmetic của nhau — cách hoạt động
1. Người chơi trang bị → `PUT /v1/loadout {slot, sku|null}` → server kiểm **có sở hữu** → ghi bảng `loadouts`.
2. Khi vào phòng (WS join có token), DO `TankRoom` đọc loadout + entitlement từ D1 → gán `player.cos = {tank, bullet, eagle, map}` (chỉ SKU hợp lệ).
3. Snapshot gửi client có `cos` theo slot người chơi (`cosBySlot`, thay `skins` hiện tại; giữ `skins` cũ cho client cũ) và `roomCos = {eagle, map}` lấy từ host.
4. Client vẽ: xe/đạn người khác theo `cosBySlot[slot]`; map/đại bàng theo `roomCos`. Địch giữ màu riêng (không bao giờ dùng skin) để không nhầm phe.
5. Phòng Lễ Hội vẫn ưu tiên: host dùng lượt festival ⇒ xe cả 4 người cầu vồng, đạn/map/đại bàng giữ theo loadout.
6. Không có loadout (người cũ) ⇒ tự chọn như hiện tại (`SKIN_RANK`: gold > pass > jade).

## 7. Không pay-to-win — ràng buộc kỹ thuật
- Engine `game` không đọc `cos`; cosmetic chỉ ở lớp trình bày (room.part.js giữ `skinOf` tách engine như hiện tại).
- Đạn: cùng kích thước vẽ lõi; vệt đuôi/particle vẽ **sau** và mờ (alpha ≤ 0.5) để không che đạn địch.
- Map: bảng màu qua kiểm tương phản tự động trong test (gạch vs thép vs nền ≥ 3:1); cây vẫn che xe như mặc định (không có map nào làm cây trong suốt).
- Test `cosmetics.test.js` mở rộng: chạy 600 tick 4 người với full cosmetic vs không cosmetic, cùng seed ⇒ `game` state giống hệt; SKU nào cũng `kind: 'cosmetic'`.

## 8. Thay đổi kỹ thuật (để ước lượng, làm sau khi chốt)
| Phần | Thay đổi |
|---|---|
| `cf/economy.mjs` | `SKUS` thêm `slot`, `rarity`, `desc`, `items` (combo), `season`; `bundlePrice()` trừ món đã có; `grant()` cấp nhiều SKU / đơn trong 1 batch; `loadout get/put` |
| D1 | migration `0003_loadouts.sql`: `loadouts(player_id, slot, sku, updated_at, PK(player_id, slot))`; `orders.amount` lưu giá thực tế combo |
| `cf/worker.mjs` | `GET /v1/shop` (catalog + owned + giá combo cá nhân), `GET/PUT /v1/loadout`; DO đọc loadout khi join |
| `server/room.part.js` | `skinOf` → `cosOf` (tank/bullet) + `roomCos` (eagle/map từ host); vẫn gửi `skins` cũ |
| `public/client.js` | renderer cosmetic (bảng vẽ theo SKU), shop mới (tab, lưới, preview canvas, tủ đồ, combo) |
| Test | cosmetics.test (bất biến engine + tương phản map + mọi slot), economy smoke (mua combo 1 lần → đủ N món, webhook lặp không cấp 2 lần, loadout từ chối món chưa có, giá combo trừ món đã có), playtest (mở shop, đổi tab, preview, mua sandbox, trang bị, reload vẫn còn, người thứ 2 trong phòng thấy skin/đạn) |
| Deploy | PR → merge → `wrangler d1 migrations apply --remote` → `npm run deploy:cf`; rollback `npx wrangler rollback <version trước>` (bảng `loadouts` mới không ảnh hưởng bản cũ) |

## 9. Đo lường
- Sự kiện (D1, không cần platform): `shop_open`, `preview(sku)`, `order_created(sku)`, `paid(sku)`, `equip(slot,sku)`.
- Chỉ số sau 2 tuần live: tỉ lệ mở shop → xem trước → mua; món preview nhiều nhưng không mua (giá cao?); tỉ lệ combo/lẻ. Hiện dữ liệu chơi rất ít (xem AGENTS.md) ⇒ số này chủ yếu để quyết định món mới, không A/B giá.

## 10. Owner cần chốt
1. **Danh mục + giá** ở §3–§4 (22 món lẻ, 9k–49k; 4 combo) — giữ, bớt hay đổi giá?
2. **Đại bàng + bản đồ theo host** (cả phòng thấy chung) — đồng ý? (Phương án khác: mỗi người tự thấy map của mình, không ai khoe được.)
3. **Bộ Tết bán theo mùa** (01/01–28/02) và **Tân Binh 15k chỉ 1 lần** — đồng ý?
4. Phạm vi đợt 1: làm **toàn bộ** hay đợt 1 chỉ Xe + Đạn + 2 combo (Tân Binh, Neon), đợt 2 thêm Đại bàng + Map?

Mặc định nếu owner chỉ nói "ok": làm toàn bộ như trên, đại bàng/map theo host.
