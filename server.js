/* 鬼邮局 · 静态站点 + 链接读取接口
   为什么需要这个小服务：浏览器有同源策略，网页无法直接抓取别的网站（CORS）。
   放在服务端抓就没有这个限制。只依赖 Node 内置模块，不需要 npm install。 */

const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const PORT = process.env.PORT || 3000
const ROOT = __dirname
const MAX_BYTES = 3 * 1024 * 1024      // 单页最多抓 3MB
const MAX_TEXT = 12000                  // 喂给 AI 的正文上限
const FETCH_TIMEOUT = 15000
/* 网关会把 sharecode 从转发请求里剥掉（它自己消耗掉做鉴权），
   所以清单里要用的访问码只能内置；换了分享码改这里即可。 */
const SHARE_CODE = process.env.SHARE_CODE || 'GT7GTQCHUK'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.ics': 'text/calendar; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive'
}

/* ---------------- 抓网页 ---------------- */
function isBlockedHost(host) {
  const h = String(host || '').toLowerCase()
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (h === '::1' || h === '[::1]') return true
  if (/^0\./.test(h)) return true
  return false
}

function fetchOnce(target, redirectsLeft, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(target) } catch (e) { return reject(new Error('链接格式不对')) }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('只支持 http/https 链接'))
    if (isBlockedHost(u.hostname)) return reject(new Error('这个地址不允许读取'))

    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: Object.assign({
        'User-Agent': o.ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br'
      }, o.referer ? { 'Referer': o.referer } : {}),
      timeout: FETCH_TIMEOUT
    }, (res) => {
      const status = res.statusCode || 0
      const loc = res.headers.location

      if (status >= 300 && status < 400 && loc && redirectsLeft > 0) {
        res.resume()
        let next
        try { next = new URL(loc, target).toString() } catch (e) { return reject(new Error('跳转地址无效')) }
        return resolve(fetchOnce(next, redirectsLeft - 1, o))
      }
      if (status >= 400) {
        res.resume()
        return reject(new Error('对方网站返回 ' + status))
      }

      let total = 0
      const chunks = []
      res.on('data', (c) => {
        total += c.length
        if (total > MAX_BYTES) { req.destroy(); return }
        chunks.push(c)
      })
      res.on('end', () => {
        let buf = Buffer.concat(chunks)
        const enc = String(res.headers['content-encoding'] || '').toLowerCase()
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf)
          else if (enc === 'deflate') buf = zlib.inflateSync(buf)
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf)
        } catch (e) { /* 解压失败就当没压缩 */ }
        resolve({
          status: status,
          finalUrl: target,
          contentType: String(res.headers['content-type'] || ''),
          text: buf.toString('utf8')
        })
      })
      res.on('error', reject)
    })

    req.on('timeout', () => { req.destroy(); reject(new Error('对方网站没响应')) })
    req.on('error', (e) => reject(new Error('连不上对方网站（' + e.code + '）')))
    req.end()
  })
}

/* 抓二进制（封面图/视频海报） */
function fetchBinary(target, maxBytes, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(target) } catch (e) { return reject(new Error('图片地址无效')) }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('协议不支持'))
    if (isBlockedHost(u.hostname)) return reject(new Error('地址不允许'))

    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/*,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': u.origin + '/'
      },
      timeout: 12000
    }, (res) => {
      const st = res.statusCode || 0
      if (st >= 300 && st < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume()
        let next
        try { next = new URL(res.headers.location, target).toString() } catch (e) { return reject(new Error('封面跳转无效')) }
        return resolve(fetchBinary(next, maxBytes, redirectsLeft - 1))
      }
      if (st >= 400) { res.resume(); return reject(new Error('封面 HTTP ' + st)) }

      const chunks = []
      let total = 0
      res.on('data', (c) => {
        total += c.length
        if (total > maxBytes) { req.destroy(); return reject(new Error('封面太大')) }
        chunks.push(c)
      })
      res.on('end', () => {
        let buf = Buffer.concat(chunks)
        const enc = String(res.headers['content-encoding'] || '').toLowerCase()
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf)
          else if (enc === 'deflate') buf = zlib.inflateSync(buf)
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf)
        } catch (e) {}
        resolve({ buffer: buf, contentType: String(res.headers['content-type'] || '') })
      })
      res.on('error', reject)
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('封面超时')) })
    req.on('error', reject)
    req.end()
  })
}

/* ---------------- 正文提取 ---------------- */
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => safeChar(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—').replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
    .replace(/&amp;/g, '&')
}
function safeChar(code) {
  try { return String.fromCodePoint(code) } catch (e) { return '' }
}

