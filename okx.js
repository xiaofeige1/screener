import fetch from "node-fetch"
import fs from "fs"

const BAR = "1H"
const EMA_FAST = 24
const EMA_SLOW = 72
const MIN_KLINE = 500
const TOP_N = 100
const MIN_VOL_USDT = 40_000_000

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
    const price1 = opens.at(-2)
    const price2 = opens.at(-3)
    const price3 = opens.at(-4)

    const minEma = Math.min(emaprice, lastemaprice)
    const maxEma = Math.max(emaprice, lastemaprice)

    const isPriceInRange = 
      (price > minEma && price < maxEma) ||
      (price1 > minEma && price1 < maxEma) ||
      (price2 > minEma && price2 < maxEma) ||
      (price3 > minEma && price3 < maxEma)

    const isPriceAboveMid = price > (emaprice + lastemaprice) / 2

    if (isPriceInRange && isPriceAboveMid) {
      return symbol
    }
  } catch (e) {
    console.error(`${symbol} 错误:`, e.message)
  }
  return null
}

async function sendEmail(results) {
  // ✅ 仅计算北京时间，不做任何多余加工
  const serverTime = new Date()
  const beijingTime = new Date(serverTime.getTime() + 8 * 60 * 60 * 1000)
  const timeStr = beijingTime.toISOString().replace('T', ' ').substring(0, 19)

  // ✅ 保持你原来的格式，只加时间前缀
  const text = `${timeStr}\n\n` + (results.length
    ? results.map(s => `• ${s}`).join("\n")
    : "本次筛选无符合条件的品种")

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [TO_EMAIL],
      subject: `Git筛选结果: ${results.length}`, // 保持你原来的主题
      text
    })
  })
}

async function main() {
  console.log("1/3: 获取永续合约成交额排行...")

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
