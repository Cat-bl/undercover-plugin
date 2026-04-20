import { update as Update } from '../../other/update.js'

export class UndercoverUpdate extends plugin {
  constructor() {
    super({
      name: '谁是卧底更新',
      dsc: '#谁是卧底更新 #谁是卧底强制更新',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: /^#?谁是卧底(强制)?更新$/, fnc: 'update', permission: 'master' },
      ],
    })
  }

  async update(e = this.e) {
    e.isMaster = true
    e.msg = `#${e.msg.includes('强制') ? '强制' : ''}更新undercover-plugin`
    const up = new Update(e)
    up.e = e
    return up.update()
  }
}
