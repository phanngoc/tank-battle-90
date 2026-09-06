<div align="center">

# 🕹️ TANK BATTLE 90

**Game bắn xe tăng co-op realtime nhiều người — chơi trên trình duyệt & điện thoại**
Giao diện "máy điện tử băng" cổ điển · lấy cảm hứng từ Battle City / Tank 1990

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-green?logo=node.js&logoColor=white)
![Realtime](https://img.shields.io/badge/realtime-WebSocket-orange)
![Co-op](https://img.shields.io/badge/co--op-up%20to%204P-ffd23f)
![Mobile](https://img.shields.io/badge/mobile-friendly-e94f37)

### [▶ Chơi Demo ngay trên trình duyệt](https://phanngoc.github.io/tank-battle-90/demo.html) · [🌐 Trang giới thiệu](https://phanngoc.github.io/tank-battle-90/)

<img src="docs/img/gameplay.gif" width="360" alt="TANK BATTLE 90 gameplay" />

</div>

---

## ✨ Tính năng
- 🎮 **Giao diện máy điện tử băng**: màn hình LCD (có scanline) ở trên, D-pad + nút BẮN cỡ lớn ở dưới — tối ưu cảm ứng.
- 🌐 **Co-op realtime tới 4 người** qua WebSocket; server giữ trạng thái chuẩn (*authoritative*).
- 🦅 **Bảo vệ đại bàng**, diệt 20 xe địch/màn qua 3 màn địa hình khác nhau.
- ⭐ **6 vật phẩm**, 🤖 **4 loại xe địch**, 🧱 địa hình gạch/thép/nước/cây.
- 🕹️ **Demo 1 người chơi ngay trên GitHub Pages** — chạy engine client-side, không cần server.

## 🔗 Phòng chơi & link mời
- Người chơi 1 bấm **TẠO PHÒNG MỚI** → nhận **mã phòng 4 ký tự** + **link mời** (kèm nút Copy).
- Gửi link (dạng `.../?room=XXXX`) cho người chơi 2 → họ mở link, nhập tên, bấm **VÀO** là vào đúng phòng đó.
- Mỗi phòng là một trận riêng biệt, tối đa **4 người**; người mới có thể nhập bất cứ lúc nào.
- Mã phòng cũng hiển thị trên đầu màn hình — bấm vào để copy link mời nhanh.
- Phòng trống sẽ tự xoá sau ~60 giây.

## 🚀 Chạy bản co-op (nhiều người, cùng Wi-Fi)

```bash
git clone https://github.com/phanngoc/tank-battle-90.git
cd tank-battle-90
npm install      # chỉ lần đầu (cài 'ws')
npm start        # hoặc: node server.js
```

Server in ra URL:
- Trên máy này: `http://localhost:3000`
- Trên điện thoại (cùng Wi-Fi): `http://<IP-LAN>:3000`

Mở URL trên **nhiều thiết bị** → tất cả vào chung một trận co-op.

## 🎯 Điều khiển
| | Di chuyển | Bắn | Vào trận / Chơi lại |
|---|---|---|---|
| **Điện thoại** | D-pad | nút **BẮN** (giữ = bắn liên tục) | **START** |
| **Máy tính** | mũi tên / **WASD** | **Space / Enter** | **START** |

## 📜 Luật chơi
- Tiêu diệt toàn bộ **20 xe địch** mỗi màn để qua màn.
- **Bảo vệ đại bàng 🦅** ở căn cứ (giữa dưới). Đại bàng bị bắn = thua ngay.
- Mỗi người **3 mạng**. Hết mạng của tất cả HOẶC đại bàng bị phá = Game Over.
- Gạch vỡ được; **thép** chỉ phá khi lên sao tối đa; **nước** chặn xe (đạn bay qua); **cây** che khuất xe.

## 🎁 Vật phẩm (bắn xe địch **nhấp nháy** để rơi ra)
| Vật phẩm | Hiệu ứng |
|----------|----------|
| ⭐ Ngôi sao | Nâng cấp sức mạnh (đạn nhanh → 2 viên → phá được thép) |
| ⏰ Đồng hồ | Đóng băng toàn bộ địch ~8 giây |
| ⛏️ Xẻng | Tường quanh căn cứ hoá thép ~15 giây |
| 💣 Lựu đạn | Tiêu diệt tất cả địch đang trên bản đồ |
| 🛡️ Mũ giáp | Khiên bất tử tạm thời ~10 giây |
| 🚗 Xe tăng | +1 mạng cho người nhặt |

## 🤖 Loại xe địch
**Basic** (xám) · **Fast** (xanh, đi nhanh) · **Power** (đỏ, bắn nhanh) · **Armor** (đổi màu, chịu 4 phát). Xe **nhấp nháy hồng** mang vật phẩm.

## 📸 Ảnh chụp
| Màn hình bắt đầu | Trong trận |
|---|---|
| <img src="docs/img/screen-title.png" width="260" /> | <img src="docs/img/screen-gameplay.png" width="260" /> |

## 🏗️ Kiến trúc
| File | Vai trò |
|------|---------|
| `server.js` | HTTP tĩnh + WebSocket + game loop 30Hz (server-authoritative) |
| `game.js` | Engine mô phỏng: bản đồ, va chạm, AI địch, đạn, vật phẩm, điểm — chạy được cả Node lẫn browser |
| `public/` | Client online (canvas render + gửi input) & giao diện máy cầm tay |
| `docs/` | GitHub Pages: trang giới thiệu + **demo 1 người chơi client-side** |

Server là *authoritative*: client chỉ gửi input (hướng + bắn) và vẽ lại state nhận được → đồng bộ nhiều người & chống gian lận cơ bản.

## 📄 License
[MIT](LICENSE) © phanngoc · Đồ hoạ & code **nguyên bản**; gameplay lấy cảm hứng từ dòng game bắn tăng 2D cổ điển.

## Chạy trên platform Arcade

Bản port sang [arcade-platform](https://github.com/phanngoc/arcade-platform): toàn bộ
netcode viết tay được thay bằng một **room module**.

| | Trước | Sau |
|---|---|---|
| `server.js` | 193 dòng: HTTP tĩnh, WebSocket, sổ phòng, sinh mã, thu hồi phòng trống, vòng lặp, broadcast | platform lo hết |
| `game.js` | 645 dòng gameplay | **không đổi một dòng** |
| `server/room.part.js` | — | ~130 dòng ánh xạ engine ↔ hook |

```bash
node server/build-room.js   # ghép game.js + room.part.js -> server/room.js
```
Sandbox không có `require`, nên engine phải nằm cùng file với room module.
Chạy lại lệnh trên mỗi khi sửa `game.js`.

**Ba điều học được khi port:**

1. **`tanks`/`bullets` là object theo id, không phải mảng.** Platform diff mảng theo chỉ số
   (không LCS — quá đắt ở 30Hz), nên xoá một viên đạn ở giữa mảng làm mọi phần tử sau dịch
   chỗ và patch to bằng cả mảng. Object keyed-by-id thì xoá = một op.
2. **`events`/`mapDelta`/`effects` gửi bằng `room.broadcast()`, không nằm trong state** —
   chúng chỉ sống một tick; để trong state thì mỗi tick sinh 2 op cho thứ không phải state.
3. **Input của client phải kiểm tra.** `dir` ngoài khoảng 0..3 làm `DIR[tank.dir]` undefined,
   engine ném lỗi, platform thu hồi cả phòng — một client hỏng đá văng cả trận của người khác.

Đo được ở 100 CCU (25 phòng × 4 người): **462 CCU/vCPU, tick p99 0,99ms, 5,3 KB/s mỗi người.**

`server.js` vẫn giữ để chạy độc lập (bản đang live tại tank.bomclaw.org dùng nó).
