import Config from './config.js'

const games = {}

export const STATE = {
  WAITING: 'waiting',
  DESCRIBING: 'describing',
  VOTING: 'voting',
  ENDED: 'ended',
}

export const ROLE = {
  CIVILIAN: 'civilian',
  UNDERCOVER: 'undercover',
}

let externalTick = null
export function setExternalTick(fn) {
  externalTick = fn
}

function notify(game, type, extra) {
  try {
    externalTick?.(game, type, extra)
  } catch (err) {
    logger?.error(`[谁是卧底] tick 回调异常`, err)
  }
}

function clearTimer(game) {
  if (game?._timer) {
    clearTimeout(game._timer)
    game._timer = null
  }
  if (game?._warnTimer) {
    clearTimeout(game._warnTimer)
    game._warnTimer = null
  }
}

function getWarnBefore() {
  return Math.max(0, Number(Config.get().game?.warnBefore ?? 30))
}

function scheduleWaitTimeout(game) {
  clearTimer(game)
  const sec = Math.max(30, Number(Config.get().game?.waitTimeout ?? 300))
  game._timer = setTimeout(() => onWaitTimeout(game), sec * 1000)
}

function scheduleDescribeTimeout(game) {
  clearTimer(game)
  const sec = Math.max(10, Number(Config.get().game?.describeTimeout ?? 120))
  const warn = getWarnBefore()
  game._timer = setTimeout(() => onDescribeTimeout(game), sec * 1000)
  if (warn > 0 && sec > warn) {
    game._warnTimer = setTimeout(() => {
      game._warnTimer = null
      if (game.state === STATE.DESCRIBING) notify(game, 'describe-warn', { secondsLeft: warn })
    }, (sec - warn) * 1000)
  }
}

function scheduleVoteTimeout(game) {
  clearTimer(game)
  const sec = Math.max(10, Number(Config.get().game?.voteTimeout ?? 120))
  const warn = getWarnBefore()
  game._timer = setTimeout(() => onVoteTimeout(game), sec * 1000)
  if (warn > 0 && sec > warn) {
    game._warnTimer = setTimeout(() => {
      game._warnTimer = null
      if (game.state === STATE.VOTING) notify(game, 'vote-warn', { secondsLeft: warn })
    }, (sec - warn) * 1000)
  }
}

function onWaitTimeout(game) {
  if (game.state !== STATE.WAITING) return
  clearTimer(game)
  delete games[game.groupId]
  notify(game, 'wait-timeout')
}

function onDescribeTimeout(game) {
  if (game.state !== STATE.DESCRIBING) return

  if (game.tie?.phase === 'describing') {
    const tie = game.tie
    const currentUid = tie.candidates[tie.currentIdx]
    const speaker = game.players.find(p => p.userId === currentUid)
    if (speaker) {
      game.messages.push({
        type: 'system',
        content: `加赛：${speaker.order}号 ${speaker.nickname} 描述超时，自动跳过`,
        round: game.round,
      })
    }
    tie.currentIdx++
    if (tie.currentIdx < tie.candidates.length) {
      const next = game.players.find(p => p.userId === tie.candidates[tie.currentIdx])
      game.currentOrder = next.order
      scheduleDescribeTimeout(game)
    } else {
      enterTieVoting(game)
    }
    notify(game, 'describe-timeout')
    return
  }

  const alive = game.players.filter(p => p.alive).sort((a, b) => a.order - b.order)
  const speaker = alive.find(p => p.order === game.currentOrder) || alive[0]
  if (!speaker) return
  game.messages.push({
    type: 'system',
    content: `${speaker.order}号 ${speaker.nickname} 描述超时，自动跳过`,
    round: game.round,
  })
  const next = findNextSpeaker(game, speaker.order)
  if (next) {
    game.currentOrder = next.order
    scheduleDescribeTimeout(game)
  } else {
    enterVoting(game)
  }
  notify(game, 'describe-timeout')
}