function pick(html, re) {
  const m = String(html).match(re)
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : ''
}

function htmlToText(html) {
  let s = String(html || '')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, ' ')

  // 有 article 就优先取 article，通常正好是正文
  const art = s.match(/<article[\s\S]*?<\/article>/i)
  if (art && art[0].length > 600) s = art[0]

  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|td)>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s.replace(/[ \t\u00a0\u3000]+/g, ' ')
  s = s.replace(/\n[ \t]*/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

const VIDEO_HOSTS = ['bilibili.com', 'douyin.com', 'iesdouyin.com', 'kuaishou.com', 'youtube.com',
  'youtu.be', 'v.qq.com', 'ixigua.com', 'weibo.com', 'xiaohongshu.com', 'xhslink.com',
  'mp.weixin.qq.com', 'tiktok.com', 'vimeo.com']

/* 直链文件用文件名当标题，比整条 URL 好看 */
function fileNameOf(target) {
  try {
    const u = new URL(target)
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '')
    return last || ''
  } catch (e) { return '' }
}

function looksLikeVideoHost(host) {
  return VIDEO_HOSTS.some((h) => host === h || host.endsWith('.' + h))
}

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/* 视频站普遍有反爬：桌面 UA 被 412/403 挡下来时，换移动端 UA + Referer 再试一次 */
function loadPage(target, host) {
  const isVideoHost = looksLikeVideoHost(host)
  return fetchOnce(target, 5).catch((err) => {
    if (!isVideoHost) throw err
    if (!/4\d\d|403|412|401|超时/.test(String(err && err.message))) throw err
    let ref = ''
    try { ref = new URL(target).origin + '/' } catch (e) {}
    return fetchOnce(target, 5, { ua: MOBILE_UA, referer: ref })
  })
}

