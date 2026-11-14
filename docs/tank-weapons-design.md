# Tank Battle 90 — Súng mua được phải MẠNH — THIẾT KẾ v2

Trạng thái: **đề xuất, chờ owner duyệt — chưa code, chưa deploy**. Task t_838b40cf, 14/11/2026.
Owner 14/11: *"đạn laser không xuyên được gạch hả? yếu thế, cần design để vật phẩm mua cần mạnh"*.
Thay cho v1 (t_202ac023, bản nằm ở `arcade/docs/tank-weapons-design.md`). Hiện tại trên prod (main e08bb8f, CF a99a5b83):
Laser = tia tức thì, **dừng ở gạch**, 1 mục tiêu, −1 máu, hồi chiêu 30 tick, chỉ ở Phòng Thường (`mode:'casual'`).

## 0. Tóm tắt 1 phút
- v1 sai ở chỗ: súng mua được "mạnh ở một việc, **yếu hơn đạn thường** ở việc khác". Người mua thấy mình bỏ tiền ra để bị thiệt. v2 đổi nguyên tắc:
  **mỗi súng làm được ít nhất 1 việc đạn thường KHÔNG làm được**, và không yếu hơn đạn thường ở việc chính của nó. Cái giá nằm ở hồi chiêu/giới hạn, không nằm ở chuyện "bắn gạch không vỡ".
- **Laser v2: khoan xuyên tối đa 4 ô gạch (= 2 khối gạch bản đồ), xoá gạch trên đường, đi tiếp, hạ tối đa 3 địch thẳng hàng.** Không phá thép (dừng ở thép). Không xuyên tường đại bàng.
- 5 súng còn lại, mỗi súng 1 "việc riêng": Plasma = nổ vùng 3×3 ô (−2 máu tâm) · Hoả Tiễn = tự bẻ lái + **phá thép** · Pháo Hoa = 8 mảnh đánh sau góc tường · Sao Băng = **đóng băng** địch + **xuyên đạn địch** · Hơi Thở Rồng = phun lửa liên tục, **đốt đạn địch**, giết xe giáp trong 0,8 s.
- **Phòng Chuẩn/BXH không đổi**: chỉ `WEAPON_MODES = { casual: true }`; mode `standard` vẫn bắn đạn thường, hash 1800 tick giữ nguyên (đã có test).
- Lối cho người không mua: hộp ⚡ rơi trong trận (Phòng Thường), thử 1 trận/ngày mỗi súng, và đạn thường vẫn đủ thắng mọi màn (không bị nerf).

## 1. Đơn vị và đạn thường để so
- Sân 26×26 **ô**, 1 ô = 16 px; 1 **khối** gạch trên bản đồ = 2×2 ô (32 px). 30 tick = 1 s.
- **Đạn thường** (xe người chơi, chưa có sao): 6 px/tick (sao 1: 8), hồi chiêu 8 tick, tối đa 1 viên trên sân (sao 2: 2), −1 máu, trúng gạch thì xoá **1 lớp** (1–2 ô ngang vệt đạn) rồi dừng, thép chỉ phá được ở sao 3, hai viên đạn chạm nhau cùng huỷ (chặn đạn địch), bắn đồng đội = choáng 2 s (nếu bật).
- Địch: basic/fast/power 1 máu, **armor 4 máu**. Đạn thường cần 4 phát để hạ armor.

## 2. Bảng số — 6 súng cạnh đạn thường

