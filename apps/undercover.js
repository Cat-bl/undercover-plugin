import plugin from '../../../lib/plugins/plugin.js'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import * as Game from '../model/game.js'
import { renderGame } from '../model/render.js'
import { pickWordPair } from '../model/ai.js'

export class Undercover extends plugin {
  constructor() {
    super({
      name: '谁是卧底',
      dsc: '谁是卧底游戏',
      event: 'message',
      priority: 500,
      rule: [
        { reg: /^#?(谁是卧底|发起卧底)$/, fnc: 'create' },
        { reg: /^#?加入卧底$/, fnc: 'join' },
        { reg: /^#?退出卧底$/, fnc: 'quit' },
        { reg: /^#?开始卧底(\s+.+)?$/, fnc: 'start' },
        { reg: /^#?结束卧底$/, fnc: 'end' },
        { reg: /^#?卧底状态$/, fnc: 'status' },
        { reg: /^#?谁是卧底帮助$/, fnc: 'help' },
        { reg: /^#?描述\s*[\s\S]+$/, fnc: 'describe' },
        { reg: /^#?投票(\s|$|\d|[^#])/, fnc: 'vote' },
        { reg: /^#?弃权$/, fnc: 'abstain' },
      ],
    })
  }

  async create(e) {
    if (!e.isGroup) return e.reply('请在群聊中发起游戏', true)
    const nickname = e.sender?.card || e.sender?.nickname || String(e.user_id)
    const r = Game.createGame(e.group_id, String(e.user_id), nickname)
    if (r.error) return e.reply(r.error, true)
    await this.render(e, r.game)
    return true
  }

  async join(e) {
    if (!e.isGroup) return e.reply('请在群聊中加入游戏', true)
    const nickname = e.sender?.card || e.sender?.nickname || String(e.user_id)
    const r = Game.addPlayer(e.group_id, String(e.user_id), nickname)
    if (r.error) return e.reply(r.error, true)
    await this.render(e, r.game)
    return true
  }

  async quit(e) {
    if (!e.isGroup) return false
    const r = Game.removePlayer(e.group_id, String(e.user_id))
    if (r.error) return e.reply(r.error, true)
    if (r.dismissed) return e.reply('发起人退出，游戏已取消')
    await this.render(e, r.game)
    return true
  }

  async start(e) {
    if (!e.isGroup) return false
    const game = Game.getGame(e.group_id)
    if (!game) return e.reply('本群还未发起游戏', true)
    if (String(e.user_id) != game.initiator) return e.reply('只有发起人可以开始游戏', true)
    if (game.players.length < game.config.minPlayers)
      return e.reply(`人数不足，至少需要 ${game.config.minPlayers} 人`, true)

    let category = null
    const argMatch = e.msg.match(/^#?开始卧底\s+(.+)$/)
    if (argMatch) {
      const arg = argMatch[1].trim()
      if (arg && !isSkipWord(arg)) category = arg.slice(0, 30)
    }

    if (!category) {
      await e.reply(
        '请在 15 秒内回复词组类型/范围（如「二次元」「水果」「电影」）等任何类型都行，或回复「跳过」使用默认。\n期间请勿发送其他命令',
      )
      const reply = await this.awaitContext(false, 15)
      if (reply && reply !== false) {
        const msg = (reply.msg || '').trim()
        if (
          msg &&
          !msg.startsWith('#') &&
          !isSkipWord(msg) &&
          msg.length <= 30 &&
          String(reply.group_id) === String(e.group_id)
        ) {
          category = msg
        }
      }
    }

    await e.reply(
      `正在检查玩家私聊连通性${category ? `（类型：${category}）` : ''}...`,
    )
    const probeFailed = []
    for (const p of game.players) {
      try {
        await sendPrivate(
          p.userId,
          e.group_id,
          '【谁是卧底】连通性检测，稍后将私聊下发你的词语，请勿关闭此会话',
        )
      } catch (err) {
        logger?.error(`[谁是卧底] 连通检测失败 ${p.userId}:`, err?.message || err)
        probeFailed.push(p)
      }
    }
    if (probeFailed.length) {
      const names = probeFailed.map(p => `${p.nickname}(${p.userId})`).join('、')
      return e.reply(
        `以下玩家无法接收私聊消息：\n${names}\n\n请上述玩家添加机器人好友，或群内开启「临时会话」功能。\n房间已保留，解决后发起人再次 #开始卧底 即可；或 #结束卧底 取消。`,
        true,
      )
    }

    await e.reply(
      `连通检测通过，正在${category ? `以「${category}」类型` : ''}生成词对，大概需要 1 分钟，请稍后...`,
    )
    let pair
    try {
      pair = await pickWordPair(e.group_id, category)
    } catch (err) {
      logger?.error(`[谁是卧底] 选词失败`, err)
      return e.reply(`选词失败：${err?.message || err}\n房间已保留，可再次 #开始卧底`, true)
    }
    if (!pair) return e.reply('选词失败：词库为空且 AI 不可用\n房间已保留', true)

    const r = Game.startGame(e.group_id, String(e.user_id), pair)
    if (r.error) return e.reply(r.error, true)

    const failed = []
    for (const p of r.game.players) {
      try {
        await sendPrivate(
          p.userId,
          e.group_id,
          `【谁是卧底】\n你是 ${p.order} 号\n你的词是：${p.word}\n\n请回到群内，轮到你时发送 #描述 内容`,
        )
      } catch (err) {
        logger?.error(`[谁是卧底] 发词失败 ${p.userId}:`, err?.message || err)
        failed.push(p)
      }
    }

    if (failed.length) {
      Game.endGame(e.group_id)
      const names = failed.map(p => `${p.order}号 ${p.nickname}`).join('、')
      await e.reply(`发词失败：${names}\n游戏已取消`, true)
      return true
    }

    await e.reply('词语已私聊发送，游戏开始')
    await this.render(e, r.game)
    return true
  }

  async end(e) {
    if (!e.isGroup) return false
    const game = Game.getGame(e.group_id)
    if (!game) return e.reply('本群没有进行中的游戏', true)
    if (String(e.user_id) != game.initiator && !e.isMaster)
      return e.reply('只有发起人或主人可以强制结束', true)
    Game.endGame(e.group_id)
    return e.reply('游戏已结束')
  }

  async status(e) {
    if (!e.isGroup) return false
    const game = Game.getGame(e.group_id)
    if (!game) return e.reply('本群没有进行中的游戏', true)
    await this.render(e, game)
    return true
  }

  async describe(e) {
    if (!e.isGroup) return false
    const game = Game.getGame(e.group_id)
    if (!game) return false
    const content = buildContent(e).replace(/^#?描述\s*/, '').trim()
    if (!content) return e.reply('请输入描述内容，例如 #描述 很好喝', true)
    const r = Game.describe(e.group_id, String(e.user_id), content)
    if (r.error) return e.reply(r.error, true)
    await this.render(e, r.game)
    return true
  }

  async vote(e) {
    if (!e.isGroup) return false
    const game = Game.getGame(e.group_id)
    if (!game) return false

    let targetOrder = null
    const m = e.msg.match(/(\d+)/)
    if (m) targetOrder = Number(m[1])
    if (!targetOrder) {
      const atQq = extractAt(e)
      if (atQq) {
        const p = game.players.find(pp => pp.userId == String(atQq))
        if (p) targetOrder = p.order
      }
    }
    if (!targetOrder) return e.reply('请指定投票对象：#投票 N号 或 #投票 @某人', true)

    const r = Game.vote(e.group_id, String(e.user_id), targetOrder)
    if (r.error) return e.reply(r.error, true)
    await this.render(e, r.game)
    return true
  }

  async abstain(e) {
    if (!e.isGroup) return false
    const game = Game.getGame(e.group_id)
    if (!game) return false
    const r = Game.abstain(e.group_id, String(e.user_id))
    if (r.error) return e.reply(r.error, true)
    await this.render(e, r.game)
    return true
  }

  async help(e) {
    try {
      const img = await puppeteer.screenshot('undercover-plugin', {
        saveId: 'help',
        imgType: 'png',
        tplFile: './plugins/undercover-plugin/resources/html/help.html',
      })
      if (img) return e.reply(img)
      return e.reply('帮助图片渲染失败', true)
    } catch (err) {
      logger?.error(`[谁是卧底] 帮助渲染失败`, err)
      return e.reply('帮助图片渲染失败：' + (err?.message || err), true)
    }
  }

  async render(e, game) {
    try {
      const img = await renderGame(game)
      if (img) await e.reply(img)
    } catch (err) {
      logger?.error(`[谁是卧底] 渲染失败`, err)
      await e.reply('图片渲染失败：' + (err?.message || err), true)
    }
  }
}

Game.setExternalTick(async (game, type, extra) => {
  try {
    if (!game.groupId) return
    const g = Bot.pickGroup?.(game.groupId)
    if (!g?.sendMsg) return

    if (type === 'wait-timeout') {
      await g.sendMsg('等待超时，本局谁是卧底已自动结束。发 #谁是卧底 重新发起')
      return
    }

    if (type === 'describe-warn') {
      const alive = game.players.filter(p => p.alive).sort((a, b) => a.order - b.order)
      const speaker = alive.find(p => p.order === game.currentOrder)
      if (speaker) {
        await g.sendMsg([
          segment.at(speaker.userId),
          ` 还有 ${extra?.secondsLeft ?? 30} 秒描述，超时将自动跳过`,
        ])
      }
      return
    }

    if (type === 'vote-warn') {
      const alive = game.players.filter(p => p.alive)
      const isTieVote = game.tie?.phase === 'voting'
      const votes = isTieVote ? game.tie.votes : game.votes
      const abstainList = isTieVote ? game.tie.abstain : game.abstain
      const voted = new Set(
        [...Object.values(votes).flat(), ...abstainList].map(String),
      )
      const pending = alive.filter(p => !voted.has(String(p.userId)))
      if (pending.length) {
        const msg = []
        for (const p of pending) { msg.push(segment.at(p.userId), ' ') }
        const suffix = isTieVote ? '加赛投票' : '#投票 N号 或 #弃权'
        msg.push(`请在 ${extra?.secondsLeft ?? 30} 秒内${isTieVote ? '完成' : ''}${suffix}，超时自动弃权`)
        await g.sendMsg(msg)
      }
      return
    }

    const img = await renderGame(game)
    if (img) await g.sendMsg(img)
  } catch (err) {
    logger?.error(`[谁是卧底] 超时自动推进发送失败`, err)
  }
})

function extractAt(e) {
  if (!Array.isArray(e.message)) return null
  for (const seg of e.message) {
    if (seg.type === 'at' && String(seg.qq) != String(e.self_id)) return seg.qq
  }
  return null
}

async function sendPrivate(userId, groupId, msg) {
  const friend = Bot.pickFriend?.(userId)
  if (!friend) throw new Error('pickFriend 返回空')
  const bot = friend.bot
  const uidN = Number(userId)
  const isFriend = Boolean(bot?.fl?.has?.(uidN) || bot?.fl?.has?.(String(userId)))
  if (isFriend || !bot?.sendApi) {
    return await friend.sendMsg(msg)
  }
  return await bot.sendApi('send_private_msg', {
    user_id: uidN,
    group_id: Number(groupId),
    message: msg,
  })
}

function isSkipWord(s) {
  const lower = String(s).toLowerCase()
  return ['跳过', '默认', '不指定', 'skip', 'no', '无'].includes(lower)
}

function buildContent(e) {
  if (!Array.isArray(e.message)) return e.msg || ''
  let text = ''
  for (const seg of e.message) {
    if (seg.type === 'text') text += seg.text || ''
    else if (seg.type === 'at') text += seg.text || `@${seg.qq}`
  }
  return text || e.msg || ''
}
