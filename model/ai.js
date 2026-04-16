import fs from 'node:fs'
import path from 'node:path'
import Config from './config.js'

const LOCAL_WORDS_PATH = path.join(
  process.cwd(),
  'plugins/undercover-plugin/resources/words.json',
)

const historyByGroup = new Map()
const HISTORY_LIMIT = 30

function loadLocalWords() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_WORDS_PATH, 'utf8'))
  } catch {
    return []
  }
}

function pickLocalPair() {
  const words = loadLocalWords()
  if (!words.length) return null
  return words[Math.floor(Math.random() * words.length)]
}

function recordPair(groupId, pair) {
  if (!pair || !groupId) return
  const key = String(groupId)
  if (!historyByGroup.has(key)) historyByGroup.set(key, [])
  const list = historyByGroup.get(key)
  list.push(pair)
  if (list.length > HISTORY_LIMIT) list.shift()
}

function buildAvoidText(groupId) {
  const list = historyByGroup.get(String(groupId)) || []
  if (!list.length) return ''
  const names = list.map(p => `${p.civilian}-${p.undercover}`).join('、')
  return `\n\n本群最近出过的词对（严格避免重复或过于相似）：${names}`
}

async function askAi(groupId, category) {
  const cfg = Config.get().ai || {}
  if (!cfg.apiUrl || !cfg.apiKey) {
    throw new Error('AI apiUrl 或 apiKey 未配置')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), (cfg.timeout || 30) * 1000)

  let userPrompt = cfg.userPrompt || ''
  if (category) {
    userPrompt += `\n\n本局指定词组类型/范围为「${category}」，请围绕此类型生成词对。`
  }
  userPrompt += buildAvoidText(groupId)

  const body = {
    model: cfg.model,
    temperature: cfg.temperature ?? 1.1,
    messages: [
      { role: 'system', content: cfg.systemPrompt || '' },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    stream: false,
  }

  try {
    const res = await fetch(cfg.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${res.statusText} ${text}`)
    }
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (!content) throw new Error('AI 返回为空')
    return parsePair(content)
  } finally {
    clearTimeout(timer)
  }
}

function parsePair(text) {
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    const m = text.match(/\{[\s\S]*?\}/)
    if (!m) throw new Error(`AI 返回无法解析为 JSON: ${text.slice(0, 100)}`)
    obj = JSON.parse(m[0])
  }
  const civilian = String(obj.civilian || '').trim()
  const undercover = String(obj.undercover || '').trim()
  if (!civilian || !undercover)
    throw new Error(`AI 返回缺少 civilian/undercover 字段: ${text.slice(0, 100)}`)
  if (civilian === undercover) throw new Error('AI 返回的两个词相同')
  return { civilian, undercover }
}

async function askAiWithRetry(groupId, category) {
  const cfg = Config.get().ai || {}
  const retries = Math.max(1, Number(cfg.retryCount ?? 3))
  let lastErr
  for (let i = 1; i <= retries; i++) {
    try {
      return await askAi(groupId, category)
    } catch (err) {
      lastErr = err
      logger?.warn(`[谁是卧底] AI 出词第 ${i}/${retries} 次失败：${err?.message || err}`)
    }
  }
  throw lastErr
}

export async function pickWordPair(groupId, category) {
  const cfg = Config.get()
  const source = cfg.wordSource || 'mix'

  if (source === 'local' && !category) {
    const p = pickLocalPair()
    recordPair(groupId, p)
    return p
  }

  if (source === 'ai' || category) {
    const p = await askAiWithRetry(groupId, category)
    recordPair(groupId, p)
    return p
  }

  try {
    const p = await askAiWithRetry(groupId, category)
    recordPair(groupId, p)
    return p
  } catch (err) {
    logger?.warn(`[谁是卧底] AI 出词重试耗尽，降级本地词库：${err?.message || err}`)
    const p = pickLocalPair()
    recordPair(groupId, p)
    return p
  }
}