| | Đạn thường | **Laser** `tank.bullet.laser` | **Plasma** `…plasma` | **Hoả Tiễn** `…fire` | **Pháo Hoa** `…firework` | **Sao Băng** `…meteor` | **Hơi Thở Rồng** `…dragon` |
|---|---|---|---|---|---|---|---|
| Giá hiện tại (không đổi) | free | 9.000đ | 19.000đ | 19.000đ | 29.000đ | 29.000đ | 39.000đ |
| Kiểu bắn | viên 8 px, 6 px/tick | **tia tức thì** (cùng tick) | cầu 4 px/tick | tên lửa 4→12 px/tick | viên 6 px/tick, trúng thì toé | viên **12 px/tick** | **nón lửa** khi giữ nút |
| Sát thương | −1 | −1 mỗi địch | **−2 tâm**, −1 rìa | **−2** | −1 viên gốc, −1 mỗi mảnh | −1 + **đóng băng 2 s** | −1 mỗi 6 tick, mọi địch trong nón |
| Xuyên địch | 0 | **3 địch** thẳng hàng | vùng **3×3 ô** | 0 | **8 mảnh** (4 thẳng + 4 chéo), mỗi mảnh 4 ô | **2 địch** | toàn bộ nón (dài 3 ô, rộng 2→3 ô) |
| Phá gạch | 1 lớp rồi dừng | **khoan xuyên ≤ 4 ô gạch** (xoá) rồi **đi tiếp** | xoá **3×3 ô** | 1 lớp | mỗi mảnh xoá 1 ô | 1 lớp | đốt 1 ô gạch / 10 tick trong nón |
| Phá thép | chỉ sao 3 | **Không** — dừng ở thép | Không | **Có, 1 ô** (đầu xuyên giáp) | Không | Không | Không |
| Chặn đạn địch | Có (cùng huỷ) | **Không** (tia đi qua đạn) | Có | Có | Có | **Có và đi tiếp** (huỷ tối đa 3 viên) | **Có**: đạn địch bay vào nón bị đốt |
| Hồi chiêu | 8 tick | 30 tick (1 s) | 36 tick | 45 tick | 30 tick | 15 tick | thanh nhiệt: phun tối đa 90 tick → quá nhiệt khoá 60 tick |
| Giới hạn dùng | không | không | 1 viên trên sân | **6 quả/màn** (nạp lại đầu màn) | 1 viên trên sân | địch vừa tan băng **miễn đóng băng 3 s** | không, chỉ thanh nhiệt |
| Xe armor (4 máu) chết sau | 4 phát | 4 tia (~4 s) | 2 phát | 2 quả | 2–3 lần trúng | 4 phát (nhưng đứng im) | 24 tick (0,8 s) |
| **Việc đạn thường không làm được** | — | xuyên gạch + nhiều địch, không né được | giết cả cụm, mở hố 3×3 | bắn không cần thẳng hàng, phá thép không cần sao | đánh địch núp sau góc | khoá địch đứng im, xuyên màn đạn | thủ đại bàng: vừa giết vừa chắn đạn |
| **Điểm yếu (cái giá)** | — | không chặn đạn địch; armor vẫn 4 tia; thép/tường đại bàng chặn | chậm, bị đạn địch chặn giữa đường; nổ gần làm choáng chính mình 1 s | ít quả; hồi chiêu dài; bay chậm lúc rời nòng | phát gốc như đạn thường; mảnh dừng ở gạch | sát thương thấp, armor vẫn 4 phát; địch đóng băng chắn đường mình | tầm chỉ 3 ô; quá nhiệt 2 s là "trắng tay"; không phá thép |

### Laser v2 chi tiết (ưu tiên làm trước)
- Tia đi từng px như hiện tại (`fireBeam`). Gặp ô **gạch**: xoá ô đó (`setTile EMPTY`, như đạn thường xoá các ô vệt đạn chạm), trừ 1 vào **ngân sách gạch = 4 ô** (đếm theo chiều dài tia; vệt rộng 8 px nên mỗi bước có thể xoá 1–2 ô ngang nhưng chỉ tính 1). Hết ngân sách mà còn gạch ⇒ tia dừng **trước** ô gạch thứ 5 (ô đó còn nguyên).
  ⇒ Xuyên được 1 bức gạch dày 2 khối (dày nhất trên bản đồ hiện có là 2 khối) và bắn trúng địch phía sau.
- **Thép, mép sân, ô BASE: dừng** (không phá). **Tường đại bàng** (`this.baseWalls`, các ô gạch shovel bảo vệ): **dừng, không xoá** — để bắn bừa xuống dưới không tự khoét tường nhà.
- Xuyên **3 địch** trên cùng đường, −1 máu mỗi địch; đi qua đồng đội (không choáng), qua nước/rừng/băng, qua đạn bay (không huỷ chúng).
- Hằng số mới trong `WEAPONS['tank.bullet.laser']`: `targets: 3, damage: 1, brickPierce: 4, breaksSteel: false, stopAtBaseWalls: true, cooldown: 30`.
- Client: tia vẽ tới điểm cuối mới; ô gạch bị khoan có hiệu ứng vụn (`hitBrick`) — đã có sẵn âm/hiệu ứng.

