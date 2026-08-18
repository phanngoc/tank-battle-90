# TANK BATTLE 90

Game bắn xe tăng **co-op realtime nhiều người** trên trình duyệt, thiết kế cho điện thoại
với giao diện "máy điện tử băng cầm tay": màn hình LCD ở trên, D-pad + nút BẮN ở dưới.

Gameplay lấy cảm hứng từ thể loại bắn tăng 2D cổ điển (Battle City / Tank 1990). Toàn bộ
code và đồ hoạ pixel đều **tự viết/tự vẽ** — không dùng asset gốc.

## Cách chạy

```bash
cd tank-battle
npm install      # chỉ cần lần đầu (cài 'ws')
npm start        # hoặc: node server.js
```

Server in ra các URL:
- Trên máy này: `http://localhost:3000`
- Trên điện thoại (cùng Wi-Fi): `http://<IP-LAN>:3000`

Mở URL trên **nhiều thiết bị** → tất cả vào chung một trận co-op.

## Điều khiển
- **Điện thoại:** D-pad để di chuyển, nút **BẮN** để bắn (giữ để bắn liên tục).
- **Máy tính:** phím mũi tên hoặc **WASD** để di chuyển, **Space/Enter** để bắn.
- **START:** vào trận / chơi lại khi Game Over.
- 🔊 góc phải màn hình: bật/tắt âm.

## Luật chơi
- Tiêu diệt toàn bộ **20 xe địch** mỗi màn để qua màn tiếp theo.
- **Bảo vệ đại bàng 🦅** ở căn cứ (giữa dưới). Đại bàng bị bắn = thua ngay.
- Mỗi người chơi có **3 mạng**. Hết mạng của tất cả người chơi HOẶC đại bàng bị phá = Game Over.
- Bắn vỡ **tường gạch**; **thép** chỉ phá được khi đã lên cấp sao tối đa; **nước** chặn xe
  (đạn bay qua); **cây** che khuất xe (đạn xuyên qua).

## Vật phẩm (bắn xe địch **nhấp nháy** để rơi ra)
| Vật phẩm | Hiệu ứng |
|----------|----------|
| ⭐ Ngôi sao | Nâng cấp sức mạnh (đạn nhanh → 2 viên → phá được thép) |
| ⏰ Đồng hồ | Đóng băng toàn bộ địch trong ~8 giây |
| ⛏️ Xẻng | Biến tường quanh căn cứ thành thép ~15 giây |
| 💣 Lựu đạn | Tiêu diệt tất cả địch đang trên bản đồ |
| 🛡️ Mũ giáp | Khiên bất tử tạm thời ~10 giây |
| 🚗 Xe tăng | +1 mạng cho người nhặt |

## Kiến trúc
- `server.js` — HTTP tĩnh + WebSocket + vòng lặp game 30Hz (server giữ trạng thái chuẩn).
- `game.js` — engine mô phỏng: bản đồ, va chạm, AI địch, đạn, vật phẩm, tính điểm.
- `public/` — client mỏng (canvas render + gửi input) và giao diện máy cầm tay.

Server là *authoritative*: client chỉ gửi input (hướng + bắn) và vẽ lại state nhận được →
đồng bộ nhiều người chơi, chống gian lận cơ bản.

## Loại xe địch
- **Basic** (xám) · **Fast** (xanh, đi nhanh) · **Power** (đỏ, bắn nhanh) · **Armor**
  (đổi màu, chịu 4 phát). Xe **nhấp nháy hồng** mang vật phẩm.