function onVoteTimeout(game) {
  if (game.state !== STATE.VOTING) return

  if (game.tie?.phase === 'voting') {
    const tie = game.tie
    const alive = game.players.filter(p => p.alive)
    const voted = new Set([...Object.values(tie.votes).flat(), ...tie.abstain].map(String))
    for (const p of alive) {
      if (!voted.has(String(p.userId))) {
        tie.abstain.push(String(p.userId))
        pushVoteMsg(game, p, null, { abstain: true, auto: true })
      }
    }
    game.messages.push({
      type: 'system',
      content: `加赛投票超时，未投玩家自动弃权`,
      round: game.round,
    })
    settleTie(game)
    notify(game, 'vote-timeout')
    return
  }

  const alive = game.players.filter(p => p.alive)
  const voted = new Set([...Object.values(game.votes).flat(), ...game.abstain].map(String))
  for (const p of alive) {
    if (!voted.has(String(p.userId))) {
      game.abstain.push(String(p.userId))
      pushVoteMsg(game, p, null, { abstain: true, auto: true })
    }
  }
  game.messages.push({
    type: 'system',
    content: `投票时间到，未投玩家自动弃权`,
    round: game.round,
  })
  settle(game)
  notify(game, 'vote-timeout')
}

function enterVoting(game) {
  game.state = STATE.VOTING
  game.votes = {}
  game.abstain = []
  game.messages.push({
    type: 'system',
    content: `全员描述完毕，进入投票阶段，请存活玩家 #投票 N号`,
    round: game.round,
  })
  scheduleVoteTimeout(game)
}

function pushVoteMsg(game, voter, target, { abstain: isAbstain = false, auto = false } = {}) {
  game.messages = game.messages.filter(
    m => !(m.type === 'vote' && String(m.voterId) === String(voter.userId) && m.round === game.round),
  )
  game.messages.push({
    type: 'vote',
    voterId: voter.userId,
    voterOrder: voter.order,
    voterNick: voter.nickname,
    voterAvatar: voter.avatar,
    targetOrder: target?.order || null,
    targetNick: target?.nickname || null,
    abstain: isAbstain,
    auto,
    round: game.round,
  })
}

// ======== PK 加赛 ========

function enterTieBreak(game, candidateUids) {
  const tieds = candidateUids
    .map(uid => game.players.find(p => p.userId === uid))
    .filter(p => p && p.alive)
    .sort((a, b) => a.order - b.order)

  if (tieds.length === 0) return nextRound(game, null)

  game.tie = {
    candidates: tieds.map(p => p.userId),
    currentIdx: 0,
    phase: 'describing',
    votes: {},
    abstain: [],
  }
  game.state = STATE.DESCRIBING
  game.currentOrder = tieds[0].order

  const names = tieds.map(p => `${p.order}号 ${p.nickname}`).join('、')
  game.messages.push({
    type: 'system',
    content: `${names} 得票相同，进入加赛`,
    round: game.round,
  })
  game.messages.push({
    type: 'system',
    content: `加赛描述：请 ${tieds[0].order}号 再描述一次`,
    round: game.round,
  })

  scheduleDescribeTimeout(game)
  return { ok: true, game, tieBreak: true }
}

function describeTie(game, userId, content) {
  const tie = game.tie
  const currentUid = tie.candidates[tie.currentIdx]
  const speaker = game.players.find(p => p.userId === currentUid)

  if (!speaker || speaker.userId != userId) {
    const who = speaker ? `${speaker.order}号(${speaker.nickname})` : '无'
    return { error: `加赛中，当前应该 ${who} 描述` }
  }

  if (content.includes(speaker.word)) return { error: '不能直接说出你的词' }

  game.messages.push({
    type: 'describe',
    userId: speaker.userId,
    nickname: speaker.nickname,
    avatar: speaker.avatar,
    order: speaker.order,
    content,
    round: game.round,
    tie: true,
  })

  tie.currentIdx++
  if (tie.currentIdx < tie.candidates.length) {
    const next = game.players.find(p => p.userId === tie.candidates[tie.currentIdx])
    game.currentOrder = next.order
    scheduleDescribeTimeout(game)
    return { ok: true, game, tieNext: next }
  }

  enterTieVoting(game)
  return { ok: true, game, tieVoting: true }
}