## 3. Cân bằng — món mạnh vẫn có giá, co-op không thành dễ quá
1. **Hồi chiêu ≥ 2× đạn thường** cho mọi súng trừ Sao Băng (bù bằng sát thương thấp). Laser 30 tick ⇒ tối đa 1 tia/s, đạn thường bắn được ~3 viên/s khi đứng gần.
2. **Không súng nào chạm tới đại bàng**: thép quanh đại bàng (sau shovel) và tường đại bàng chặn mọi súng; không súng nào thay shovel/helmet. Đại bàng vẫn là thứ cả đội phải thủ.
3. **Giới hạn cứng**: Hoả Tiễn 6 quả/màn, Rồng thanh nhiệt, Sao Băng miễn băng 3 s, Plasma/Pháo Hoa 1 viên trên sân. Hết ⇒ tự về đạn thường.
4. **Đổi súng mất 15 tick** (0,5 s không bắn) — không xoay vòng hồi chiêu để spam. Về đạn thường thì tức thì.
5. **Vũ khí vùng có rủi ro đồng đội**: nổ Plasma, mảnh Pháo Hoa, lửa Rồng làm **choáng đồng đội 1 s** khi phòng bật bắn đồng đội. Laser đi qua đồng đội — đó là ưu điểm riêng của Laser.
6. **Phòng Thường không nộp BXH** (đã có: `casual` không gửi điểm). Thắng ở Phòng Thường chỉ cho vui/thử súng.
7. Ngưỡng đo (§6): nếu bot 4 người dùng súng thắng 3 màn **cao hơn đạn thường > 25 điểm %**, hoặc thời gian qua màn < 60% ⇒ tăng hồi chiêu của súng đó trước khi ship (chỉ đổi số trong `WEAPONS`).

