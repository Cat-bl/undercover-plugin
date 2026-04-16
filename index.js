import fs from 'node:fs'
import './model/config.js'

logger.info(logger.blue('谁是卧底插件开始加载~~'))

if (!global.segment) {
  global.segment = (await import('oicq')).segment
}

const files = fs
  .readdirSync('./plugins/undercover-plugin/apps')
  .filter(file => file.endsWith('.js'))

let ret = []
files.forEach(file => {
  ret.push(import(`./apps/${file}`))
})

ret = await Promise.allSettled(ret)

let apps = {}
for (let i in files) {
  const name = files[i].replace('.js', '')
  if (ret[i].status !== 'fulfilled') {
    logger.error(`载入插件错误：${logger.red(name)}`)
    logger.error(ret[i].reason)
    continue
  }
  const mod = ret[i].value
  const plugin = mod[Object.keys(mod)[0]]
  apps[name] = plugin
}

export { apps }

logger.info(logger.blue('谁是卧底插件加载完成~~'))