function enterTieVoting(game) {
  game.tie.phase = 'voting'
  game.tie.votes = {}
  game.tie.abstain = []
  game.state = STATE.VOTING
  const options = game.tie.candidates
    .map(uid => game.players.find(p => p.userId === uid))
    .filter(Boolean)
    .sort((a, b) => a.order - b.order)
    .map(p => `${p.order}号`)
    .join('/')
  game.messages.push({
    type: 'system',
    content: `加赛投票：请存活玩家投 ${options}`,
    round: game.round,
  })
  scheduleVoteTimeout(game)
}

function voteTie(game, userId, targetOrder) {
  const tie = game.tie
  const voter = game.players.find(p => p.userId == userId)
  if (!voter) return { error: '你不在本局游戏中' }
  if (!voter.alive) return { error: '你已出局，无法投票' }

  const target = game.players.find(p => p.order === Number(targetOrder) && p.alive)
  if (!target) return { error: `${targetOrder} 号不存在或已出局` }
  if (!tie.candidates.includes(target.userId)) {
    const options = tie.candidates
      .map(uid => game.players.find(p => p.userId === uid))
      .filter(Boolean)
      .sort((a, b) => a.order - b.order)
      .map(p => `${p.order}号`)
      .join('/')
    return { error: `加赛只能投 ${options}` }
  }
  if (target.userId == userId) return { error: '不能投自己' }

  for (const k of Object.keys(tie.votes))
    tie.votes[k] = tie.votes[k].filter(v => v != userId)
  const idx = tie.abstain.indexOf(String(userId))
  if (idx >= 0) tie.abstain.splice(idx, 1)

  tie.votes[target.userId] = tie.votes[target.userId] || []
  tie.votes[target.userId].push(String(userId))

  pushVoteMsg(game, voter, target)

  return checkTieVoteComplete(game, voter, target)
}

function abstainTie(game, userId) {
  const tie = game.tie
  const voter = game.players.find(p => p.userId == userId)
  if (!voter || !voter.alive) return { error: '你不在本局或已出局' }

  for (const k of Object.keys(tie.votes))
    tie.votes[k] = tie.votes[k].filter(v => v != userId)
  if (!tie.abstain.includes(String(userId))) tie.abstain.push(String(userId))

  pushVoteMsg(game, voter, null, { abstain: true })

  return checkTieVoteComplete(game, voter, null)
}

function checkTieVoteComplete(game, voter, target) {
  const tie = game.tie
  const alive = game.players.filter(p => p.alive)
  const totalVoted =
    Object.values(tie.votes).reduce((s, arr) => s + arr.length, 0) + tie.abstain.length
  if (totalVoted < alive.length) {
    return { ok: true, game, voted: { voter, target } }
  }
  clearTimer(game)
  return settleTie(game)
}

