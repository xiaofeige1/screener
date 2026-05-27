import fetch from "node-fetch"
import fs from "fs"

const BAR = "1H"
const DAILY_BAR = "1D"
const EMA_FAST = 24
const EMA_SLOW = 72
const MIN_KLINE = 200
const TOP_N = 100
const MIN_VOL_USDT = 30_000_000

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
// 获取上周六的开盘价
// ======================
function getLastSaturdayOpen(dailyKlines) {
  if (!dailyKlines || dailyKlines.length === 0) return null
  
  // 遍历日线数据，找到周六
  for (const kline of dailyKlines) {
    const timestamp = parseInt(kline[0])
    const date = new Date(timestamp)
    const dayOfWeek = date.getUTCDay()
    
    if (dayOfWeek === 5) {
      return parseFloat(kline[1])
    }
  }
  
  return null
}

// ======================
// 检查单个币种
// ======================
async function checkSymbol(symbol) {
  try {
    const res = await fetch(
      `https://www.okx.com/api/v5/market/candles?instId=${symbol}&bar=${BAR}&limit=${MIN_KLINE}`
    )
    const kline = await res.json()

    const closes = kline.data?.map(d => parseFloat(d[4]))?.reverse()
    const highs = kline.data?.map(d => parseFloat(d[2]))?.reverse()
    
    if (!closes || !highs || closes.length < EMA_SLOW + 1) return null

    const fastEma = emaSeries(closes, EMA_FAST)
    const slowEma = emaSeries(closes, EMA_SLOW)

    const currentHigh = highs.at(-1)
    const previousHigh = highs.at(-2)
    
    const currentFastEma = fastEma.at(-1)
    const currentSlowEma = slowEma.at(-1)

    const condition1 = currentHigh > currentFastEma && currentHigh > currentSlowEma
    const condition2 = previousHigh > currentFastEma && previousHigh > currentSlowEma
    
    if (!condition1 || !condition2) return null

    const dailyRes = await fetch(
      `https://www.okx.com/api/v5/market/candles?instId=${symbol}&bar=${DAILY_BAR}&limit=7`
    )
    const dailyKline = await dailyRes.json()
    
    if (!dailyKline.data || dailyKline.data.length === 0) return null
    
    const lastSaturdayOpen = getLastSaturdayOpen(dailyKline.data)
    if (lastSaturdayOpen === null) return null
    
    const currentPrice = closes.at(-1)
    const condition3 = currentPrice > lastSaturdayOpen
    
    if (condition1 && condition3) {
      return symbol  // ✅ 直接返回 symbol 字符串，不要返回对象
    }
  } catch (e) {
    console.error(`${symbol} 错误:`, e.message)
  }
  return null
}

// ======================
// 发送邮件（简洁版）
// ======================
async function sendEmail(symbols) {
  // 计算北京时间
  const serverTime = new Date()
  const beijingTime = new Date(serverTime.getTime() + 8 * 60 * 60 * 1000)
  const timeStr = beijingTime.toISOString().replace('T', ' ').substring(0, 19)

  // 构建邮件内容 - 简洁明了
  let text = `${timeStr}\n\n筛选条件:\n`
  text += `1. 当前价格 > EMA24 & EMA72\n`
  text += `2. 当前价格 > 上周六开盘价\n\n`
  
  if (symbols.length > 0) {
    text += `${symbols.length}个符合条件的币种:\n`
    symbols.forEach((symbol, i) => {
      text += `${symbol}\n`  // ✅ 直接显示 symbol，没有多余信息
    })
  } else {
    text += "本次筛选无符合条件的品种"
  }

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [TO_EMAIL],
      subject: `Git筛选结果: ${symbols.length}`,
      text
    })
  })
}

// ======================
// 主函数
// ======================
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
    const symbol = await checkSymbol(t.symbol)
    if (symbol) {
      results.push(symbol)
      console.log(symbol)
    }
    
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  // 保存结果到 result.json
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

  console.log("结果已保存到 result.json")
  
  // 发送邮件
  await sendEmail(results)
  console.log("Done:", results.length)
}

main()
