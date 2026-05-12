import fetch from "node-fetch"
import fs from "fs"

// ======================
// 参数区 (与你的本地代码保持一致)
// ======================
const BAR = "1h"
const EMA_PERIOD = 24
const MIN_KLINE = 300
const TOP_N = 100
const MIN_VOL_USDT = 50_000_000

const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM_EMAIL = process.env.FROM_EMAIL
const TO_EMAIL = process.env.TO_EMAIL

// ======================
// EMA 计算
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
// 核心筛选逻辑 (完全还原你的本地代码)
// ======================
async function checkSymbol(symbol) {
  try {
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${BAR}&limit=${MIN_KLINE}`
    )
    const kline = await res.json()

    // ✅ 数据完整性校验
    if (!Array.isArray(kline) || kline.length < MIN_KLINE) return null

    const opens = kline.map(d => parseFloat(d[1]))
    const highs = kline.map(d => parseFloat(d[2]))
    const lows = kline.map(d => parseFloat(d[3]))

    const ema = emaSeries(opens, EMA_PERIOD)

    let consecutiveAbove = 0
    let originPoint1 = 0
    let originPoint = 0

    for (let i = 0; i < opens.length; i++) {
      if (highs[i] > ema[i]) {
        consecutiveAbove++
        
        // ✅ 关键修复：防止 i - 23 变成负数导致程序崩溃 (这就是你之前 exit code 1 的原因)
        if (consecutiveAbove === 24 && i >= 23) { 
          originPoint1 = originPoint
          originPoint = ema[i - 23] 
        }
      } else {
        consecutiveAbove = 0
      }
    }

    if (originPoint === 0) return null

    const maxOrigin = Math.max(originPoint, originPoint1)
    const minOrigin = Math.min(originPoint, originPoint1)

    const lastIndex = opens.length - 1
    const lastLow = lows[lastIndex]
    const lastHigh = highs[lastIndex]

    const observe =
      (lastLow < maxOrigin && lastLow > minOrigin) ||
      (lastHigh > minOrigin && lastHigh < maxOrigin)

    if (observe) {
      return symbol
    }
  } catch (e) {
    // 捕获单个币种的错误，防止整个程序中断
    console.error(`${symbol} 发生错误:`, e.message)
  }
  return null
}

// ======================
// 邮件发送 (复用你之前成功的逻辑)
// ======================
async function sendEmail(results) {
  const text = results.length
    ? results.map(s => `• ${s}`).join("\n")
    : "本次筛选无符合条件的币种"

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [TO_EMAIL],
      subject: `Binance筛选结果: ${results.length}个`,
      text
    })
  })
}

// ======================
// 主函数
// ======================
async function main() {
  console.log("1/3: 获取 Binance 成交额排行...")

  const tickersRes = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr")
  const tickers = await tickersRes.json()

  const top = tickers
    .filter(t => t.symbol.endsWith("USDT"))
    .map(t => ({
      symbol: t.symbol,
      volUsdt: parseFloat(t.quoteVolume)
    }))
    .filter(t => t.volUsdt > MIN_VOL_USDT)
    .sort((a, b) => b.volUsdt - a.volUsdt)
    .slice(0, TOP_N)

  console.log(`2/3: 成交额大于${MIN_VOL_USDT / 10000}万U数量: ${top.length}`)
  
  const results = []

  for (const t of top) {
    const r = await checkSymbol(t.symbol)
    if (r) results.push(r)
  }

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

  await sendEmail(results)
  console.log("Done. 符合条件币种数量:", results.length)
}

main()