function settleTie(game) {
  const tie = game.tie
  let maxVotes = 0
  let candidates = []
  for (const [uid, voters] of Object.entries(tie.votes)) {
    if (voters.length > maxVotes) {
      maxVotes = voters.length
      candidates = [uid]
    } else if (voters.length === maxVotes && maxVotes > 0) {
      candidates.push(uid)
    }
  }

  game.tie = null

  if (candidates.length === 1 && maxVotes > 0) {
    const outUid = candidates[0]
    const out = game.players.find(p => p.userId === outUid)
    out.alive = false

    game.messages.push({
      type: 'out',
      userId: out.userId,
      nickname: out.nickname,
      avatar: out.avatar,
      order: out.order,
      content: `${out.order}号 ${out.nickname} 加赛后被投出局`,
      round: game.round,
      tie: true,
    })

    const winner = checkWinner(game)
    if (winner) {
      clearTimer(game)
      game.state = STATE.ENDED
      game.winner = winner
      game.messages.push({
        type: 'system',
        content: winner === ROLE.UNDERCOVER ? '卧底成功，游戏结束' : '平民胜利，游戏结束',
        round: game.round,
      })
      return { ok: true, game, ended: true, out, winner }
    }
    return nextRound(game, out)
  }

  game.messages.push({
    type: 'system',
    content: `加赛仍平票，本轮无人出局`,
    round: game.round,
  })
  return nextRound(game, null)
}

// ======== 常规流程 ========

export function getGame(groupId) {
  return games[groupId]
}

export function createGame(groupId, initiatorId, nickname) {
  if (games[groupId] && games[groupId].state !== STATE.ENDED)
    return { error: '本群已有游戏进行中，请先 #结束卧底' }
  if (games[groupId]) clearTimer(games[groupId])
  const gameCfg = Config.get().game || {}
  games[groupId] = {
    groupId,
    state: STATE.WAITING,
    round: 0,
    initiator: initiatorId,
    players: [],
    messages: [],
    currentOrder: 0,
    votes: {},
    abstain: [],
    config: {
      undercoverCount: 1,
      minPlayers: gameCfg.minPlayers ?? 4,
      maxPlayers: gameCfg.maxPlayers ?? 12,
    },
    wordPair: null,
    winner: null,
    tie: null,
    createdAt: Date.now(),
  }
  const r = addPlayer(groupId, initiatorId, nickname)
  if (r.ok) scheduleWaitTimeout(games[groupId])
  return r
}

export function addPlayer(groupId, userId, nickname) {
  const game = games[groupId]
  if (!game) return { error: '本群还未发起游戏，请先 #谁是卧底' }
  if (game.state !== STATE.WAITING) return { error: '游戏已开始，无法加入' }
  if (game.players.find(p => p.userId == userId)) return { error: '你已经在游戏中' }
  if (game.players.length >= game.config.maxPlayers)
    return { error: `人数已达上限 ${game.config.maxPlayers} 人` }
  game.players.push({
    userId: String(userId),
    nickname: nickname || String(userId),
    avatar: `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=100`,
    role: null,
    word: null,
    alive: true,
    order: 0,
  })
  return { ok: true, game }
}

export function removePlayer(groupId, userId) {
  const game = games[groupId]
  if (!game) return { error: '本群还未发起游戏' }
  if (game.state !== STATE.WAITING) return { error: '游戏已开始，无法退出' }
  const idx = game.players.findIndex(p => p.userId == userId)
  if (idx < 0) return { error: '你不在游戏中' }
  game.players.splice(idx, 1)
  if (game.players.length === 0 || userId == game.initiator) {
    clearTimer(game)
    delete games[groupId]
    return { ok: true, dismissed: true }
  }
  return { ok: true, game }
}

export function endGame(groupId) {
  if (!games[groupId]) return { error: '本群没有进行中的游戏' }
  clearTimer(games[groupId])
  delete games[groupId]
  return { ok: true }
}

