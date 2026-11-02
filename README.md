# OptionDesk · 期权交易工作台

## 🆕 每日自动扫描（云端版 · GitHub Pages）

每日美股收市后自动扫全市场，唔使手打股票代码，开页就见到今日有冇嘢做。

```
21:30 UTC（港澳 05:30）→ GitHub Actions 扫成交额 Top 150
   → 评分 + 分类 + 生成建议结构 → 烤进单档 HTML → commit
   → GitHub Pages 自动部署 → 朝早开网页就见到今日机会
```

**数据源**：Nasdaq 官方公开 API（`api.nasdaq.com`），免费、免注册、免 key。

### 首次部署（手机都做得到，约 5 分钟）

**1. GitHub 建 repo**
手机浏览器开 [github.com/new](https://github.com/new)（建议开「电脑版网站」），
名字填 `option-desk`，选 **Public**（Actions + Pages 免费额无上限），**不要**勾选初始化选项。

**2. 把代码推上 repo**
将本仓库全部文件（含 `.github/workflows/` 两个 yml）推到 `main` 分支。

**3. 开启 GitHub Pages**
repo 页面 → **Settings → Pages → Build and deployment → Source 选「GitHub Actions」**。
（仓库已自带 `pages-deploy.yml`，选咗 Actions 就会自动接管部署，唔使再设任何嘢。）

**4. 记住网址**
部署成功后网址为 `https://<你的用户名>.github.io/option-desk/`。
首次部署约 1–2 分钟，之后每次扫描自动更新。

### 手动触发（想即刻睇今日数据）
GitHub repo → **Actions → 每日期权扫描 → Run workflow**，约 5–10 分钟后 GitHub Pages 自动更新。
（想抓更长期权链可在 workflow 里改 `fetch.py "$SYM" --months 24`，默认已系 24 个月，含 LEAPS 到期日。）

### 過往績效（自動覆盤）
每日掃描後自動跟進過往「可出手」建議，網頁頂部顯示：

- **信號命中率**：建議後 10 個交易日內，價格進入盈利區間（買方=區間被觸及；賣方=收市仍在區間）
- **到期勝率**：到期結算每手賺錢嘅比例
- **平均報酬**：每手盈虧 ÷ 收取／付出權利金
- **提前平倉**：風控引擎按凍結建倉 IV + Black-Scholes 估值，賣方 −200%/+50%、買方 −50%/+100% 觸發提前止損／止盈

數據存 `scan/perf.json`，**只保留最近 90 筆已結算紀錄**（更舊嘅併入累計摘要後刪除），檔案大小有上限，唔會撐爆 repo。樣本建議累積 30 筆以上先參考。

### 六个标签点读

| 标签 | 含义 | 典型做法 |
|------|------|----------|
| 🟠 卖方收租 | IV 显著贵过已实现（VR >1.15） | 卖 Put / Iron Condor / Credit Spread |
| 🟢 买方爆发 | IV 被低估、动能积聚（VR <0.92） | Long Straddle / Debit Spread |
| 🟣 财报事件 | 到期日跨过财报 | 特别处理，小心 IV crush |
| 🔵 中性震荡 | IV≈HV、波动收敛 | Iron Condor / 蝶式 |
| 🟡 轧空异动 | 空头拥挤 + call OI 集中 | 方向性做多，禁止裸卖 |
| ⚪ 暂无信号 | 各项都冇触发 | 唔好勉强出手 |

关键指标：**VR = IV30 ÷ HV20**（>1.15 期权偏贵→收租；<0.92 偏平→买波）、
**IV Rank**（0–100，IV 喺过去一年嘅分位）、**期限结构**（近月 IV ÷ 远月 IV）。

---

## 原本的单档版本

一个**单文件 HTML** 的专业期权交易 dashboard。对标并超越 [LEAPS Call Analyzer](https://scintillating-phoenix-d349fc.netlify.app/)（仅支持单腿 Long Call 分析），补齐了它缺失的多腿策略、Greeks 引擎、IV 分析与概率工具。

**全部计算在浏览器本地完成。零依赖、零费用、无需账户。**

---

## 快速开始

### 方式一：打开烤好数据的单档（推荐，零联网）
```bash
python3 fetch.py PLTR --months 24       # 抓真实数据 → snapshot-PLTR.json
python3 build.py --snapshot snapshot-PLTR.json
```
产出的 `OptionDesk.html` 双击直接显示 **PLTR 的真实报价／真实期权链**，
完全不需要联网、不需要代理、不需要 API key。

### 方式二：纯 demo 版
```bash
python3 build.py
```
双击 `OptionDesk.html`，打开即内置演示数据（AVGO）。

### 方式三：部署到任意静态托管（免费）
把 `OptionDesk.html` 拖到 [app.netlify.com/drop](https://app.netlify.com/drop)，或上传到 GitHub Pages / 自己的服务器。
注意：部署后仍受浏览器 CORS 限制，**必须先起 public CORS 代理或自建 Functions**，
否则只能用烤进 HTML 的快照数据。

---

## 为什么浏览器不能直连数据源（重要）

不是内存问题，也不是付费问题 —— 是浏览器安全模型：

> Nasdaq、Yahoo Finance 的 API 响应都**没有** `Access-Control-Allow-Origin` 头，
> 同源策略禁止页面里的 JS 读取。任何在浏览器里跑的 JS 都绕不过。
> 唯一的解法是**让服务端转发**（代理），或者**把数据预先烤进文件**。

所以本工具提供三条路（按可靠度排序）：

| 方式 | 操作 | 说明 |
|---|---|---|
| **① 快照烤入** | `fetch.py` + `build.py --snapshot` | 最稳。零联网、零延迟、零失败。缺点是数据静态，重跑即更新 |
| **② 本地代理** | `python3 proxy.py`，右上角「数据源」把「本地代理」移到最上 | 实时数据。零依赖 Python 标准库；只监听 127.0.0.1；域名白名单只放行 `api.nasdaq.com` 等 |
| **③ 公共 CORS 代理** | 什么都不做，自动轮换 AllOrigins / CodeTabs 等 | 免安装，但公共代理偶有限流，不作为主路径 |
| **④ CSV 手动导入** | 左侧「粘贴期权链 CSV」 | 完全离线可用；`type,strike,bid,ask,last,iv,volume,openInterest` |

失败时自动逐级降级 → 最后落到演示数据，**永远不会白屏**。

### 数据源：Nasdaq 官方公开 API（已替换 Yahoo）
Yahoo Finance 在很多网络环境下已不可达（直接拒连，不是限流），故改用
`api.nasdaq.com`，免费、免注册，且比 Yahoo 更全：

| 端点 | 内容 |
|---|---|
| `/api/quote/{SYM}/info` | 实时报价、买/卖价、成交量 |
| `/api/quote/{SYM}/summary` | 52 周高低、市值、板块、目标价 |
| `/api/quote/{SYM}/historical` | 日线 OHLCV（够算 HV10–252 与 Yang-Zhang） |
| `/api/quote/{SYM}/option-chain` | 全期限期权链，含 **bid/ask、成交量、未平仓量 OI** |

---

## 相对原站的升级

| 能力 | 原站（LEAPS Call Analyzer） | OptionDesk |
|---|---|---|
| 策略范围 | 仅单腿 Long Call | **任意多腿（≤8），含股票腿、不同到期日** |
| 策略模板 | 无（纯手填） | **25 个**（备兑、CSP、PMCC、铁鹰、蝶式、日历、对角、比例反向、翡翠蜥蜴…）；选模板自动带入长短腿 DTE／宽度／翼宽并跳去构建器 |
| Greeks | Vega/Theta 手填 | **本地引擎计算至三阶**（Delta/Gamma/Theta/Vega/Rho + Vanna/Charm/Vomma/Veta） |
| 隐含波动率 | 手填 | **从市价反解**（Newton+二分），并诊断「IV 是否可辨识」 |
| 波动率分析 | 仅 IVP 一个格子 | **IV Rank / IVP / HV(10–252) / 4 种 HV 估计器 / 期限结构 / Skew** |
| 概率工具 | 无 | **POP / 期望值 EV / 预期移动 / 风险中性分布 / P(touch)** |
| 损益图 | 仅股价×时间热力图 | 损益曲线 + **多时点路径** + 股价×时间 + **股价×IV** 双热力矩阵 |
| 美式定价 | 无（纯欧式） | CRR 二叉树，捕捉深 ITM Put 提前行权价值 |
| 数据 | 全手填 | Nasdaq 实时报价/期权链(bid,ask,OI)/历史 K 线 + 本地 IV 历史累积 + CSV 兜底 |

---

## 界面导览

- **IV 分析台**：当前 IV、IV Rank、IV Percentile、HV 多周期、IV−HV 散度、1σ 预期移动；自动生成「买方占优 / 卖方占优」结论；IV vs HV 历史、期限结构（Contango/Backwardation 徽章）、IV 微笑。
- **策略构建器**：选模板一键生成（自动填长短腿 DTE／宽度／翼宽）→ 结构评分（风险回报、POP、Theta 效率、Vega 敞口、资金效率、Gamma、盈利区间宽度 7 维加权）→ 最大盈亏/平衡点/占用资金 → 损益曲线与时间衰减路径 → 组合 Greeks 条形图。
- **期权链**：多到期日切换（默认 24 个月，含 LEAPS）、Call/Put 双栏、Δ 与理论价本地计算、点击任意合约加腿。
- **风险与压力**：概率分布 + ±1σ/±2σ、股价×时间 与 股价×IV 热力矩阵、±50% 情景表、IV 冲击/时间衰减/股价冲击/利率冲击压力表。

## 免费获得真实 IV Rank 的方法

免费数据源没有 52 周 IV 历史。本工具会在 `localStorage` **逐日累积**你查询过的 ATM IV 快照（每 ticker 每天一条，保留 3 年）。用得越久，IV Rank 越接近 Market Chameleon 的口径。样本不足 30 天时，退化为用实现波动率代理估算，并在界面上明确标注。

---

## 开发

```
src/
  engine.js      定价与数学核心（BSM / CRR / Greeks / IV 反解 / HV / 概率）
  strategies.js  多腿组合、25 模板、结构评分、热力矩阵
  data.js        数据源适配（Nasdaq / Yahoo / CSV）、CORS 代理轮换、快照还原
  charts.js      纯 SVG 图表（8 类，零依赖）
  app.js         UI 与交互（含策略模板参数自动带入与构建器跳转）
  styles.css     深浅双主题（emerald 主色 #059669 / #34d399）
fetch.py         Nasdaq 数据抓取器（免费、免 key）→ snapshot-<SYM>.json
build.py         内联构建单档 OptionDesk.html（支持 --snapshot 烤入真实数据）
proxy.py         本地 CORS 代理（纯标准库，白名单含 api.nasdaq.com）
.github/workflows/
  daily-scan.yml   每日扫描 + 烤入 HTML + 提交（触发 Pages 部署）
  pages-deploy.yml GitHub Pages 部署
test/            引擎 54 项 + 策略 54 项 + 图表 94 项 + 浏览器冒烟 28 项
```

```bash
# 抓数据 + 烤进单档（推荐）
python3 fetch.py PLTR --months 24
python3 build.py --snapshot snapshot-PLTR.json

node test/engine.test.js       # 单元测试（含蒙特卡洛交叉验证）
node test/strategies.test.js
node test/charts.selftest.js
node test/smoke.js             # 真实 Chromium 冒烟（需 playwright-core + chromium）
```

### fetch.py 参数
| 参数 | 默认 | 说明 |
|---|---|---|
| `--months` | 24（workflow 显式传 24；CLI 默认见源码） | 期权到期日范围（月），含 LEAPS |
| `--years` | 1.2 | 历史日线长度（年），至少要 >1 才算得出 HV252 |
| `--all-strikes` | 关 | 默认只保留现价 ±30% 内的行权价以控制体积；开启则全保留 |
| `--out` | `snapshot-<SYM>.json` | 输出路径 |

## 模型边界（务必阅读）

- BSM 假设波动率常数，真实市场有微笑/偏斜，深 ITM/OTM 定价会偏差；
- POP/EV 基于**风险中性测度**，不是真实世界概率预测，尾部风险会被低估；
- 保证金为简化估算，非券商实收；
- **不构成投资建议**。期权可能损失全部本金，卖方策略风险可能远超本金。
