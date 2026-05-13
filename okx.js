import fetch from "node-fetch"
import fs from "fs"

// ======================
// 参数区
// ======================
const BAR = "1H"
const EMA_FAST = 24
const EMA_SLOW = 72
const MIN_KLINE = 500
const TOP_N = 100
const MIN_VOL_USDT = 40_000_000

// ======================
// 环境变量（从 GitHub Secrets 读取）
// ======================
const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM_EMAIL = process.env.FROM_EMAIL
const TO_EMAIL = process.env.TO_EMAIL

// ======================
// EMA 序列
// ======================
function emaSeries(data, period) {
  const k = 2 / (period + 1)
  const arr = new Array(data.length)
  arr[0] = data[0]
  for (let i = 1; i < data.length; i++) {
    arr[i] = data[i] * k + arr[i - 1] * (1 - k)
  }
  return arr
}

// ======================
// HTTP 请求
// ======================
async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  })
  return res.json()
}

// ======================
// 发送邮件（Resend）
// ======================
async function sendEmail(results) {
  if (!RESEND_API_KEY || !FROM_EMAIL || !TO_EMAIL) {
    console.log("缺少邮件配置，跳过发送")
    return
  }

  const text = results.length
    ? results.map(r => `• ${r.symbol} ($${r.price})`).join("\n")
    : "本次筛选无符合条件的币种"

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [TO_EMAIL],
        subject: `Github筛选结果: ${results.length}个币种`,
        text
      })
    })
    console.log("邮件发送成功")
  } catch (e) {
    console.error("邮件发送失败:", e.message)
  }
}

// ======================
// 主逻辑
// ======================
async function main() {
  console.log("1/3: 获取永续合约成交额排行...")

  const tickersRes = await fetchJson(
    "https://www.okx.com/api/v5/market/tickers?instType=SWAP"
  )

  const top = tickersRes.data
    .filter(t => t.instId.endsWith("USDT-SWAP"))
    .map(t => ({
      symbol: t.instId,
      volUsdt: parseFloat(t.last) * parseFloat(t.vol24h)
    }))
    .filter(t => t.volUsdt > MIN_VOL_USDT)
    .sort((a, b) => b.volUsdt - a.volUsdt)
    .slice(0, TOP_N)

  console.log(`2/3: 成交额大于${MIN_VOL_USDT / 10000}万U币种数量: ${top.length}`)
  console.log(`3/3: 符合条件币种:\n`)

  const results = []

  for (const t of top) {
    try {
      const kline = await fetchJson(
        `https://www.okx.com/api/v5/market/candles?instId=${t.symbol}&bar=${BAR}&limit=${MIN_KLINE}`
      )

      const opens = kline.data
        ?.map(d => parseFloat(d[1]))
        ?.reverse()

      if (!opens || opens.length < EMA_SLOW + 1) continue

      const fastEma = emaSeries(opens, EMA_FAST)
      const slowEma = emaSeries(opens, EMA_SLOW)

      let emaprice = null
      let lastemaprice = null

      for (let i = 1; i < fastEma.length; i++) {
        if (fastEma[i] <= slowEma[i] && fastEma[i - 1] >= slowEma[i - 1]) {
          lastemaprice = fastEma[i]
        }
        if (fastEma[i] >= slowEma[i] && fastEma[i - 1] < slowEma[i - 1]) {
          emaprice = fastEma[i]
        }
      }

      const price = opens.at(-1)
      const price1 = opens.at(-2)
      const price2 = opens.at(-3)
      const price3 = opens.at(-4)

      const minEma = Math.min(emaprice, lastemaprice)
      const maxEma = Math.max(emaprice, lastemaprice)

      // ✅ 核心逻辑：4根K线中任意一根在区间内
      const isPriceInRange = 
        (price > minEma && price < maxEma) ||
        (price1 > minEma && price1 < maxEma) ||
        (price2 > minEma && price2 < maxEma) ||
        (price3 > minEma && price3 < maxEma)

      const isPriceAboveMid = price > (emaprice + lastemaprice) / 2

      if (isPriceInRange && isPriceAboveMid) {
        results.push({
          symbol: t.symbol,
          price,
          emaprice,
          lastemaprice,
          ema24: fastEma.at(-1)
        })
        console.log(`${t.symbol}`)
      }
    } catch (_) {}
  }

  // 保存结果到文件
  fs.writeFileSync(
    "result.json",
    JSON.stringify(
      {
        time: new Date().toISOString(),
        count: results.length,
        symbols: results
      },
      null,
      2
    )
  )

  // 发送邮件
  await sendEmail(results)

  console.log("==============================")
  console.log(`3/3: 符合条件币种数量: ${results.length}`)
  console.log("==============================")
}

main()
