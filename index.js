import fetch from "node-fetch"
import fs from "fs"

const BAR = "1H"
const EMA_FAST = 24
const EMA_SLOW = 48
const MIN_KLINE = 300
const TOP_N = 50
const MIN_VOL_USDT = 10_000_000

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
    if (!opens || opens.length < EMA_SLOW + 1) return null

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

    // ✅ 新增：open > EMA24
    if (
      fastEma.at(-1) > slowEma.at(-1) &&
      price > emaprice &&
      price < lastemaprice &&
      price > fastEma.at(-1)   // ✅ open > EMA24
    ) {
      return symbol
    }
  } catch {}
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
  console.log("Done:", results.length)
}

main()