export function startGame(groupId, operatorId, pair) {
  const game = games[groupId]
  if (!game) return { error: '本群还未发起游戏' }
  if (game.state !== STATE.WAITING) return { error: '游戏已开始' }
  if (operatorId != game.initiator) return { error: '只有发起人可以开始游戏' }
  if (game.players.length < game.config.minPlayers)
    return { error: `人数不足，至少需要 ${game.config.minPlayers} 人` }
  if (!pair?.civilian || !pair?.undercover) return { error: '词对无效' }
  game.wordPair = pair

  const n = game.players.length
  const undercoverCount = Math.max(1, Math.floor(n / 4))
  game.config.undercoverCount = undercoverCount

  const indices = [...Array(n).keys()]
  shuffle(indices)
  const undercoverSet = new Set(indices.slice(0, undercoverCount))

  shuffle(game.players)
  game.players.forEach((p, i) => {
    p.order = i + 1
    if (undercoverSet.has(i)) {
      p.role = ROLE.UNDERCOVER
      p.word = pair.undercover
    } else {
      p.role = ROLE.CIVILIAN
      p.word = pair.civilian
    }
  })

  game.state = STATE.DESCRIBING
  game.round = 1
  game.currentOrder = 1
  game.messages = []
  game.tie = null
  game.messages.push({
    type: 'system',
    content: `第 ${game.round} 轮描述开始，共 ${n} 人，其中 ${undercoverCount} 名卧底`,
    round: game.round,
  })
  scheduleDescribeTimeout(game)
  return { ok: true, game }
}

export function describe(groupId, userId, content) {
  const game = games[groupId]
  if (!game) return { error: '本群没有进行中的游戏' }
  if (game.state !== STATE.DESCRIBING) return { error: '当前不是描述阶段' }

  if (game.tie?.phase === 'describing') return describeTie(game, userId, content)

  const aliveByOrder = game.players.filter(p => p.alive).sort((a, b) => a.order - b.order)
  const speaker = aliveByOrder.find(p => p.order === game.currentOrder) || aliveByOrder[0]

  if (!speaker || speaker.userId != userId) {
    const who = speaker ? `${speaker.order}号(${speaker.nickname})` : '无'
    return { error: `还没轮到你，当前应该 ${who} 描述` }
  }

  if (content.includes(speaker.word)) return { error: '不能直接说出你的词' }

  game.messages.push({
    type: 'describe',
    userId: speaker.userId,
    nickname: speaker.nickname,
    avatar: speaker.avatar,
    order: speaker.order,
    content,
    round: game.round,
  })

  const nextSpeaker = findNextSpeaker(game, speaker.order)
  if (nextSpeaker) {
    game.currentOrder = nextSpeaker.order
    scheduleDescribeTimeout(game)
    return { ok: true, game, next: nextSpeaker }
  }

  enterVoting(game)
  return { ok: true, game, voting: true }
}

function findNextSpeaker(game, currentOrder) {
  const aliveByOrder = game.players.filter(p => p.alive).sort((a, b) => a.order - b.order)
  return aliveByOrder.find(p => p.order > currentOrder) || null
}

export function vote(groupId, userId, targetOrder) {
  const game = games[groupId]
  if (!game) return { error: '本群没有进行中的游戏' }
  if (game.state !== STATE.VOTING) return { error: '当前不是投票阶段' }

  if (game.tie?.phase === 'voting') return voteTie(game, userId, targetOrder)

  const voter = game.players.find(p => p.userId == userId)
  if (!voter) return { error: '你不在本局游戏中' }
  if (!voter.alive) return { error: '你已出局，无法投票' }

  const target = game.players.find(p => p.order === Number(targetOrder) && p.alive)
  if (!target) return { error: `${targetOrder} 号不存在或已出局` }
  if (target.userId == userId) return { error: '不能投自己' }

  for (const k of Object.keys(game.votes))
    game.votes[k] = game.votes[k].filter(v => v != userId)
  const idx = game.abstain.indexOf(String(userId))
  if (idx >= 0) game.abstain.splice(idx, 1)

  game.votes[target.userId] = game.votes[target.userId] || []
  game.votes[target.userId].push(String(userId))

  pushVoteMsg(game, voter, target)

  return checkVoteComplete(game, voter, target)
}

