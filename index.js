import fetch from "node-fetch"
import fs from "fs"

// ======================
// 参数区
// ======================
const BAR = "1h"
const EMA_PERIOD = 24
const MIN_KLINE = 300
const TOP_N = 100
const MIN_VOL_USDT = 50_000_000

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
// 单个币种筛选
// ======================
async function checkSymbol(symbol) {
  try {
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${BAR}&limit=${MIN_KLINE}`
    )
    const kline = await res.json()

    const opens = kline.map(d => parseFloat(d[1]))
    const highs = kline.map(d => parseFloat(d[2]))
    const lows = kline.map(d => parseFloat(d[3]))
    
    if (opens.length < MIN_KLINE) return null

    const ema = emaSeries(opens, EMA_PERIOD)

    // ✅ 计算连续最高价高于 EMA24 的 K 线数
    let consecutiveAbove = 0
    let originPoint1 = 0
    let originPoint = 0

    for (let i = 0; i < opens.length; i++) {
      if (highs[i] > ema[i]) {
        consecutiveAbove++
        
        if (consecutiveAbove === 24) {
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
      return {
        symbol,
        price: opens[lastIndex],
        ema24: ema[lastIndex].toFixed(2),
        originHigh: maxOrigin.toFixed(2),
        originLow: minOrigin.toFixed(2)
      }
    }
  } catch (e) {
    console.error(`${symbol}: ${e.message}`)
  }
  return null
}

// ======================
// 发送邮件（Resend）
// ======================
async function sendEmail(results) {
  const apiKey = process.env.RESEND_API_KEY
  const fromEmail = process.env.FROM_EMAIL
  const toEmail = process.env.TO_EMAIL

  if (!apiKey || !fromEmail || !toEmail) {
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
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: `币安筛选结果：${results.length}个币种`,
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
  console.log("1/3: 获取 Binance 成交额排行...")

  const tickersRes = await fetch(
    "https://fapi.binance.com/fapi/v1/ticker/24hr"
  )
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

  console.log(`2/3: 候选币种: ${top.length}`)
  console.log("3/3: 开始筛选...\n")

  const results = []

  for (const t of top) {
    const r = await checkSymbol(t.symbol)
    if (r) {
      results.push(r)
      console.log(`${r.symbol} $${r.price}`)
    }
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
  console.log(`最终结果: ${results.length}个`)
  console.log("==============================")
}

main()
