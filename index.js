import fetch from "node-fetch"
import fs from "fs"

const BAR = "1H"
const EMA_PERIOD = 24
const MIN_KLINE = 400
const TOP_N = 100
const MIN_VOL_USDT = 50_000_000

const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM_EMAIL = process.env.FROM_EMAIL
const TO_EMAIL = process.env.TO_EMAIL

function emaSeries(data, period) {
  const k = 2 / (period + 1)
  const arr = new Array(data.length)
  arr[0] = data[0]
  for (let i = 1; i < data.length; i++) {
    arr[i] = data[i] * k + arr[i - 1] * (1 - k)
  }
  return arr
}

async function checkSymbol(symbol) {
  try {
    const res = await fetch(
      `https://www.okx.com/api/v5/market/candles?instId=${symbol}&bar=${BAR}&limit=${MIN_KLINE}`
    )
    const kline = await res.json()

    const opens = kline.data?.map(d => parseFloat(d[1]))?.reverse()
    const highs = kline.data?.map(d => parseFloat(d[2]))?.reverse()
    
    if (!opens || !highs || opens.length < MIN_KLINE) return null

    const ema = emaSeries(opens, EMA_PERIOD)

    // ✅ 计算连续最高价高于 EMA24 的 K 线数
    let consecutiveAbove = 0
    let originPoint1 = 0      // 上一次多头发力点
    let originPoint = 0       // 本次多头发力点

    // 遍历所有 K 线
    for (let i = 0; i < highs.length; i++) {
      if (highs[i] > ema[i]) {
        consecutiveAbove++
        
        // 当达到 24 根连续时，记录 24 根 K 线前的 EMA24 值
        if (consecutiveAbove === 24) {
          originPoint1 = originPoint
          originPoint = ema[i - 23]  // ✅ 关键：24根前的EMA24（起源点）
        }
      } else {
        consecutiveAbove = 0
      }
    }

    // 如果从未达到过 24 根连续，跳过
    if (originPoint === 0) return null

    const maxOrigin = Math.max(originPoint, originPoint1)
    const minOrigin = Math.min(originPoint, originPoint1)

    // ✅ 检查观察区域条件（使用最新 K 线）
    const lastIndex = opens.length - 1
    const lastLow = kline.data[lastIndex] ? parseFloat(kline.data[lastIndex][3]) : null
    const lastHigh = highs[lastIndex]

    if (!lastLow || !lastHigh) return null

    const observe =
      (lastLow < maxOrigin && lastLow > minOrigin) ||
      (lastHigh > minOrigin && lastHigh < maxOrigin)

    if (observe) {
      return symbol
    }
  } catch (e) {
    console.error(`Error checking ${symbol}:`, e.message)
  }
  return null
}

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
      subject: `Github筛选结果: ${results.length}个`,
      text
    })
  })
}

async function main() {
  console.log("1/3: 获取 OKX 成交额排行...")

  const tickersRes = await fetch(
    "https://www.okx.com/api/v5/market/tickers?instType=SWAP"
  )
  const tickers = await tickersRes.json()

  const top = tickers.data
    .filter(t => t.instId.endsWith("USDT-SWAP"))
    .map(t => ({
      symbol: t.instId,
      volUsdt: parseFloat(t.last) * parseFloat(t.vol24h)
    }))
    .filter(t => t.volUsdt > MIN_VOL_USDT)
    .sort((a, b) => b.volUsdt - a.volUsdt)
    .slice(0, TOP_N)

  console.log(`2/3: 候选币种: ${top.length}`)
  console.log("3/3: 符合条件币种:\n")

  const results = []

  for (const t of top) {
    const r = await checkSymbol(t.symbol)
    if (r) {
      results.push(r)
      console.log(r)
    }
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
  console.log("Done:", results.length)
}

main()