export function abstain(groupId, userId) {
  const game = games[groupId]
  if (!game) return { error: '本群没有进行中的游戏' }
  if (game.state !== STATE.VOTING) return { error: '当前不是投票阶段' }

  if (game.tie?.phase === 'voting') return abstainTie(game, userId)

  const voter = game.players.find(p => p.userId == userId)
  if (!voter || !voter.alive) return { error: '你不在本局或已出局' }

  for (const k of Object.keys(game.votes))
    game.votes[k] = game.votes[k].filter(v => v != userId)
  if (!game.abstain.includes(String(userId))) game.abstain.push(String(userId))

  pushVoteMsg(game, voter, null, { abstain: true })

  return checkVoteComplete(game, voter, null)
}

function checkVoteComplete(game, voter, target) {
  const alive = game.players.filter(p => p.alive)
  const totalVoted =
    Object.values(game.votes).reduce((s, arr) => s + arr.length, 0) + game.abstain.length
  if (totalVoted < alive.length) {
    return { ok: true, game, voted: { voter, target } }
  }
  clearTimer(game)
  return settle(game)
}

function settle(game) {
  let maxVotes = 0
  let candidates = []
  for (const [uid, voters] of Object.entries(game.votes)) {
    if (voters.length > maxVotes) {
      maxVotes = voters.length
      candidates = [uid]
    } else if (voters.length === maxVotes && maxVotes > 0) {
      candidates.push(uid)
    }
  }

  const minVotes = Math.max(1, Number(Config.get().game?.minVotesToEliminate ?? 2))
  if (maxVotes < minVotes || candidates.length === 0) {
    game.messages.push({
      type: 'system',
      content:
        maxVotes === 0
          ? `本轮无人得票，无人出局`
          : `最高得票 ${maxVotes} 票未达 ${minVotes} 票门槛，本轮无人出局`,
      round: game.round,
    })
    return nextRound(game, null)
  }

  if (candidates.length > 1) {
    return enterTieBreak(game, candidates)
  }

  const outUid = candidates[0]
  const out = game.players.find(p => p.userId === outUid)
  out.alive = false

  game.messages.push({
    type: 'out',
    userId: out.userId,
    nickname: out.nickname,
    avatar: out.avatar,
    order: out.order,
    content: `${out.order}号 ${out.nickname} 被投出局`,
    round: game.round,
    tie: false,
  })

  const winner = checkWinner(game)
  if (winner) {
    clearTimer(game)
    game.state = STATE.ENDED
    game.winner = winner
    game.messages.push({
      type: 'system',
      content: winner === ROLE.UNDERCOVER ? '卧底成功，游戏结束' : '平民胜利，游戏结束',
      round: game.round,
    })
    return { ok: true, game, ended: true, out, winner }
  }

  return nextRound(game, out)
}

function nextRound(game, outPlayer) {
  game.round += 1
  game.state = STATE.DESCRIBING
  game.votes = {}
  game.abstain = []
  game.tie = null
  const aliveByOrder = game.players.filter(p => p.alive).sort((a, b) => a.order - b.order)
  if (!aliveByOrder.length) {
    clearTimer(game)
    game.state = STATE.ENDED
    return { ok: true, game, ended: true, out: outPlayer }
  }
  game.currentOrder = aliveByOrder[0].order
  game.messages.push({
    type: 'system',
    content: `第 ${game.round} 轮描述开始，请 ${aliveByOrder[0].order}号 先发言`,
    round: game.round,
  })
  scheduleDescribeTimeout(game)
  return { ok: true, game, out: outPlayer, nextRound: true }
}

function checkWinner(game) {
  const aliveCivilian = game.players.filter(p => p.alive && p.role === ROLE.CIVILIAN).length
  const aliveUndercover = game.players.filter(p => p.alive && p.role === ROLE.UNDERCOVER).length
  if (aliveUndercover === 0) return ROLE.CIVILIAN
  if (aliveUndercover >= aliveCivilian) return ROLE.UNDERCOVER
  return null
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}
