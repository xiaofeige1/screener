import fetch from "node-fetch"
import fs from "fs"

const BAR = "1H"
const DAILY_BAR = "1D"
const EMA_FAST = 24
const EMA_SLOW = 72
const MIN_KLINE = 300
const TOP_N = 100
const MIN_VOL_USDT = 50_000_000

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
    const timestamp = parseInt(kline[0])  // 时间戳（毫秒）
    const date = new Date(timestamp)
    const dayOfWeek = date.getUTCDay()     // 0=周日, 1=周一, ..., 6=周六
    
    if (dayOfWeek === 5) {  // 如果是周六 这里用5是因为okx开盘时间是0点
      return parseFloat(kline[1])  // 返回开盘价
    }
  }
  
  return null
}

// ======================
// 检查单个币种
// ======================
async function checkSymbol(symbol) {
  try {
    // 获取1小时K线数据
    const res = await fetch(
      `https://www.okx.com/api/v5/market/candles?instId=${symbol}&bar=${BAR}&limit=${MIN_KLINE}`
    )
    const kline = await res.json()

    const closes = kline.data?.map(d => parseFloat(d[4]))?.reverse()  // 收盘价
    const highs = kline.data?.map(d => parseFloat(d[2]))?.reverse()    // 最高价
    
    if (!closes || !highs || closes.length < EMA_SLOW + 1) return null

    // 计算EMA24和EMA72（基于收盘价）
    const fastEma = emaSeries(closes, EMA_FAST)
    const slowEma = emaSeries(closes, EMA_SLOW)

    // 获取当前K线和前一根K线的最高价
    const currentHigh = highs.at(-1)      // 当前K线最高价
    const previousHigh = highs.at(-2)     // 前一根K线最高价
    
    // 获取最新的EMA值
    const currentFastEma = fastEma.at(-1)
    const currentSlowEma = slowEma.at(-1)

    // 筛选条件1：当前K线最高价 > EMA24 且 > EMA72
    const condition1 = currentHigh > currentFastEma && currentHigh > currentSlowEma
    
    // 筛选条件2：前一根K线最高价 > EMA24 且 > EMA72
    const condition2 = previousHigh > currentFastEma && previousHigh > currentSlowEma
    
    if (!condition1 || !condition2) return null

    // 获取日线数据（只需要最近7天）
    const dailyRes = await fetch(
      `https://www.okx.com/api/v5/market/candles?instId=${symbol}&bar=${DAILY_BAR}&limit=7`
    )
    const dailyKline = await dailyRes.json()
    
    if (!dailyKline.data || dailyKline.data.length === 0) return null
    
    // 获取上周六的开盘价
    const lastSaturdayOpen = getLastSaturdayOpen(dailyKline.data)
    if (lastSaturdayOpen === null) return null
    
    // 筛选条件3：当前价格高于上周六的开盘价
    const currentPrice = closes.at(-1)
    const condition3 = currentPrice > lastSaturdayOpen
    
    if (condition1 && condition2 && condition3) {
      return {
        symbol: symbol,
        price: currentPrice,
        ema24: currentFastEma.toFixed(2),
        ema72: currentSlowEma.toFixed(2),
        currentHigh: currentHigh.toFixed(2),
        previousHigh: previousHigh.toFixed(2),
        lastSaturdayOpen: lastSaturdayOpen.toFixed(2)
      }
    }
  } catch (e) {
    console.error(`${symbol} 错误:`, e.message)
  }
  return null
}

// ======================
// 发送邮件
// ======================
async function sendEmail(results) {
  // 计算北京时间
  const serverTime = new Date()
  const beijingTime = new Date(serverTime.getTime() + 8 * 60 * 60 * 1000)
  const timeStr = beijingTime.toISOString().replace('T', ' ').substring(0, 19)

  // 构建邮件内容
  let text = `${timeStr}\n\n筛选条件:\n`
  text += `1. 当前K线最高价 > EMA24 & EMA72\n`
  text += `2. 前一根K线最高价 > EMA24 & EMA72\n`
  text += `3. 当前价格 > 上周六0点开盘价\n\n`
  
  if (results.length > 0) {
    text += `符合条件的币种 (${results.length}个):\n`
    results.forEach((r, i) => {
      text += `\n${r.symbol}\n`
      // text += `   当前价格: $${r.price}\n`
      // text += `   EMA24: $${r.ema24}, EMA72: $${r.ema72}\n`
      // text += `   当前最高价: $${r.currentHigh} > EMA24 & EMA72\n`
      // text += `   前一根最高价: $${r.previousHigh} > EMA24 & EMA72\n`
      // text += `   上周六开盘价: $${r.lastSaturdayOpen}\n`
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
      subject: `Git筛选结果: ${results.length}个币种符合条件`,
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
    const r = await checkSymbol(t.symbol)
    if (r) {
      results.push(r.symbol)
      // console.log(`${r.symbol} - 符合条件`)
      // console.log(`   当前价格: $${r.price} > 上周六开盘价: $${r.lastSaturdayOpen}`)
      // console.log(`   当前最高价: $${r.currentHigh} > EMA24: $${r.ema24} & EMA72: $${r.ema72}`)
      // console.log(`   前一根最高价: $${r.previousHigh} > EMA24: $${r.ema24} & EMA72: $${r.ema72}`)
      // console.log("")
    }
    
    // 防止请求过快
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
