# 紅黑大小單雙(多人連線版)

零依賴的 Node.js 伺服器(需要 Node 18 以上)。玩家只要打開同一個網址就能一起玩,不用註冊。

## 本機試玩

```bash
cd hongxi-dice
npm start          # 預設在 http://localhost:3000
```

同一個 Wi-Fi 下,朋友可以用 `http://你的電腦區網IP:3000` 加入。

## 放到網路上(讓任何人用網址玩)

任何能跑 Node.js 的主機都可以,例如 Render、Railway、Fly.io、自己的 VPS。

1. 把整個 `hongxi-dice` 資料夾推到 GitHub。
2. 在 Render 建立 Web Service,Build Command 留空,Start Command 填 `npm start`。
3. 部署完成後會得到一個網址,例如 `https://xxx.onrender.com`。
4. 在網址上按「建立房間」,再按「複製邀請連結」傳給朋友,他們輸入暱稱就能加入。

## 注意事項

- 房間存在伺服器記憶體裡,伺服器重啟後房間會消失;閒置 3 小時的房間會自動清除。
- 只能跑單一實例。如果平台自動開多台機器,同一個房間的玩家可能連到不同台,要固定成 1 台。
- 免費方案若會休眠,第一次開啟網址會慢幾十秒。
- 骰子由伺服器擲出,每位玩家只收到自己有權看到的骰子,不能從瀏覽器偷看別人。
- 每回合 30 秒,超時由伺服器代喊(`server.js` 最上面的 `TURN_MS` 可以調)。