**Lối cho người không mua** (không loot box, không bán đạn theo viên):
- **Hộp ⚡** ở Phòng Thường: xe bonus (`isBonusIndex`, mỗi 7 xe) rơi thêm hộp ⚡ = 1 súng ngẫu nhiên trong 20 s cho người nhặt. Ai cũng được thấy súng ngay trận đầu.
- **Thử 1 trận/ngày** mỗi súng chưa có (nút 🔒 → "Thử trận này").
- **Mở bằng gold** khi Chiến dịch/`PROGRESSION_ON` bật (PR #10) — giá gold như v1 §4.
- Đạn thường **không bị giảm** chỉ số nào; 4 người đạn thường vẫn qua được mọi màn như hôm nay (test snapshot + playtest giữ nguyên).

## 4. Phòng Chuẩn / BXH không bị ảnh hưởng
- `weaponFor()` trả `null` khi `!WEAPON_MODES[this.mode]`; chỉ `casual` có trong bảng ⇒ mode `standard` (mặc định, có BXH) luôn bắn đạn thường dù đang trang bị SKU nào.
- Test bắt buộc: `test/standard-snapshot.test.js` — hash 1800 tick khớp main **với từng SKU trong 6 SKU** được trang bị (hiện mới có Laser). Không thêm cờ nào vào đường chạy `standard`.
- Ở Chuẩn, kiểu đạn đã mua chỉ đổi hình (như hiện nay).

## 5. Thứ tự làm (mỗi bước 1 PR nhỏ, đi qua `npm test` + playtest trước khi ship)
1. **Laser v2** — xuyên 4 ô gạch, 3 địch, dừng ở thép/tường đại bàng. Chỉ sửa `WEAPONS` + vòng lặp `fireBeam` + test. Nhỏ nhất và là cái owner hỏi.
2. **Hộp ⚡ + Thử 1 trận** — mở lối free trước khi thêm súng đắt.
3. **Plasma** (nổ vùng) → 4. **Sao Băng** (đóng băng + xuyên đạn) → 5. **Pháo Hoa** (mảnh = đạn con dùng lại `updateBullet`) → 6. **Hoả Tiễn** (bẻ lái + phá thép + băng 6 quả) → 7. **Hơi Thở Rồng** (cần input "giữ nút" + UI thanh nhiệt — lớn nhất).
Vẫn SANDBOX thanh toán; không đổi giá; mua skin đạn = có súng (như v1 §4).

## 6. Cách đo
**Unit test** (`test/weapons.test.js`, sân dựng tay):
- Laser v2: tường 4 ô gạch rồi địch ⇒ địch chết + 4 ô gạch bị xoá; tường 5 ô ⇒ tia dừng, ô thứ 5 còn, địch sống; thép ⇒ dừng, thép còn; tường đại bàng ⇒ dừng, không xoá; 4 địch thẳng hàng ⇒ 3 chết, con thứ 4 sống; đồng đội trên đường ⇒ không choáng; hồi chiêu 30.
- Mỗi súng sau: 1 test cho "việc riêng" (Plasma xoá đúng 3×3 + −2 tâm; Hoả Tiễn phá 1 ô thép + hết 6 quả về đạn thường; Pháo Hoa 8 mảnh × 4 ô; Sao Băng đóng băng 60 tick + miễn 90 tick + huỷ ≤ 3 đạn; Rồng −1/6 tick, quá nhiệt 90/60) và 1 test cho "điểm yếu".
- `standard-snapshot`: hash khớp với cả 6 SKU.

**Bot playtest / mô phỏng cân bằng** (`test/weapons-sim.js` mới, headless engine, không cần trình duyệt):
- 4 bot × 3 màn × 50 seed, chạy 7 cấu hình (đạn thường + 6 súng). Đo: tỉ lệ thắng, tick qua màn, tỉ lệ mất đại bàng, % gạch bị phá.
- Ngưỡng: súng thắng ≤ đạn thường + 25 điểm %; tick qua màn ≥ 60% đạn thường; mỗi súng phải **thắng đạn thường ở ít nhất 1 chỉ số** (nếu không ⇒ súng yếu, tăng lên).
- Trình duyệt: mở rộng `test/laser-playtest.js` — phòng casual, bắn tia qua tường gạch, kiểm `beams` kết thúc sau tường và ô gạch biến mất; `npm run playtest` + `playtest:shop` như cũ; đo 4 khung mobile.

## 7. Tham khảo cộng đồng
- Battle City — sao bậc 3 cho đạn **phá thép và gấp đôi tác dụng lên gạch**: tức là bản gốc coi "xuyên/phá tường" là phần thưởng mạnh nhất. https://www.strategywiki.org/wiki/Battle_City/Gameplay · mẹo đánh armor cần sao 2: https://www.strategywiki.org/wiki/Battle_City/Walkthrough
- Tank 1990 (bản hack nổi tiếng của Battle City) thêm vật phẩm súng lục = **max hoả lực ngay** và thuyền qua nước — vật phẩm mạnh rõ, nhặt là thấy khác. https://en.wikipedia.org/wiki/Battle_City_(video_game) · https://www.hardcoregaming101.net/tank-battalion-battle-city/
- Metal Slug — mỗi súng một việc rõ: Rocket mạnh với xe bọc thép, Flame Shot mạnh sát nách yếu tầm xa, Laser tốn đạn nhanh (giới hạn = cái giá). Mẫu cho bảng "việc riêng / điểm yếu". https://metalslug.fandom.com/wiki/Weapons · https://metalslug.fandom.com/wiki/Laser_Gun
- Phản ứng người chơi với súng trả tiền: ghét nhất khi đồ trả tiền cho lợi thế mà người free không bao giờ có được (War Robots, Diablo Immortal) ⇒ giữ BXH vanilla + lối free (hộp ⚡/thử/gold). https://steamcommunity.com/app/767560/discussions/0/2954914688114067146 · https://www.pcgamer.com/uk/diablo-immortal-microtransactions-have-sparked-a-brutal-backlash/

## 8. Sửa so với v1
- SKU đúng theo `cf/economy.mjs`: `tank.bullet.fire` (Hoả Tiễn), `tank.bullet.meteor` (Sao Băng) — v1 ghi nhầm `rocket`/`frost`.
- Laser: từ "không phá gạch" ⇒ **khoan 4 ô gạch, 3 địch**. Plasma thêm −2 tâm. Hoả Tiễn có phá thép ngay (v1 phải cấp 5). Sao Băng từ "chỉ làm chậm" ⇒ đóng băng + xuyên đạn. Rồng thêm đốt đạn địch.
- Bỏ "nâng cấp 1→5" khỏi bước đầu: súng phải mạnh ngay khi mua; nâng cấp gold để sau cùng PROGRESSION_ON.