function handleLink(reqUrl, res) {
  let target = ''
  try {
    const u = new URL(reqUrl, 'http://localhost')
    target = u.searchParams.get('url') || ''
  } catch (e) {}

  target = String(target).trim()
  // 用户可能没带协议
  if (target && !/^https?:\/\//i.test(target)) target = 'https://' + target

  if (!target) return sendJSON(res, 400, { ok: false, error: '缺少 url 参数' })
  if (target.length > 2000) return sendJSON(res, 400, { ok: false, error: '链接太长了' })

  let hostEarly = ''
  try { hostEarly = new URL(target).hostname.replace(/^www\./, '') } catch (e) {}

  loadPage(target, hostEarly).then((r) => {
    const isHtml = /html|xml/i.test(r.contentType) || /^\s*</.test(r.text.slice(0, 200))
    const meta = (prop) => pick(r.text, new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)["\']', 'i'))

    const title = isHtml ? (meta('og:title') || pick(r.text, /<title[^>]*>([\s\S]*?)<\/title>/i)) : ''
    const desc = isHtml ? (meta('og:description') || meta('description')) : ''
    const ogType = isHtml ? meta('og:type').toLowerCase() : ''
    const ogImage = isHtml ? meta('og:image') : ''
    const ogVideo = isHtml ? (meta('og:video:url') || meta('og:video') || meta('og:video:secure_url')) : ''
    const siteName = isHtml ? meta('og:site_name') : ''

    // 非文本内容（视频/图片/二进制）不要把字节当正文，否则会变成乱码
    const textish = /text|json|xml|javascript/i.test(r.contentType)
    let text = isHtml ? htmlToText(r.text)
      : (textish ? String(r.text || '').trim() : '')
    text = text.replace(/\n{3,}/g, '\n\n')

    // 视频站：og:type 是 video.*，或者域名在名单里，或者页面给了 og:video
    const host = hostEarly
    const isVideoPage = /^video/.test(ogType) || !!ogVideo || looksLikeVideoHost(host)
    const directVideo = /\.(mp4|mov|m4v|webm|flv|m3u8)(\?|$)/i.test(target)

    const thin = text.length < 120
    const truncated = text.length > MAX_TEXT
    if (truncated) text = text.slice(0, MAX_TEXT)

    const payload = {
      ok: true,
      url: target,
      title: title || fileNameOf(target) || target,
      desc: desc,
      text: text,
      thin: thin,
      truncated: truncated,
      chars: text.length,
      host: host,
      siteName: siteName,
      ogType: ogType,
      isVideo: isVideoPage || directVideo,
      videoUrl: directVideo ? target : (/\.(mp4|m3u8)(\?|$)/i.test(ogVideo) ? ogVideo : ''),
      cover: ogImage || ''
    }

    // 封面图取回来转 base64，前端才能绕过跨域直接喂给模型
    const coverAbs = ogImage
      ? (() => { try { return new URL(ogImage, target).toString() } catch (e) { return '' } })()
      : ''

    if (!coverAbs) return sendJSON(res, 200, payload)

    fetchBinary(coverAbs, 350 * 1024, 3).then((img) => {
      if (img && img.buffer && /^image\//i.test(img.contentType)) {
        payload.coverData = 'data:' + img.contentType.split(';')[0] + ';base64,' + img.buffer.toString('base64')
      }
      sendJSON(res, 200, payload)
    }).catch(() => sendJSON(res, 200, payload))
  }).catch((e) => {
    sendJSON(res, 200, { ok: false, error: (e && e.message) || '读取失败', url: target })
  })
}

function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

/* ---------------- 清单文件（分享目标要带上访问码）---------------- */
/* 这套部署的网关要求所有资源都带 sharecode，而 manifest 里的图标是绝对路径，
   浏览器不会自动带参数，所以这里按当前请求的 sharecode 现拼一份。 */
function serveManifest(reqUrl, res) {
  let code = ''
  let all = null
  try {
    all = new URL(reqUrl, 'http://localhost')
    code = all.searchParams.get('sharecode') || all.searchParams.get('code') || SHARE_CODE
  } catch (e) {}
  const q = code ? '?sharecode=' + encodeURIComponent(code) : ''

  fs.readFile(path.join(ROOT, 'manifest.json'), 'utf8', (err, raw) => {
    if (err) { res.writeHead(404); return res.end('no manifest') }
    let m
    try { m = JSON.parse(raw) } catch (e) { res.writeHead(500); return res.end('bad manifest') }

    // 图标改成带访问码的绝对路径
    if (code && Array.isArray(m.icons)) {
      m.icons = m.icons.map((ic) => ({
        src: '/' + String(ic.src).replace(/^\.?\//, '') + q,
        sizes: ic.sizes,
        type: ic.type,
        purpose: ic.purpose
      }))
    }
    // 长按图标弹出的快捷方式也要能用
    if (code && Array.isArray(m.shortcuts)) {
      m.shortcuts = m.shortcuts.map((s) => {
        const u = Object.assign({}, s)
        u.url = String(s.url).replace(/^\.\//, '/') + '&sharecode=' + encodeURIComponent(code)
        if (Array.isArray(s.icons)) {
          u.icons = s.icons.map((ic) => ({
            src: '/' + String(ic.src).replace(/^\.?\//, '') + q,
            sizes: ic.sizes
          }))
        }
        return u
      })
    }
    // 启动地址和分享目标也带上
    if (code) {
      m.start_url = '/index.html' + q
      m.scope = '/'
      if (m.share_target) m.share_target.action = '/index.html?share=1&sharecode=' + encodeURIComponent(code)
    }

    if (all && all.searchParams.get('dbg') === '1') {
      m._debug = { incoming: reqUrl, code: code, search: (all && all.search) || '' }
    }

    const body = Buffer.from(JSON.stringify(m, null, 2), 'utf8')
    res.writeHead(200, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache'
    })
    res.end(body)
  })
}

/* ---------------- 静态文件 ---------------- */
function serveStatic(reqUrl, res) {
  let p
  try {
    const u = new URL(reqUrl, 'http://localhost')
    p = decodeURIComponent(u.pathname)
  } catch (e) {
    res.writeHead(400); return res.end('bad request')
  }
  if (p === '/' || p === '') p = '/index.html'

  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''))
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden') }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('404 没有这个文件')
    }
    const ext = path.extname(file).toLowerCase()

    // 页面里的 js/css 自动带上版本号，避免「新页面配旧脚本」
    if (ext === '.html') {
      fs.readFile(file, 'utf8', (e2, text) => {
        if (e2) { res.writeHead(500); return res.end('read error') }
        const v = Math.floor(st.mtimeMs).toString(36)
        const out = text
          .replace(/(assets\/[a-zA-Z0-9._-]+\.(?:js|css))(["'])/g, '$1?v=' + v + '$2')
          .replace(/__BUILD__/g, v)
        const buf = Buffer.from(out, 'utf8')
        res.writeHead(200, {
          'Content-Type': MIME[ext],
          'Content-Length': buf.length,
          'Cache-Control': 'no-cache'
        })
        res.end(buf)
      })
      return
    }

    const revalidate = ext === '.js' || ext === '.css' || ext === '.json' || ext === '.webmanifest'
    const head = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=86400'
    }
    // 安装包要触发下载，别在浏览器里当页面打开
    if (ext === '.apk') head['Content-Disposition'] = 'attachment; filename="guiji-1.6.apk"'
    res.writeHead(200, head)
    fs.createReadStream(file).pipe(res)
  })
}

/* ---------------- 启动 ---------------- */

/* ---------------- 应用内更新 ---------------- */
/* 发新版只要改这一段：文件名、版本号、更新说明 */
const APP_RELEASE = {
  versionCode: 7,
  versionName: '1.6',
  file: 'download/guiji-1.6.apk',
  notes: [
    '加日历修好了：一键直接写进手机日历，不用再导文件',
    '修复点「加日历」和点行没反应的问题',
    '返回手势改成右滑（任何位置都能滑）'
  ],
  minSupported: 0
}

function handleAppVersion(reqUrl, res) {
  let size = 0
  try { size = fs.statSync(path.join(ROOT, APP_RELEASE.file)).size } catch (e) {}

  sendJSON(res, 200, {
    ok: true,
    latest: {
      versionCode: APP_RELEASE.versionCode,
      versionName: APP_RELEASE.versionName,
      size: size,
      url: '/' + APP_RELEASE.file,
      notes: APP_RELEASE.notes
    },
    minSupported: APP_RELEASE.minSupported
  })
}

const server = http.createServer((req, res) => {
  const u = req.url || '/'

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    })
    return res.end()
  }

  if (u.indexOf('/api/app-version') === 0) return handleAppVersion(u, res)
  if (u.indexOf('/api/link') === 0) return handleLink(u, res)
  if (u.indexOf('/api/health') === 0) return sendJSON(res, 200, { ok: true, ts: Date.now() })
  // 网关对静态扩展名的请求可能不转发查询串，所以动态清单走 /api/ 前缀
  if (u.indexOf('/api/manifest') === 0) return serveManifest(u, res)
  if (u.indexOf('/manifest.json') === 0) return serveManifest(u, res)

  serveStatic(u, res)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log('鬼邮局 on ' + PORT)
})
