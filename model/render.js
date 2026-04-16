import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import Config from './config.js'
import { STATE, ROLE } from './game.js'

export async function renderGame(game) {
  const data = buildRenderData(game)
  return puppeteer.screenshot('undercover-plugin', {
    saveId: `chat-${game.groupId}`,
    imgType: 'png',
    tplFile: `./plugins/undercover-plugin/resources/html/chat.html`,
    _data: data,
  })
}

function buildRenderData(game) {
  const ended = game.state === STATE.ENDED
  const stateLabel = buildStateLabel(game)

  const players = game.players.map(p => ({
    order: p.order || '-',
    nickname: p.nickname,
    avatar: p.avatar,
    alive: p.alive,
    displayWord: buildDisplayWord(p, ended),
    wordClass: ended ? (p.role === ROLE.UNDERCOVER ? 'undercover' : 'civilian') : '',
  }))

  const allMessages = game.messages || []
  const maxMessages = Math.max(1, Number(Config.get().game?.maxMessages ?? 40))
  const truncated = allMessages.length > maxMessages
  const messages = truncated ? allMessages.slice(-maxMessages) : allMessages

  return {
    stateLabel,
    statusText: buildStatusText(game),
    ended,
    players,
    messages,
    truncated,
    omittedCount: truncated ? allMessages.length - maxMessages : 0,
  }
}

function buildDisplayWord(player, ended) {
  if (!player.order) return '等待中'
  if (!ended) return '?'
  return player.word || '?'
}

function buildStateLabel(game) {
  switch (game.state) {
    case STATE.WAITING:
      return `等待玩家加入 (${game.players.length})`
    case STATE.DESCRIBING:
      return game.tie ? `第${game.round}轮 · 加赛描述中` : `第${game.round}轮 · 描述中`
    case STATE.VOTING:
      return game.tie ? `第${game.round}轮 · 加赛投票中` : `第${game.round}轮 · 投票中`
    case STATE.ENDED:
      return game.winner === ROLE.UNDERCOVER ? '卧底胜利' : '平民胜利'
    default:
      return ''
  }
}

function buildTally(game) {
  const isTieVote = game.tie?.phase === 'voting'
  const votes = isTieVote ? game.tie.votes : game.votes
  const abstainList = isTieVote ? game.tie.abstain : game.abstain
  const alive = game.players.filter(p => p.alive).sort((a, b) => a.order - b.order)
  const parts = []
  for (const p of alive) {
    const count = votes[p.userId]?.length || 0
    if (count > 0) parts.push(`${p.order}号 ${count}票`)
  }
  if (abstainList.length) parts.push(`弃权 ${abstainList.length}`)
  return parts.length ? `票数：${parts.join(' · ')}` : '暂无投票'
}

function buildStatusText(game) {
  if (game.state === STATE.WAITING) {
    const n = game.players.length
    const need = game.config.minPlayers
    if (n < need) return `还需 ${need - n} 人，发送 #加入卧底 参与`
    return `人数已就绪（${n}人），发起人可发送 #开始卧底`
  }
  if (game.state === STATE.DESCRIBING) {
    const speaker = game.players.find(p => p.alive && p.order === game.currentOrder)
    const prefix = game.tie ? '加赛 · 请 ' : '请 '
    if (speaker) return `${prefix}${speaker.order}号 ${speaker.nickname} 发送 #描述 内容`
    return '等待描述...'
  }
  if (game.state === STATE.VOTING) {
    const alive = game.players.filter(p => p.alive)
    const tie = game.tie
    const isTieVote = tie?.phase === 'voting'
    const voted = isTieVote
      ? Object.values(tie.votes).reduce((s, arr) => s + arr.length, 0) + tie.abstain.length
      : Object.values(game.votes).reduce((s, arr) => s + arr.length, 0) + game.abstain.length
    const tally = buildTally(game)
    if (isTieVote) {
      const options = tie.candidates
        .map(uid => game.players.find(p => p.userId === uid))
        .filter(Boolean)
        .sort((a, b) => a.order - b.order)
        .map(p => `${p.order}号`)
        .join('/')
      return `${tally}\n加赛仅可投 ${options} 或 #弃权（${voted}/${alive.length}）`
    }
    return `${tally}\n存活玩家发送 #投票 N号 或 #弃权（${voted}/${alive.length}）`
  }
  if (game.state === STATE.ENDED) {
    const pair = game.wordPair
    return `平民词：${pair.civilian} ｜ 卧底词：${pair.undercover}`
  }
  return ''
}
