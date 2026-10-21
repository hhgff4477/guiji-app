/* 鬼邮局 · 网页版
 * 设计原则：任何外部依赖（AI / CDN / 网络）挂掉，页面都必须能正常用。
 * AI 不可用时降级为本地规则提取，用户至少能看到摘要、金额、日期、待办。
 */
(function () {
  'use strict';

  /* ---------------- 配置 ---------------- */
  var CLOUD = {
    endpoint: 'https://mp-api.app.workbuddy.host',
    publishableKey: 'wbpk_7khlV28Uqnk2LMjWXiI90U_FGpB0XAcbaDN2H9tZ7luBbgN7qej6gZ4'
  };
  var STORE_KEY = 'guiji-v1';

  /* ---------------- 状态 ---------------- */
  var DEFAULT_SETTINGS = {
    remindEnabled: true,
    remindAt: '07:30',
    lastRemindedOn: '',
    morningDismissedOn: '',
    clipDismissed: '',
    installDismissed: '',
    swipeBack: true,
    swipeTabs: true,
    autoUpdate: true,
    updateSkip: 0,
    importantAt: '09:30'
  };

  var db = {
    items: [],
    todos: [],
    reminders: [],
    reports: [],
    settings: {
      remindEnabled: true,
      remindAt: '07:30',
      lastRemindedOn: '',
      morningDismissedOn: '',
      clipDismissed: '',
      installDismissed: '',
      swipeBack: true,
      swipeTabs: true,
      autoUpdate: true,
      updateSkip: 0,
      importantAt: '09:30'
    },
    alarms: [],
    once: {}          // 重要任务的一次性闹钟登记，跟 alarms 分开
  };

  var ui = {
    tab: 'home',
    libFilter: 'all',
    todoFilter: 'all',
    currentItem: null,
    currentReport: null,
    busy: false,
    cloud: null,
    aiState: '未检测',
    morning: null,
    clipUrl: '',
    installPrompt: null,
    editingAlarm: null,
    screen: 'home',
    doneExpanded: false,        // 已完成那组是不是展开了
    openRow: null,              // 当前左滑打开着的那一行
    select: { on: false, ids: {} },   // 长按多选
    update: {
      state: 'idle',   // idle|checking|available|downloading|downloaded|installing|failed|latest
      latest: null,
      progress: 0,
      error: '',
      path: ''
    }
  };

  /* ---------------- 工具 ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function todayStr(d) {
    var x = d || new Date();
    return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
  }
  function parseDate(v) {
    if (!v) return null;
    var p = String(v).slice(0, 10).split('-');
    if (p.length !== 3) return null;
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return isNaN(d.getTime()) ? null : d;
  }
  function dayDiff(v) {
    var t = parseDate(v);
    if (!t) return null;
    var base = parseDate(todayStr());
    return Math.round((t.getTime() - base.getTime()) / 86400000);
  }
  function daysText(d) {
    if (d === null || d === undefined) return '';
    if (d === 0) return '今天到期';
    if (d < 0) return '已逾期 ' + Math.abs(d) + ' 天';
    return '还有 ' + d + ' 天';
  }
  function shortDate(v) {
    var d = parseDate(v);
    return d ? (d.getMonth() + 1) + '月' + d.getDate() + '日' : String(v || '');
  }
  function timeOf(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function kindName(k) {
    if (k === 'pdf') return 'PDF';
    if (k === 'image') return '图片';
    if (k === 'video') return '视频';
    if (k === 'text') return '文字';
    if (k === 'link') return '链接';
    return '文件';
  }

  function relTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var diff = dayDiff(todayStr(d));
    if (diff === 0) return '今天 ' + timeOf(iso);
    if (diff === -1) return '昨天 ' + timeOf(iso);
    return shortDate(todayStr(d));
  }
  function todayLabel() {
    var d = new Date();
    var w = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 · 周' + w;
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /* 轻轻震一下，点了才知道点到了（安卓 APP 里有效果，网页端会自动忽略） */
  function buzz(ms) {
    try {
      if (navigator.vibrate) navigator.vibrate(ms || 12);
    } catch (e) { /* 不支持就算了 */ }
  }

  function toast(msg, opts) {
    var el = $('#toast');
    var o = opts || {};
    el.textContent = msg;                       // 保持原来只写文本的语义
    // 带上「撤销」这类按钮时，先把上一次的按钮清掉
    var old = el.querySelector('.toast-btn');
    if (old) el.removeChild(old);
    el.classList.remove('has-action');
    el.hidden = false;
    clearTimeout(toast._t);

    if (o.action) {
      var btn = document.createElement('button');
      btn.className = 'toast-btn';
      btn.textContent = o.action;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        el.hidden = true;
        clearTimeout(toast._t);
        if (o.onAction) o.onAction();
      });
      el.appendChild(btn);
      el.classList.add('has-action');
      toast._t = setTimeout(function () { el.hidden = true; }, o.ms || 5000);
      return;
    }
    toast._t = setTimeout(function () { el.hidden = true; }, 2200);
  }

  function showLoading(text) {
    $('#loading-text').textContent = text || '处理中…';
    $('#loading').hidden = false;
  }
  function hideLoading() { $('#loading').hidden = true; }

  /* ---------------- 存储 ---------------- */
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        db.items = data.items || [];
        db.todos = data.todos || [];
        db.reminders = data.reminders || [];
        db.reports = data.reports || [];
        // 老数据没有 settings，补上默认值
        var s = data.settings || {};
        db.settings = {
          remindEnabled: s.remindEnabled !== false,
          remindAt: /^\d{2}:\d{2}$/.test(s.remindAt || '') ? s.remindAt : DEFAULT_SETTINGS.remindAt,
          lastRemindedOn: s.lastRemindedOn || '',
          morningDismissedOn: s.morningDismissedOn || '',
          clipDismissed: s.clipDismissed || '',
          installDismissed: s.installDismissed || '',
          swipeBack: s.swipeBack !== false,
          swipeTabs: s.swipeTabs !== false,
          autoUpdate: s.autoUpdate !== false,
          updateSkip: Number(s.updateSkip) || 0,
          importantAt: /^\d{2}:\d{2}$/.test(s.importantAt || '') ? s.importantAt : DEFAULT_SETTINGS.importantAt
        };
        db.alarms = Array.isArray(data.alarms) ? data.alarms : [];
        // 重要任务的一次性闹钟登记表（跟 db.alarms 完全分开）
        db.once = data.once && typeof data.once === 'object' ? data.once : {};

        // 刷新过一轮：撤销期没走完的删除一律作废，任务要还在
        db.todos.forEach(function (t) { t.pendingDelete = false; });
        db.reminders.forEach(function (r) { r.pendingDelete = false; });
      }
    } catch (e) { /* 存储损坏就从空开始，不要让页面挂掉 */ }
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(db));
    } catch (e) {
      toast('本机存储满了，删一些旧内容');
    }
  }

  /* ---------------- 云服务 / AI ---------------- */
  function initCloud() {
    try {
      if (typeof WorkBuddyCloud === 'undefined') {
        ui.aiState = '不可用（SDK 没加载）';
        return;
      }
      ui.cloud = WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: CLOUD.endpoint,
        publishableKey: CLOUD.publishableKey
      });
      ui.aiState = '已就绪';
    } catch (e) {
      ui.aiState = '不可用（' + (e && e.message ? e.message : '初始化失败') + '）';
      ui.cloud = null;
    }
  }

  /* 实测出来的模型偏好顺序（2026-10 实测耗时，单位秒）：
     deepseek-v4.1-flash 2.5s / deepseek-v4-flash 2.7s / glm-5.3-flash 6.7s
     minimax-m3 4.7s / kimi-k2.6 7.5s / hy3 23s
     注意：绝不能用 auto —— 它会路由到思考型模型，长提示词 60 秒都出不来。 */
  var MODEL_ORDER = [
    'deepseek-v4.1-flash', 'deepseek-v4-flash', 'glm-5.3-flash',
    'minimax-m3.1-flash', 'minimax-m3', 'kimi-k2.6', 'hunyuan-chat'
  ];
  var VISION_ORDER = [
    'deepseek-v4.1-flash', 'glm-5.3-flash', 'minimax-m3',
    'kimi-k2.6', 'glm-5.2', 'deepseek-v4-flash'
  ];
  /* 实测（2026-10）：只有 minimax-m3 认 video_url，能直接看懂视频内容 */
  var VIDEO_ORDER = ['minimax-m3', 'minimax-m3.1-flash'];
  var ATTEMPT_TIMEOUT = 40000;   // 单次尝试最多等 40 秒
  var MAX_ATTEMPTS = 3;          // 最多换 3 个模型

  function buildVideoChain(models) {
    var chain = [];
    var byId = {};
    (models || []).forEach(function (m) {
      if (m && m.disabled !== true) byId[m.id] = m;
    });
    VIDEO_ORDER.forEach(function (id) {
      if (byId[id]) { chain.push(byId[id]); delete byId[id]; }
    });
    return chain.slice(0, 2);
  }

  /* 按偏好顺序排出一条候选链，用不到 auto */
  function buildChain(models, needVision) {
    var order = needVision ? VISION_ORDER : MODEL_ORDER;
    var byId = {};
    (models || []).forEach(function (m) {
      if (m && m.disabled !== true && m.id !== 'auto' && m.id !== 'default') byId[m.id] = m;
    });

    var chain = [];
    order.forEach(function (id) {
      var m = byId[id];
      if (!m) return;
      if (needVision && !m.supportsImages) return;
      chain.push(m);
      delete byId[id];
    });
    // 偏好表里没有的，按接口返回顺序补齐
    (models || []).forEach(function (m) {
      if (!m || m.disabled === true || m.id === 'auto' || m.id === 'default') return;
      if (!byId[m.id]) return;
      if (needVision && !m.supportsImages) return;
      chain.push(m);
      delete byId[m.id];
    });
    return chain.slice(0, MAX_ATTEMPTS);
  }

  var SYSTEM_PROMPT =
    '你是办公文档助理。把用户给的内容整理成 JSON，只输出 JSON，不要解释。\n' +
    'JSON 结构：\n' +
    '{\n' +
    '  "summary": "两三句话的中文摘要，说清楚这是什么、关键结论",\n' +
    '  "seen": ["如果是图片：说清楚你看到了什么，版式、清晰度、有没有被裁切"],\n' +
    '  "numbers": [{"label": "金额/数量等名称", "value": "具体数值带单位"}],\n' +
    '  "risks": [{"level": "high|medium|low", "text": "风险或需要注意的地方"}],\n' +
    '  "todos": [{"title": "要做的事", "dueDate": "YYYY-MM-DD 或 null"}],\n' +
    '  "dues": [{"title": "什么到期", "date": "YYYY-MM-DD"}]\n' +
    '}\n' +
    '没有内容的字段给空数组。日期必须是 YYYY-MM-DD。不确定的日期放 risks 里说明，不要瞎编。';

  /* 调 AI。按偏好链依次尝试，成功返回结构化对象，全部失败抛错由调用方降级。 */
  var modelCache = null;

  function askAI(input) {
    if (!ui.cloud) return Promise.reject(new Error('AI 未就绪'));

    var ready = modelCache
      ? Promise.resolve(modelCache)
      : ui.cloud.llm.models.list().then(function (models) {
          modelCache = models;
          return models;
        });

    return ready.then(function (models) {
      var frames = input.images || (input.imageDataUrl ? [input.imageDataUrl] : []);
      var isVideo = !!input.videoUrl;
      var hasFrames = frames.length > 0;

      var chain;
      if (isVideo) chain = buildVideoChain(models);
      else chain = buildChain(models, hasFrames);

      if (!chain.length) throw new Error('没有可用模型');

      var head = input.kindLabel + '「' + input.title + '」';

      var userContent;
      if (isVideo) {
        userContent = [
          {
            type: 'text',
            text: head + '。请完整看一遍这个视频，然后：'
              + '1) 说清它整体讲了什么；2) 描述画面里出现的人、场景、物品；'
              + '3) 把屏幕上出现的文字、数字、日期原样抄下来；'
              + '4) 标出关键内容大概出现在什么时候；5) 提取需要跟进的事和到期日。'
          },
          { type: 'video_url', video_url: { url: input.videoUrl } }
        ];
      } else if (hasFrames) {
        var prompt = head + '。';
        if (frames.length > 1) {
          prompt += '下面是从这段视频里按时间顺序均匀抽取的 ' + frames.length + ' 帧画面。'
            + '请把它们当成一个连续视频来看：'
            + '1) 说清整体讲了什么、是什么场景；'
            + '2) 按顺序描述每一帧里的人和物；'
            + '3) 把画面里出现的文字、数字、日期、金额原样抄下来（很重要）；'
            + '4) 指出哪些信息前后有变化；'
            + '5) 提取需要跟进的事和到期日。';
        } else {
          prompt += '请分析这张图片，说清楚你看到了什么，并提取关键信息和日期。';
        }
        if (input.text) prompt += '\n\n' + input.text;

        userContent = [{ type: 'text', text: prompt }];
        frames.slice(0, 8).forEach(function (f) {
          userContent.push({ type: 'image_url', image_url: { url: f } });
        });
      } else {
        userContent = head + '的内容：\n\n' + (input.text || '');
      }

      var messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ];

      return tryChain(chain, 0, messages);
    });
  }

  /* 逐个模型试，前一个失败/超时就换下一个 */
  function tryChain(chain, index, messages) {
    if (index >= chain.length) {
      return Promise.reject(new Error('模型都没响应'));
    }
    var model = chain[index];
    return runStream(model.id, messages).catch(function (err) {
      var reason = (err && err.message) || '调用失败';
      if (index + 1 < chain.length) {
        // 换下一个模型再试
        return tryChain(chain, index + 1, messages);
      }
      throw new Error(reason);
    });
  }

  function runStream(modelId, messages) {
    return new Promise(function (resolve, reject) {
      var answer = '';
      var stream;
      var settled = false;
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;

      var timer = setTimeout(function () {
        if (settled) return;
        // 超时：先看半截内容能不能抢救
        var salvaged = salvage(answer);
        if (salvaged) { finish(null, salvaged); return; }
        if (controller) { try { controller.abort(); } catch (e) {} }
        finish(new Error('模型太慢（超过 ' + Math.round(ATTEMPT_TIMEOUT / 1000) + ' 秒）'), null);
      }, ATTEMPT_TIMEOUT);

      function finish(err, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve(value);
      }

      try {
        stream = ui.cloud.llm.chat.completions.create({
          model: modelId,
          messages: messages,
          stream: true,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          signal: controller ? controller.signal : undefined
        });
      } catch (e) {
        finish(e, null);
        return;
      }

      (async function () {
        try {
          for await (var chunk of stream) {
            var c = chunk && chunk.choices && chunk.choices[0];
            var d = c && c.delta;
            if (d && d.content) answer += d.content;
          }
          if (settled) return;
          try {
            finish(null, parseAnswer(answer));
          } catch (parseErr) {
            var salvaged = salvage(answer);
            if (salvaged) finish(null, salvaged);
            else finish(new Error('模型返回的内容读不懂'), null);
          }
        } catch (e) {
          if (settled) return;
          var salvaged = salvage(answer);
          if (salvaged) finish(null, salvaged);
          else finish(e, null);
        }
      })();
    });
  }

  /* 半截 JSON 抢救：至少把摘要和已经吐出来的待办捞回来 */
  function salvage(raw) {
    var text = String(raw || '');
    var summary = '';
    var m = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) {
      try { summary = JSON.parse('"' + m[1] + '"'); } catch (e) { summary = m[1]; }
    }
    if (!summary || summary.length < 6) return null;

    var out = {
      summary: summary, seen: [], numbers: [], risks: [], todos: [], dues: []
    };
    // 待办和到期日靠正则从半截内容里捞
    var todoRe = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"[^}]*?"dueDate"\s*:\s*(null|"(\d{4}-\d{2}-\d{2})")/g;
    var t;
    while ((t = todoRe.exec(text)) && out.todos.length < 6) {
      out.todos.push({ title: unescapeStr(t[1]), dueDate: t[3] || null });
    }
    var dateRe = /"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/g;
    var d2;
    while ((d2 = dateRe.exec(text)) && out.dues.length < 6) {
      out.dues.push({ title: '到期事项', date: d2[1] });
    }
    return out;
  }

  function unescapeStr(s) {
    try { return JSON.parse('"' + s + '"'); } catch (e) { return s; }
  }

  function parseAnswer(raw) {
    var text = String(raw || '').trim();
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    var start = text.indexOf('{');
    var end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    var obj = JSON.parse(text);
    return normalizeResult(obj);
  }

  /* 模型偶尔会把数组写成一句话，这里统一兜成数组，避免 forEach 抛错 */
  function asArray(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
    if (typeof v === 'object') return [v];
    return [];
  }

  function normalizeResult(obj) {
    obj = obj || {};
    var out = {
      summary: String(obj.summary || '').trim(),
      seen: [],
      numbers: [],
      risks: [],
      todos: [],
      dues: []
    };
    asArray(obj.seen).forEach(function (s) {
      if (!s) return;
      var text = typeof s === 'string' ? s : (s.text || s.desc || '');
      if (text) out.seen.push(String(text));
    });
    asArray(obj.numbers).forEach(function (n) {
      if (!n) return;
      if (typeof n === 'string') { out.numbers.push({ label: '数值', value: n }); return; }
      if (n.label || n.value) {
        out.numbers.push({ label: String(n.label || '数值'), value: String(n.value == null ? '' : n.value) });
      }
    });
    asArray(obj.risks).forEach(function (r) {
      if (!r) return;
      var text = typeof r === 'string' ? r : (r.text || r.desc);
      var level = typeof r === 'string' ? 'medium' : (r.level || 'medium');
      if (text) out.risks.push({ level: String(level), text: String(text) });
    });
    asArray(obj.todos).forEach(function (t) {
      if (!t) return;
      var title = typeof t === 'string' ? t : (t.title || t.text || t.task);
      if (!title) return;
      var raw = typeof t === 'object' ? (t.dueDate || t.date || null) : null;
      var due = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
      out.todos.push({ title: String(title), dueDate: due });
    });
    asArray(obj.dues).forEach(function (d) {
      if (!d) return;
      if (typeof d === 'string') {
        var m = d.match(/(\d{4}-\d{2}-\d{2})/);
        if (m) out.dues.push({ title: d.replace(m[1], '').replace(/[，,：:\s]+$/, '') || '到期事项', date: m[1] });
        return;
      }
      var title = d.title || d.text || d.name;
      var date = d.date || d.dueDate;
      if (title && date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        out.dues.push({ title: String(title), date: String(date) });
      }
    });
    return out;
  }

  /* ---------------- 本地降级分析 ---------------- */
  /* AI 不可用时的兜底：正则提取日期、金额、待办句式，生成能用的结果。 */
  function localAnalyze(input) {
    var text = String(input.text || '');
    var clean = text.replace(/\s+/g, ' ').trim();

    var summary = clean.slice(0, 140);
    if (clean.length > 140) summary += '…';
    if (!summary) summary = '这段内容没有可读的文字。';

    var numbers = [];
    var moneyRe = /([\u4e00-\u9fa5]{0,6})\s*([¥￥]?\s*\d[\d,.]*\s*(?:万|元|块|美元|港币)?)/g;
    var m;
    while ((m = moneyRe.exec(clean)) && numbers.length < 5) {
      var value = (m[2] || '').trim();
      if (value.length < 2) continue;
      numbers.push({ label: (m[1] || '数值').trim() || '数值', value: value });
    }

    var dues = [];
    var dateRe = /(\d{4})\s*[-年\/]\s*(\d{1,2})\s*[-月\/]\s*(\d{1,2})\s*日?/g;
    while ((m = dateRe.exec(clean)) && dues.length < 5) {
      var y = +m[1], mo = +m[2], d = +m[3];
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      var iso = y + '-' + pad(mo) + '-' + pad(d);
      var around = clean.slice(Math.max(0, m.index - 12), m.index + 12).trim();
      dues.push({ title: '到期：' + (around || '文件中的日期'), date: iso });
    }

    var todos = [];
    var sentences = clean.split(/[。；;\n！!？?]/);
    sentences.forEach(function (s) {
      var t = s.trim();
      if (t.length < 4 || t.length > 60) return;
      if (/(请|需要|务必|记得|尽快|安排|提交|准备|确认|回款|跟进|付款|签约)/.test(t) && todos.length < 4) {
        todos.push({ title: t, dueDate: null });
      }
    });

    var risks = [];
    if (/(逾期|超期|违约|罚款|风险|注意|异常|不合格|拒付)/.test(clean)) {
      var hit = clean.match(/[^。；;\n]{0,30}(逾期|超期|违约|罚款|风险|异常|不合格|拒付)[^。；;\n]{0,30}/);
      if (hit) risks.push({ level: 'high', text: hit[0].trim() });
    }
    if (input.truncated) {
      risks.push({ level: 'low', text: '原文较长，只分析了前面的部分内容。' });
    }

    return {
      summary: summary,
      seen: [],
      numbers: numbers,
      risks: risks,
      todos: todos,
      dues: dues
    };
  }

  /* ---------------- 文件解析 ---------------- */
  function extOf(name) {
    var m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  function stripXml(xml) {
    return String(xml || '')
      .replace(/<w:p[ >]/g, '\n<w:p ')
      .replace(/<a:p>/g, '\n<a:p>')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function readFileText(file) {
    var ext = extOf(file.name);

    if (['txt', 'md', 'csv', 'json'].indexOf(ext) >= 0) {
      return readAsText(file).then(function (t) { return { text: t, truncated: false }; });
    }

    if (['docx', 'xlsx', 'pptx'].indexOf(ext) < 0) {
      return Promise.reject(new Error(
        '这个格式读不了。Word、Excel、PPT、PDF、txt 可以，老格式请先另存为新格式。'
      ));
    }

    if (typeof JSZip === 'undefined') {
      return Promise.reject(new Error('解析组件没加载（网络问题）。把关键内容截图发进来更快。'));
    }

    return readAsArrayBuffer(file).then(function (buf) {
      return JSZip.loadAsync(buf);
    }).then(function (zip) {
      if (ext === 'docx') {
        return zip.file('word/document.xml').async('string').then(function (xml) {
          return { text: stripXml(xml), truncated: false };
        });
      }

      if (ext === 'pptx') {
        var slides = [];
        zip.forEach(function (p) {
          if (/^ppt\/slides\/slide\d+\.xml$/.test(p)) slides.push(p);
        });
        slides.sort();
        return Promise.all(slides.map(function (p) { return zip.file(p).async('string'); }))
          .then(function (xmls) {
            var out = xmls.map(function (x, i) {
              return '第 ' + (i + 1) + ' 页\n' + stripXml(x);
            }).join('\n\n');
            return { text: out, truncated: false };
          });
      }

      // xlsx
      var shared = zip.file('xl/sharedStrings.xml');
      var sharedP = shared ? shared.async('string') : Promise.resolve('');
      return sharedP.then(function (sxml) {
        var list = [];
        var re = /<si>([\s\S]*?)<\/si>/g;
        var m;
        while ((m = re.exec(sxml))) list.push(stripXml(m[1]));
        var sheets = [];
        zip.forEach(function (p) {
          if (/^xl\/worksheets\/sheet\d+\.xml$/.test(p)) sheets.push(p);
        });
        sheets.sort();
        return Promise.all(sheets.map(function (p) { return zip.file(p).async('string'); }))
          .then(function (xmls) {
            var lines = [];
            xmls.forEach(function (xml) {
              var rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
              var rm;
              while ((rm = rowRe.exec(xml))) {
                var cellRe = /<c([^>]*)>([\s\S]*?)<\/c>/g;
                var cm;
                var cells = [];
                while ((cm = cellRe.exec(rm[1]))) {
                  var attrs = cm[1] || '';
                  var body = cm[2] || '';
                  var isShared = /t="s"/.test(attrs);
                  var vm = body.match(/<v>([\s\S]*?)<\/v>/);
                  var val = vm ? vm[1] : (body.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
                  if (val == null) { cells.push(''); continue; }
                  if (isShared) {
                    var idx = parseInt(val, 10);
                    cells.push(list[idx] != null ? list[idx] : '');
                  } else {
                    cells.push(stripXml(val));
                  }
                }
                if (cells.join('').trim()) lines.push(cells.join(' | '));
              }
            });
            return { text: lines.join('\n'), truncated: false };
          });
      });
    });
  }

  function readAsText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || '')); };
      r.onerror = function () { reject(new Error('文件读取失败')); };
      r.readAsText(file, 'utf-8');
    });
  }

  function readAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error('文件读取失败')); };
      r.readAsArrayBuffer(file);
    });
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || '')); };
      r.onerror = function () { reject(new Error('图片读取失败')); };
      r.readAsDataURL(file);
    });
  }

  // 图片压缩后再送给模型，避免过大
  function compressImage(dataUrl, maxSide) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, (maxSide || 1280) / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = function () { resolve(dataUrl); };
      img.src = dataUrl;
    });
  }

  function sizeLabel(bytes) {
    var n = Number(bytes || 0);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* ---------------- 待办的数据口 ---------------- */
  /* 所有新建待办都走这里，字段口径只有一处 */
  function createTodo(o) {
    o = o || {};
    var t = {
      id: o.id || uid(),
      title: String(o.title || '').trim(),
      done: !!o.done,
      dueDate: o.dueDate || null,
      createdAt: o.createdAt || new Date().toISOString(),
      important: !!o.important,
      repeat: o.repeat || 'none',
      repeatDay: o.repeatDay || null,
      seriesId: o.seriesId || null,
      spawned: false,
      pendingDelete: false
    };
    db.todos.unshift(t);
    return t;
  }

  function createReminder(o) {
    o = o || {};
    var r = {
      id: o.id || uid(),
      title: String(o.title || '').trim(),
      dueDate: o.dueDate || null,
      confirmed: !!o.confirmed,
      createdAt: o.createdAt || new Date().toISOString(),
      important: !!o.important,
      pendingDelete: false
    };
    db.reminders.push(r);
    return r;
  }

  /* 重复任务的下一个日期。每月按锚定日走，31 号落到 2 月就是 28/29，3 月还是 31 */
  function nextRepeatDate(dueDate, repeat, anchorDay) {
    var d = parseDate(dueDate);
    if (!d) return null;
    if (repeat === 'daily') { d.setDate(d.getDate() + 1); return todayStr(d); }
    if (repeat === 'weekly') { d.setDate(d.getDate() + 7); return todayStr(d); }
    if (repeat === 'workday') {
      var x = new Date(d.getTime());
      do { x.setDate(x.getDate() + 1); } while (x.getDay() === 0 || x.getDay() === 6);
      return todayStr(x);
    }
    if (repeat === 'monthly') {
      var y = d.getFullYear(), m = d.getMonth(), y2 = y, m2 = m + 1;
      if (m2 > 11) { m2 = 0; y2 = y + 1; }
      var dim2 = new Date(y2, m2 + 1, 0).getDate();
      var anchor = anchorDay || d.getDate();
      return y2 + '-' + pad(m2 + 1) + '-' + pad(Math.min(anchor, dim2));
    }
    return null;
  }

  /* 重复任务完成时推一条新的。三道闸防止无限增殖 */
  function spawnNextInstance(t) {
    if (!t || !t.repeat || t.repeat === 'none') return null;
    if (t.spawned) return null;                    // 闸1：同一实例只生成一次
    t.spawned = true;
    var series = t.seriesId || (t.seriesId = t.id);
    var pending = db.todos.filter(function (x) {
      return x.seriesId === series && x.id !== t.id && !x.done && !x.pendingDelete;
    });
    if (pending.length) return null;               // 闸2：同系列只留一个未完成实例
    var next = nextRepeatDate(t.dueDate, t.repeat, t.repeatDay);
    if (!next) return null;
    var nt = createTodo({
      title: t.title, dueDate: next, important: t.important,
      repeat: t.repeat, repeatDay: t.repeatDay, seriesId: series
    });
    pruneSeries(series);                          // 闸3：每系列历史最多留 20 条
    return nt;
  }

  function pruneSeries(series) {
    var list = db.todos.filter(function (x) { return x.seriesId === series; });
    if (list.length <= 20) return;
    list.sort(function (a, b) { return String(a.createdAt) < String(b.createdAt) ? -1 : 1; });
    var cut = list.slice(0, list.length - 20);
    cut.forEach(function (x) {
      db.todos = db.todos.filter(function (y) { return y.id !== x.id; });
    });
  }

  /* 统一的「标记完成」入口：重复任务在这里推下一条 */
  function setNodeDone(src, id, done) {
    var list = src === 'todo' ? db.todos : db.reminders;
    var rec = list.filter(function (x) { return x.id === id; })[0];
    if (!rec) return null;
    if (src === 'todo') {
      rec.done = !!done;
      if (rec.done) spawnNextInstance(rec);
    } else {
      rec.confirmed = !!done;
    }
    save();
    syncImportantAlarms();
    renderTodos();
    renderHome();
    if (ui.tab === 'me') renderMe();
    return rec;
  }

  /* ---------------- 处理链路 ---------------- */
  function persistItem(meta, result, degraded) {
    var item = {
      id: uid(),
      kind: meta.kind,
      title: meta.title,
      source: meta.source,
      url: meta.url || '',
      sizeLabel: meta.sizeLabel || '',
      status: 'done',
      degraded: !!degraded,
      summary: result.summary,
      seen: result.seen || [],
      numbers: result.numbers || [],
      risks: result.risks || [],
      todos: result.todos || [],
      dues: result.dues || [],
      createdAt: new Date().toISOString()
    };

    // 顺带把待办和到期提醒落到列表里
    (result.todos || []).forEach(function (t) {
      createTodo({ title: t.title, dueDate: t.dueDate || null });
    });
    (result.dues || []).forEach(function (d) {
      createReminder({ title: d.title, dueDate: d.date });
    });

    db.items.unshift(item);
    save();
    return item;
  }

  function analyzeAndSave(meta, payload) {
    showLoading(meta.loadingText || '正在分析…');
    return askAI(payload)
      .then(function (result) {
        hideLoading();
        return persistItem(meta, result, false);
      })
      .catch(function (err) {
        hideLoading();
        var local = localAnalyze({
          text: payload.text || '',
          truncated: false
        });
        var visual = !!payload.imageDataUrl || !!payload.videoUrl ||
          !!(payload.images && payload.images.length);
        if (!local.summary && !visual) {
          toast((err && err.message) || '分析失败');
          return null;
        }
        if (!payload.text) {
          local.summary = '这段素材 AI 暂时读不了画面，先记下来，等会儿再试一次。';
        }
        local.summary = '（AI 暂时不可用，以下是本地提取的结果）' + local.summary;
        return persistItem(meta, local, true);
      });
  }

  function handleText(text) {
    var clean = String(text || '').trim();
    if (!clean) { toast('先粘贴内容'); return; }
    var title = clean.split(/[\n。]/)[0].slice(0, 18) || '一段文字';
    analyzeAndSave(
      { kind: 'text', title: title, source: '手动粘贴', sizeLabel: clean.length + ' 字', loadingText: '正在总结…' },
      { kindLabel: '一段文字', title: title, text: clean }
    ).then(function (item) {
      if (item) openItem(item.id);
    });
  }

  /* ---------------- PDF ---------------- */
  /* pdf.js 只在真要读 PDF 时才加载：1.4MB，不该拖慢首屏 */
  var PDF_SRC = '/assets/pdf.min.js';
  var PDF_WORKER = '/assets/pdf.worker.min.js';
  var PDF_MAX_BYTES = 30 * 1024 * 1024;
  var PDF_MAX_PAGES = 60;
  var PDF_IMAGE_PAGES = 5;
  var PDF_KEEP_CHARS = 3000;
  var pdfLoading = null;

  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfLoading) return pdfLoading;

    pdfLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = withSharecode(PDF_SRC);
      s.async = true;
      s.onload = function () {
        if (!window.pdfjsLib) { reject(new Error('PDF 组件加载不完整')); return; }
        try {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = withSharecode(PDF_WORKER);
        } catch (e) { /* 没有 worker 也能降级跑 */ }
        resolve(window.pdfjsLib);
      };
      s.onerror = function () {
        pdfLoading = null;
        reject(new Error('PDF 组件没下载下来'));
      };
      document.head.appendChild(s);
    });

    return pdfLoading;
  }

  /* 按纵坐标分行，比直接拼字符串更接近原文排版 */
  function pdfPageText(content) {
    var lines = [];
    var cur = null;

    (content.items || []).forEach(function (it) {
      if (!it || !it.str) return;
      var y = Math.round(it.transform[5]);
      if (!cur || Math.abs(cur.y - y) > 2) {
        cur = { y: y, parts: [] };
        lines.push(cur);
      }
      cur.parts.push({ x: it.transform[4], s: it.str });
    });

    return lines.map(function (l) {
      return l.parts.sort(function (a, b) { return a.x - b.x; })
        .map(function (p) { return p.s; }).join('');
    }).join('\n');
  }

  /* 有些 PDF 没带 ToUnicode 映射，正文会变成一堆私用区字符 */
  function looksGarbled(text) {
    if (!text) return true;
    var bad = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if ((c >= 0xe000 && c <= 0xf8ff) || c === 0xfffd) bad++;
    }
    return bad / text.length > 0.06;
  }

  function countChars(text) {
    return String(text || '').replace(/\s/g, '').length;
  }

  function joinPdfText(texts) {
    var out = [];
    texts.forEach(function (t, i) {
      var s = String(t || '').trim();
      if (s) out.push('第 ' + (i + 1) + ' 页\n' + s);
    });
    return out.join('\n\n');
  }

  function pdfErrorText(err) {
    var name = (err && err.name) || '';
    var msg = (err && err.message) || '';

    if (name === 'PasswordException' || /password/i.test(msg)) {
      return '这个 PDF 设了密码，解开之后再发进来';
    }
    if (name === 'InvalidPDFException' || /invalid pdf structure/i.test(msg)) {
      return '这个文件不像是完整的 PDF，重新下载一次再发';
    }
    if (name === 'MissingPDFException') {
      return 'PDF 内容读不到，可能没下载完整';
    }
    if (/组件/.test(msg)) {
      return msg + '，检查网络再试，或者把关键页截图发进来';
    }
    return '这份 PDF 没读成功。把关键几页截图发进来，一样能分析';
  }

  function readPdf(file) {
    return loadPdfJs().then(function (lib) {
      return readAsArrayBuffer(file).then(function (buf) {
        return lib.getDocument({
          data: new Uint8Array(buf),
          isEvalSupported: false,
          useSystemFonts: false
        }).promise;
      }).then(function (doc) {
        var limit = Math.min(doc.numPages, PDF_MAX_PAGES);
        var texts = [];
        var chain = Promise.resolve();

        for (var i = 1; i <= limit; i++) {
          (function (n) {
            chain = chain.then(function () {
              return doc.getPage(n).then(function (page) {
                return page.getTextContent().then(function (tc) {
                  texts.push(pdfPageText(tc));
                });
              }).catch(function () { texts.push(''); });
            });
          })(i);
        }

        return chain.then(function () {
          return { doc: doc, total: doc.numPages, limit: limit, texts: texts };
        });
      });
    });
  }

  /* 没有文字层的 PDF：把前几页画成图片，交给视觉模型 */
  function pdfRenderPages(doc, maxPages) {
    var images = [];
    var chain = Promise.resolve();

    for (var i = 1; i <= maxPages; i++) {
      (function (n) {
        chain = chain.then(function () {
          return doc.getPage(n).then(function (page) {
            var base = page.getViewport({ scale: 1 });
            var scale = Math.min(1.7, 1200 / (base.width || 595));
            var vp = page.getViewport({ scale: scale });
            var canvas = document.createElement('canvas');
            canvas.width = Math.round(vp.width);
            canvas.height = Math.round(vp.height);
            var ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('canvas 不可用');
            return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
              images.push(canvas.toDataURL('image/jpeg', 0.72));
            });
          }).catch(function () { /* 某一页失败不影响其它页 */ });
        });
      })(i);
    }

    return chain.then(function () { return images; });
  }

  function handlePDF(file) {
    if (file.size > PDF_MAX_BYTES) {
      toast('这个 PDF 有 ' + sizeLabel(file.size) + '，超过 30MB。拆成几份，或者只发关键几页');
      return;
    }

    showLoading(window.pdfjsLib ? '正在读 PDF…' : '第一次用，先准备 PDF 组件…');

    var ref = null;

    readPdf(file).then(function (res) {
      ref = res.doc;
      var text = joinPdfText(res.texts);
      var chars = countChars(text);
      var pagesLabel = res.total + ' 页' + (res.total > res.limit ? '（读了前 ' + res.limit + ' 页）' : '');

      if (chars >= 60 && !looksGarbled(text)) {
        hideLoading();
        return analyzeAndSave(
          {
            kind: 'pdf',
            title: file.name,
            source: '本机 PDF',
            sizeLabel: pagesLabel + ' · 文字版',
            loadingText: '正在读这份 PDF…'
          },
          {
            kindLabel: '一份 PDF',
            title: file.name,
            text: '共 ' + res.total + ' 页，以下是抽出来的原文：\n\n' + text.slice(0, 18000)
          }
        ).then(function (item) {
          if (item) {
            item.pages = res.total;
            item.pdfChars = chars;
            item.pdfText = text.slice(0, PDF_KEEP_CHARS);
            save();
          }
          return item;
        });
      }

      showLoading('这份 PDF 没有可读的文字，正在转成图片看…');
      var pages = Math.min(res.total, PDF_IMAGE_PAGES);

      return pdfRenderPages(res.doc, pages).then(function (images) {
        hideLoading();
        if (!images.length) throw new Error('转图片失败');
        return analyzeAndSave(
          {
            kind: 'pdf',
            title: file.name,
            source: '本机 PDF',
            sizeLabel: pagesLabel + ' · 扫描版',
            loadingText: '正在看这几页…'
          },
          {
            kindLabel: '一份扫描版 PDF',
            title: file.name,
            text: '这是一份扫描版 PDF，共 ' + res.total + ' 页，下面是前 ' + pages
              + ' 页的画面。请把画面里的文字、数字、日期、金额原样抄下来。',
            images: images
          }
        ).then(function (item) {
          if (item) {
            item.pages = res.total;
            item.scanned = true;
            save();
          }
          return item;
        });
      });
    }).then(function (item) {
      hideLoading();
      if (ref) { try { ref.destroy(); } catch (e) {} }
      if (item) openItem(item.id);
    }).catch(function (err) {
      hideLoading();
      if (ref) { try { ref.destroy(); } catch (e) {} }
      toast(pdfErrorText(err));
    });
  }

  function handleFile(file) {
    if (extOf(file.name) === 'pdf') { handlePDF(file); return; }

    showLoading('读取文件…');
    readFileText(file).then(function (res) {
      hideLoading();
      if (!res.text.trim()) {
        toast('这个文件里没读到文字');
        return null;
      }
      return analyzeAndSave(
        {
          kind: 'file', title: file.name, source: '本机文件',
          sizeLabel: sizeLabel(file.size), loadingText: '正在分析…'
        },
        { kindLabel: '一份文件', title: file.name, text: res.text }
      );
    }).then(function (item) {
      if (item) openItem(item.id);
    }).catch(function (err) {
      hideLoading();
      toast((err && err.message) || '处理失败');
    });
  }

  /* ---------------- 剪贴板 / 深链接 ---------------- */
  /* 微信没有「转发到网页」这个能力，所以真正的桥是：在微信里复制链接
     → 回到这里，自动认出剪贴板里的网址，一点就开始分析。 */

  function extractUrl(text) {
    var m = String(text || '').match(/https?:\/\/[^\s"'<>）)】\]]+/i);
    return m ? m[0] : '';
  }

  function readClipboardText() {
    return new Promise(function (resolve) {
      // 打包版：原生读系统剪贴板，不需要手势，切回来就能拿到
      if (inNativeApp()) {
        try {
          var native = window.GuijiApp.readClipboard();
          resolve(String(native || ''));
          return;
        } catch (e) { /* 原生失败就退回浏览器 API */ }
      }
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText()
            .then(function (t) { resolve(String(t || '')); })
            .catch(function () { resolve(''); });
          return;
        }
      } catch (e) { /* 不支持就走下面 */ }
      resolve('');
    });
  }

  /* 首页那条「剪贴板里有个链接」 */
  function checkClipboard(silent, retry) {
    return readClipboardText().then(function (text) {
      var url = extractUrl(text);

      // 刚切回前台时系统剪贴板偶尔还没准备好，隔一会儿再试一次
      if (!url && retry) {
        return new Promise(function (res) {
          setTimeout(function () { res(checkClipboard(silent, false)); }, 700);
        });
      }

      if (!url) {
        if (!silent) toast('剪贴板里没有链接');
        return '';
      }
      if (db.settings.clipDismissed === url) return '';
      showClipBar(url);

      // 不在首页时看不到那条提示，补一句
      if (ui.tab !== 'home' || $('#s-home').hidden) {
        toast('剪贴板里有个链接，回首页就能读');
      }
      return url;
    });
  }

  function showClipBar(url) {
    var bar = $('#clip-bar');
    if (!bar) return;
    var host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { host = url.slice(0, 24); }
    $('#clip-text').innerHTML = '剪贴板里有 <b>' + esc(host) + '</b> 的链接，点这里读';
    bar.setAttribute('data-url', url);
    bar.hidden = false;
    ui.clipUrl = url;
  }

  function hideClipBar() {
    var bar = $('#clip-bar');
    if (bar) bar.hidden = true;
    ui.clipUrl = '';
  }

  /* 从地址栏取要分析的链接：?u= / ?url= / 系统分享带过来的 text */
  function urlFromLocation() {
    var search = String(location.search || '');
    var m = search.match(/[?&]u=([^&]+)/) || search.match(/[?&]url=([^&]+)/);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }
    var t = search.match(/[?&](?:text|title)=([^&]+)/);
    if (t) {
      var raw = '';
      try { raw = decodeURIComponent(t[1].replace(/\+/g, ' ')); } catch (e) { raw = t[1]; }
      return extractUrl(raw);
    }
    return '';
  }

  /* ---------------- 链接识别（服务端抓取）---------------- */
  function withSharecode(path) {
    var m = String(location.search || '').match(/[?&]sharecode=([^&]+)/);
    if (!m) return path;
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'sharecode=' + m[1];
  }

  function handleLink(rawUrl) {
    var input = String(rawUrl || '').trim();
    if (!input) { toast('先粘贴链接'); return; }

    // 只留第一行，防止用户把整段话粘进来
    input = input.split(/[\s\n]+/)[0];
    // 允许不带协议
    var withProto = /^https?:\/\//i.test(input) ? input : 'https://' + input;
    if (!/^https?:\/\/[^\s.]+\.[^\s]{2,}/i.test(withProto)) {
      toast('这看起来不是个网址');
      return;
    }

    var host = '';
    try { host = new URL(withProto).hostname.replace(/^www\./, ''); } catch (e) {}

    showLoading('正在打开这个链接…');

    fetch(withSharecode('/api/link?url=' + encodeURIComponent(withProto)))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        hideLoading();
        if (!data || !data.ok) {
          var msg = (data && data.error) || '这个链接读不出来';
          // 视频站反爬：服务器抓不到页面，但用户手机上能看。教他换一条路。
          if (/\b(412|403|401)\b/.test(msg)) {
            msg = '这个站点挡住了服务器（' + msg.replace(/[^0-9]/g, '') + '），'
              + '把视频截图或录屏发进来一样能看';
          }
          toast(msg);
          return null;
        }

        var text = String(data.text || '').trim();
        var title = String(data.title || '').trim() || host || '一个网页';

        // 视频页：优先把视频直链交给能看视频的模型，没有直链就用封面+标题+简介
        if (data.isVideo) {
          var desc = String(data.desc || '').trim();
          var payload = {
            kindLabel: '一个视频',
            title: title.slice(0, 40),
            text: '视频标题：' + title + (desc ? '\n简介：' + desc : '')
              + (data.siteName ? '\n来自：' + data.siteName : ''),
            videoUrl: data.videoUrl || '',
            images: data.coverData ? [data.coverData] : []
          };
          return analyzeAndSave(
            {
              kind: 'video',
              title: title.slice(0, 40),
              source: (data.siteName || host || '视频链接'),
              url: withProto,
              sizeLabel: data.videoUrl ? '可直接看视频' : '视频页',
              loadingText: data.videoUrl ? '正在看这个视频…' : '正在看封面和简介…'
            },
            payload
          );
        }

        // 读不到正文，但标题和摘要能拿到，就用手上有的先顶着
        if (text.length < 60) {
          var fallback = [title, data.desc].filter(Boolean).join('\n');
          if (fallback.length < 20) {
            toast('这个页面读不到正文，可能要登录或者内容靠脚本加载');
            return null;
          }
          text = fallback;
          toast('正文没读到，先用标题和摘要分析');
        }

        return analyzeAndSave(
          {
            kind: 'link',
            title: title.slice(0, 40),
            source: host || '网页链接',
            url: withProto,
            sizeLabel: (data.chars || text.length) + ' 字',
            loadingText: '正在读这篇文章…'
          },
          { kindLabel: '一篇网页文章', title: title.slice(0, 40), text: text }
        );
      })
      .catch(function (err) {
        hideLoading();
        toast('链接读取失败，检查一下网络');
      })
      .then(function (item) {
        if (item) openItem(item.id);
      });
  }

  /* 从视频里等间隔抽几帧，交给视觉模型看 */
  function grabFrames(file, count) {
    return new Promise(function (resolve, reject) {
      var url = null
      try { url = URL.createObjectURL(file) } catch (e) { return reject(new Error('读不了这个视频')) }

      var v = document.createElement('video');
      v.preload = 'auto';
      v.muted = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.src = url;

      var done = false;
      function fail(msg) {
        if (done) return;
        done = true;
        try { URL.revokeObjectURL(url) } catch (e) {}
        reject(new Error(msg));
      }

      var timer = setTimeout(function () { fail('视频加载太慢') }, 25000);

      v.onerror = function () { fail('这个格式的视频浏览器打不开'); };

      v.onloadedmetadata = function () {
        var dur = isFinite(v.duration) ? v.duration : 0;
        if (!dur || dur < 0.3) { clearTimeout(timer); return fail('视频太短或读不到时长'); }

        var n = Math.max(1, Math.min(count || 6, 8));
        var vw = v.videoWidth || 640;
        var vh = v.videoHeight || 360;
        var w = Math.min(640, vw);
        var h = Math.round(w * vh / vw) || 360;

        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');

        var times = [];
        for (var i = 0; i < n; i++) {
          var t = dur * (i + 0.5) / n;
          times.push(Math.max(0.05, Math.min(dur - 0.1, t)));
        }

        var frames = [];
        var idx = 0;

        function next() {
          if (idx >= times.length) {
            clearTimeout(timer);
            if (done) return;
            done = true;
            try { URL.revokeObjectURL(url) } catch (e) {}
            if (!frames.length) return reject(new Error('没抽到画面'));
            return resolve({ frames: frames, duration: dur, width: vw, height: vh });
          }
          try { v.currentTime = times[idx]; } catch (e) { idx++; next(); }
        }

        v.onseeked = function () {
          try {
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            frames.push(canvas.toDataURL('image/jpeg', 0.72));
          } catch (e) { /* 这一帧画不出来就跳过 */ }
          idx++;
          next();
        };

        next();
      };
    });
  }

  function fmtDur(sec) {
    var s = Math.round(sec || 0);
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' + r : r);
  }

  function handleVideo(file) {
    if (!file) return;
    if (file.size > 300 * 1024 * 1024) { toast('视频超过 300MB，先剪辑一下'); return; }

    showLoading('正在从视频里抽画面…');

    grabFrames(file, 6).then(function (res) {
      hideLoading();
      var label = fmtDur(res.duration) + ' · ' + res.frames.length + ' 帧';
      return analyzeAndSave(
        {
          kind: 'video',
          title: file.name || '一段视频',
          source: '本机视频',
          sizeLabel: label,
          loadingText: '正在看视频…'
        },
        {
          kindLabel: '一段视频',
          title: file.name || '视频',
          text: '文件名：' + (file.name || '未命名') + '，时长 ' + fmtDur(res.duration)
            + '，分辨率 ' + res.width + '×' + res.height + '。',
          images: res.frames
        }
      );
    }).then(function (item) {
      hideLoading();
      if (item) openItem(item.id);
    }).catch(function (err) {
      hideLoading();
      toast((err && err.message) || '这个视频处理不了');
    });
  }

  function handleImage(file) {
    showLoading('识别图片…');
    readAsDataUrl(file).then(function (raw) {
      return compressImage(raw, 1280);
    }).then(function (dataUrl) {
      return analyzeAndSave(
        {
          kind: 'image', title: file.name || '一张图片', source: '本机图片',
          sizeLabel: sizeLabel(file.size), loadingText: '正在看图…'
        },
        { kindLabel: '一张图片', title: file.name || '图片', text: '', imageDataUrl: dataUrl }
      );
    }).then(function (item) {
      hideLoading();
      if (item) openItem(item.id);
    }).catch(function (err) {
      hideLoading();
      toast((err && err.message) || '处理失败');
    });
  }

  /* ---------------- 报告 ---------------- */
  function buildDaily() {
    var day = todayStr();
    var todayItems = db.items.filter(function (i) { return todayStr(new Date(i.createdAt)) === day; });
    var openTodos = db.todos.filter(function (t) { return !t.done; });
    var dueSoon = db.reminders.filter(function (r) {
      var d = dayDiff(r.dueDate);
      return d !== null && d <= 7;
    });

    var sections = [];

    if (todayItems.length) {
      sections.push({
        title: '今天处理了什么',
        lines: todayItems.map(function (i) {
          return i.title + '（' + kindName(i.kind) + '）—— ' + (i.summary || '').slice(0, 40);
        })
      });
    }
    if (openTodos.length) {
      sections.push({
        title: '待办',
        lines: openTodos.slice(0, 6).map(function (t) {
          return t.title + (t.dueDate ? '（' + shortDate(t.dueDate) + '）' : '');
        })
      });
    }
    if (dueSoon.length) {
      sections.push({
        title: '快到期的',
        lines: dueSoon.slice(0, 6).map(function (r) {
          return r.title + ' —— ' + shortDate(r.dueDate) + ' · ' + daysText(dayDiff(r.dueDate));
        })
      });
    }

    var headline = '今天处理了 ' + todayItems.length + ' 条内容，'
      + openTodos.length + ' 件待办没完成，'
      + dueSoon.length + ' 项在 7 天内到期。';

    return { headline: headline, sections: sections, counts: { items: todayItems.length, todos: openTodos.length, dues: dueSoon.length } };
  }

  function generateReport() {
    var day = todayStr();
    var existed = db.reports.filter(function (r) { return r.reportDate === day; })[0];
    if (existed) {
      toast('今天已经生成过');
      openReport(existed.id);
      return;
    }
    var body = buildDaily();
    var report = {
      id: uid(),
      kind: 'daily',
      title: (new Date().getMonth() + 1) + '月' + new Date().getDate() + '日 日报',
      reportDate: day,
      unread: false,
      body: body,
      createdAt: new Date().toISOString()
    };
    db.reports.unshift(report);
    save();
    toast('已生成');
    openReport(report.id);
  }

  /* ---------------- 早晨提醒 ---------------- */
  /* 每天到点（默认 07:30）推一次：首页置顶卡片 + 系统通知 + 报告留痕。
     网页关掉时浏览器不允许主动推送，所以做成「到点即发，错过补发」：
     当天第一次打开时，如果已过提醒时间且今天还没提醒过，就立刻补一次。 */

  function todayAt(hhmm) {
    var p = String(hhmm || '07:30').split(':');
    var now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), +p[0] || 0, +p[1] || 0, 0, 0);
  }

  /* 汇总出「今天要处理什么」 */
  function buildDigest() {
    var open = collectNodes().filter(function (n) { return !n.done; });
    var overdue = [], today = [], soon = [], nodate = [];
    var important = [], importantToday = [], importantOverdue = [];

    open.forEach(function (n) {
      var b = bucketOf(n);
      if (b === 'overdue') overdue.push(n);
      else if (b === 'today') today.push(n);
      else if (b === 'tomorrow' || b === 'soon') soon.push(n);
      else if (b === 'nodate') nodate.push(n);
      if (n.important) {
        important.push(n);
        if (b === 'today') importantToday.push(n);
        else if (b === 'overdue') importantOverdue.push(n);
      }
    });

    return {
      overdue: overdue,
      today: today,
      soon: soon,
      nodate: nodate,
      important: important,
      importantToday: importantToday,
      importantOverdue: importantOverdue,
      actionable: overdue.length + today.length + soon.length,
      total: open.length
    };
  }

  function digestHeadline(d) {
    var parts = [];
    if (d.overdue.length) parts.push(d.overdue.length + ' 项已逾期');
    if (d.today.length) parts.push(d.today.length + ' 项今天到期');
    if (d.soon.length) parts.push(d.soon.length + ' 项三天内到期');
    var head = parts.join('，');
    if (d.important && d.important.length) {
      head += (head ? '，' : '') + '重要 ' + d.important.length + ' 件';
    }
    return head;
  }

  /* 首页那张卡片 */
  function renderMorningCard() {
    var card = $('#morning-card');
    if (!card) return;

    var d = ui.morning;
    var dismissed = db.settings.morningDismissedOn === todayStr();
    if (!d || dismissed) { card.hidden = true; return; }

    var lines = [];
    function pushLines(list, tag, cls, limit) {
      list.slice(0, limit).forEach(function (n) {
        var dtxt = dayDiff(n.dueDate);
        var extra = dtxt === null ? '' : ' · ' + daysText(dtxt);
        lines.push('<div class="morning-line' + (n.important ? ' imp' : '') + '">'
          + '<span class="ml-tag ' + cls + '">' + tag + '</span>'
          + '<span class="ml-text">' + (n.important ? '<span class="ml-star">★</span>' : '') + esc(n.title) + '</span>'
          + '<span class="ml-when">' + (extra ? extra.replace(' · ', '') : '') + '</span></div>');
      });
    }

    var shownCount = 0;
    pushLines(d.overdue, '逾期', 'red', 2); shownCount += Math.min(2, d.overdue.length);
    pushLines(d.today, '今天', 'amber', 2); shownCount += Math.min(2, d.today.length);
    pushLines(d.soon, '临近', 'blue', 2); shownCount += Math.min(2, d.soon.length);

    if (!lines.length) {
      // 没有到期的，就报一下没定日期的
      pushLines(d.nodate, '待办', '', 3);
      shownCount = Math.min(3, d.nodate.length);
    }
    if (!lines.length) { card.hidden = true; return; }

    // 重要的事单独拎出来放最前面，别被淹没
    if (d.important && d.important.length) {
      var impText = d.importantToday.length
        ? ('今天有 ' + d.importantToday.length + ' 件重要的事')
        : ('有 ' + d.importantOverdue.length + ' 件重要的事已经过期了');
      var impHtml = '<div class="morning-imp"><span class="mi-tag">重要</span>'
        + '<span class="mi-text">' + impText + '</span></div>';
      lines.unshift(impHtml);
    }

    var rest = d.actionable + (d.actionable ? 0 : d.nodate.length) - shownCount;
    if (rest > 0) lines.push('<div class="morning-more">还有 ' + rest + ' 项，点下面看全部</div>');

    var hour = new Date().getHours();
    var greet = hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 19 ? '下午好' : '晚上好';
    var head = d.actionable
      ? greet + '，今天有 ' + d.actionable + ' 件事要盯'
      : greet + '，今天没有到期的，有 ' + d.nodate.length + ' 件待办挂着';

    $('#morning-title').textContent = head;
    $('#morning-lines').innerHTML = lines.join('');
    $('#morning-when').textContent = db.settings.remindAt + ' 提醒 · ' + (digestHeadline(d) || '暂无到期');
    card.className = 'morning' + (d.overdue.length ? ' hot' : '') + (d.important && d.important.length ? ' has-imp' : '');
    card.hidden = false;
  }

  function notifyState() {
    if (inNativeApp()) return 'app';   // 打包版用系统通知，不受浏览器限制
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission; // granted / denied / default
  }

  function notifyStateText() {
    var s = notifyState();
    if (s === 'app') return '应用内通知';
    if (s === 'unsupported') return '当前浏览器不支持';
    if (s === 'granted') return '已开启';
    if (s === 'denied') return '已被浏览器拦下';
    return '点这里开启';
  }

  /* 发一条系统通知：优先走 Service Worker（安卓必须），退回构造函数 */
  function pushSystemNotice(d) {
    if (inNativeApp()) {
      try {
        var t0 = '鬼邮局 · 今日待办';
        var b0 = d.actionable
          ? digestHeadline(d) + '。打开看看时间表。'
          : '今天没有到期的，还有 ' + d.nodate.length + ' 件待办挂着。';
        window.GuijiApp.notifyNow(t0, b0);
      } catch (e) {}
      return;
    }
    if (notifyState() !== 'granted') return;
    var title = '鬼邮局 · 今日待办';
    var body = d.actionable
      ? digestHeadline(d) + '。打开看看时间表。'
      : '今天没有到期的，还有 ' + d.nodate.length + ' 件待办挂着。';

    var opts = {
      body: body,
      icon: 'assets/icon-192.png',
      badge: 'assets/icon-192.png',
      tag: 'guiji-morning',
      renotify: true
    };

    try {
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(function (reg) {
          if (reg && reg.showNotification) reg.showNotification(title, opts);
          else fallbackNotice(title, opts);
        }).catch(function () { fallbackNotice(title, opts); });
      } else {
        fallbackNotice(title, opts);
      }
    } catch (e) { /* 通知失败不影响 App 本身 */ }
  }

  function fallbackNotice(title, opts) {
    try {
      var n = new Notification(title, opts);
      n.onclick = function () {
        try { window.focus(); } catch (e) {}
        openTodos();
        n.close();
      };
    } catch (e) { /* 部分移动浏览器禁止这样构造，忽略 */ }
  }

  /* 每次提醒留一条记录，错过也能在报告里回看 */
  function writeMorningReport(d) {
    var day = todayStr();
    var existed = db.reports.filter(function (r) { return r.kind === 'morning' && r.reportDate === day; })[0];
    if (existed) return;

    var sections = [];
    function sec(title, list) {
      if (!list.length) return;
      sections.push({
        title: title,
        lines: list.slice(0, 8).map(function (n) {
          var dt = dayDiff(n.dueDate);
          return n.title + (n.dueDate ? '（' + shortDate(n.dueDate) + (dt === null ? '' : ' · ' + daysText(dt)) + '）' : '');
        })
      });
    }
    sec('已逾期', d.overdue);
    sec('今天到期', d.today);
    sec('三天内到期', d.soon);
    sec('重要', d.important);
    sec('没有截止日', d.nodate);

    db.reports.unshift({
      id: uid(),
      kind: 'morning',
      title: (new Date().getMonth() + 1) + '月' + new Date().getDate() + '日 晨间提醒',
      reportDate: day,
      unread: false,
      body: {
        headline: digestHeadline(d) || ('今天没有到期的，有 ' + d.nodate.length + ' 件待办'),
        sections: sections,
        counts: { items: 0, todos: d.total, dues: d.actionable }
      },
      createdAt: new Date().toISOString()
    });
    save();
  }

  /* 主入口：force = 手动「现在就试一次」 */
  function checkMorning(force) {
    var s = db.settings;
    if (!force && !s.remindEnabled) return false;

    var now = new Date();
    var day = todayStr(now);
    if (!force && s.lastRemindedOn === day) return false;

    var at = todayAt(s.remindAt);
    if (!force && now.getTime() < at.getTime()) return false;

    var d = buildDigest();
    ui.morning = d;

    if (!force && !d.actionable && !d.nodate.length) {
      // 什么都没有，就别打扰
      s.lastRemindedOn = day;
      save();
      renderMorningCard();
      return false;
    }

    if (!force) {
      s.lastRemindedOn = day;
      s.morningDismissedOn = '';   // 新的一天，卡片重新出现
      save();
    }

    renderMorningCard();
    if (!force) {
      pushSystemNotice(d);
      writeMorningReport(d);
    }
    return true;
  }

  /* ---------------- 导出到手机日历（关掉网页也能响）---------------- */
  /* 原理：生成 .ics，用户导入系统日历后，闹钟由操作系统负责，
     网页关着、手机锁着都会响。这是纯前端唯一能「不打开网页也提醒」的办法。 */

  function icsEsc(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  /* iCalendar 规定单行不超过 75 字节，按 UTF-8 字节折行（中文 3 字节，不能按字符数折） */
  function icsFold(line) {
    var out = [];
    var cur = '';
    var bytes = 0;
    var LIMIT = 72;   // 留点余量

    for (var i = 0; i < line.length; i++) {
      var code = line.charCodeAt(i);
      var ch = line.charAt(i);
      var size;

      if (code < 0x80) {
        size = 1;
      } else if (code < 0x800) {
        size = 2;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        // 高位代理：连着低位一起取，算 4 字节
        ch = line.substr(i, 2);
        i++;
        size = 4;
      } else {
        size = 3;
      }

      if (bytes + size > LIMIT) {
        out.push(cur);
        cur = ' ';      // 续行以空格开头
        bytes = 1;
      }
      cur += ch;
      bytes += size;
    }
    out.push(cur);
    return out.join('\r\n');
  }

  function icsStamp(d) {
    var x = d || new Date();
    return x.getUTCFullYear() + pad(x.getUTCMonth() + 1) + pad(x.getUTCDate())
      + 'T' + pad(x.getUTCHours()) + pad(x.getUTCMinutes()) + pad(x.getUTCSeconds()) + 'Z';
  }

  /* 浮动本地时间：不写 Z，日历按设备本地时区解释，正好卡在用户设的钟点 */
  function icsLocal(d) {
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
      + 'T' + pad(d.getHours()) + pad(d.getMinutes()) + '00';
  }

  function atOnDay(dateStr, hhmm) {
    var p = String(dateStr).split('-');
    var t = String(hhmm || '07:30').split(':');
    return new Date(+p[0], +p[1] - 1, +p[2], +t[0] || 0, +t[1] || 0, 0, 0);
  }

  /* 一条待办 → 一个 VEVENT。buildICS 和「单条加日历」共用 */
  function icsNodeEvent(n, stamp, nowMs, hhmm, uid) {
    var when = atOnDay(n.dueDate, hhmm);
    // 截止日已经过去的事件，闹钟设了也不会响，顺延到明天早上当「催办」
    if (when.getTime() < nowMs) {
      when = atOnDay(todayStr(), hhmm);
      if (when.getTime() < nowMs) when.setDate(when.getDate() + 1);
    }
    var d = dayDiff(n.dueDate);
    var head = d !== null && d < 0 ? '已逾期：' : '今天截止：';
    var uidText = uid || ('guiji-todo-' + String(n.id).replace(/[^a-zA-Z0-9]/g, '') + '@ghost-post');
    return [
      'BEGIN:VEVENT',
      'UID:' + uidText,
      'DTSTAMP:' + stamp,
      'DTSTART:' + icsLocal(when),
      'DTEND:' + icsLocal(new Date(when.getTime() + 15 * 60000)),
      'SUMMARY:' + icsEsc(head + n.title),
      'DESCRIPTION:' + icsEsc(n.title + '\n截止日期：' + n.dueDate
        + (n.src === 'due' ? '\n类型：到期事项' : '\n类型：待办')),
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'TRIGGER:PT0M',
      'ACTION:DISPLAY',
      'DESCRIPTION:' + icsEsc(head + n.title),
      'END:VALARM',
      'END:VEVENT'
    ];
  }

  function buildICS() {
    var s = db.settings;
    var stamp = icsStamp(new Date());
    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//GuiJi//Todo Reminder//CN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:鬼邮局待办'
    ];

    var pending = collectNodes().filter(function (n) { return !n.done; });
    var withDate = pending.filter(function (n) { return !!n.dueDate; });
    var noDate = pending.filter(function (n) { return !n.dueDate; });

    // 1）每天固定时间的总提醒
    var start = atOnDay(todayStr(), s.remindAt);
    if (start.getTime() < new Date().getTime()) start.setDate(start.getDate() + 1);

    var descParts = [];
    if (withDate.length) {
      descParts.push('接下来要处理的：');
      withDate.slice(0, 8).forEach(function (n) {
        var d = dayDiff(n.dueDate);
        descParts.push('· ' + n.title + '（' + shortDate(n.dueDate) + ' 截止'
          + (d === null ? '' : '，' + daysText(d)) + '）');
      });
      if (withDate.length > 8) descParts.push('…还有 ' + (withDate.length - 8) + ' 项');
    } else if (noDate.length) {
      descParts.push('有 ' + noDate.length + ' 件没定截止日的待办：');
      noDate.slice(0, 6).forEach(function (n) { descParts.push('· ' + n.title); });
    } else {
      descParts.push('今天没有待办。');
    }
    descParts.push('');
    descParts.push('打开鬼邮局看完整时间表。');

    lines = lines.concat([
      'BEGIN:VEVENT',
      'UID:guiji-daily-' + icsStamp(new Date()).slice(0, 8) + '@ghost-post',
      'DTSTAMP:' + stamp,
      'DTSTART:' + icsLocal(start),
      'DTEND:' + icsLocal(new Date(start.getTime() + 15 * 60000)),
      'RRULE:FREQ=DAILY',
      'SUMMARY:' + icsEsc('鬼邮局 · 今日待办'),
      'DESCRIPTION:' + icsEsc(descParts.join('\n')),
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'TRIGGER:PT0M',
      'ACTION:DISPLAY',
      'DESCRIPTION:' + icsEsc('鬼邮局 · 今日待办'),
      'END:VALARM',
      'END:VEVENT'
    ]);

    // 2）每条有截止日的待办，单独一个当天提醒（最多 40 条，避免文件过大）
    var nowMs = new Date().getTime();
    withDate.slice(0, 40).forEach(function (n) {
      lines = lines.concat(icsNodeEvent(n, stamp, nowMs, s.remindAt));
    });

    lines.push('END:VCALENDAR');
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }

  /* 只把指定的这些待办导成日历（详情页批量 / 时间表单条） */
  function buildICSForNodes(nodes, opts) {
    var o = opts || {};
    var s = db.settings;
    var stamp = icsStamp(new Date());
    var nowMs = new Date().getTime();
    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//GuiJi//Todo Reminder//CN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:' + (o.name || '鬼邮局待办')
    ];
    var withDate = (nodes || []).filter(function (n) { return !!n.dueDate; });
    withDate.slice(0, 60).forEach(function (n, i) {
      // 重要的排在 09:30 响，普通按早报时间
      var hhmm = n.important ? (s.importantAt || '09:30') : s.remindAt;
      var uid = n.icalUid
        ? n.icalUid
        : ('guiji-' + String(n.src || 'todo') + '-' + String(n.id).replace(/[^a-zA-Z0-9]/g, '') + '@ghost-post');
      lines = lines.concat(icsNodeEvent(n, stamp, nowMs, hhmm, uid));
    });
    lines.push('END:VCALENDAR');
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }

  function downloadICSText(text, name) {
    try {
      var blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
      toast('已导出，用手机打开它并添加日历');
    } catch (e) {
      // 老浏览器退回 data URI
      try {
        var a2 = document.createElement('a');
        a2.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(text);
        a2.download = name;
        document.body.appendChild(a2);
        a2.click();
        document.body.removeChild(a2);
        toast('已导出，用手机打开它并添加日历');
      } catch (e2) {
        toast('这个浏览器导不出来，换个浏览器试试');
      }
    }
  }

  function downloadICS() {
    downloadICSText(buildICS(), '鬼邮局提醒.ics');
  }

  /* ---------------- 直写手机日历 ----------------
     APP 里不走文件下载（WebView 的 blob 下载会被下载器拦下打不开），
     而是直接调原生把事件插进系统日历，插完日历自己会响。
     网页版没有这个能力，退回导出 .ics 文件。 */
  var pendingCalNodes = null;

  function calWhen(n) {
    var hhmm = n.important ? (db.settings.importantAt || '09:30') : db.settings.remindAt;
    var when = atOnDay(n.dueDate, hhmm);
    var nowMs = Date.now();
    // 已经过了点的顺延到最近一次提醒时间，别写一个过去的日程进去
    if (when.getTime() < nowMs) {
      when = atOnDay(todayStr(), hhmm);
      if (when.getTime() < nowMs) when.setDate(when.getDate() + 1);
    }
    return when;
  }

  function calTitle(n) {
    var d = dayDiff(n.dueDate);
    return (d !== null && d < 0 ? '已逾期：' : '今天截止：') + n.title;
  }

  function insertCalEvents(nodes) {
    var okN = 0, failN = 0;
    nodes.slice(0, 60).forEach(function (n) {
      var when = calWhen(n);
      var desc = n.title + '\n截止日期：' + n.dueDate
        + (n.src === 'due' ? '\n类型：到期事项' : '\n类型：待办')
        + '\n来自鬼邮局';
      var r = '';
      try {
        r = String(window.GuijiApp.addCalendarEvent(
          calTitle(n), desc, when.getTime(), when.getTime() + 15 * 60000) || '');
      } catch (e) {}
      if (r === 'ok') okN++; else failN++;
    });
    buzz(20);
    if (okN && !failN) toast('已写进手机日历 ' + okN + ' 项');
    else if (okN) toast('写进去 ' + okN + ' 项，' + failN + ' 项没成');
    else toast('没写进去，手机上可能还没登录日历账户');
  }

  /* 统一入口：能直写就直写，不能就导文件 */
  function addEventsToPhoneCalendar(nodes, name) {
    nodes = (nodes || []).filter(function (n) { return !!n.dueDate; });
    if (!nodes.length) { toast('这些都没定日期，进不了日历'); return; }

    if (inNativeApp() && window.GuijiApp.addCalendarEvent) {
      try {
        var st = String(window.GuijiApp.calendarState() || '0|');
        if (st.charAt(0) !== '1') {
          // 还没给权限：先去要，要到了接着写
          pendingCalNodes = nodes;
          try { window.GuijiApp.requestCalendarPermission(); } catch (e) {}
          toast('在弹出的窗口里允许日历权限');
          return;
        }
        insertCalEvents(nodes);
        return;
      } catch (e) { /* 原生没这能力就掉到导文件 */ }
    }

    // 网页版：浏览器里下载 .ics 是正常的
    downloadICSText(buildICSForNodes(nodes, { name: name || '鬼邮局待办' }), '鬼邮局待办.ics');
  }

  /* 原生权限弹窗的结果 */
  window.__guijiCalendarPerm = function (granted) {
    if (granted && pendingCalNodes) {
      var nodes = pendingCalNodes;
      pendingCalNodes = null;
      setTimeout(function () { insertCalEvents(nodes); }, 400);
    } else if (!granted) {
      pendingCalNodes = null;
      toast('没给日历权限，之后可以在系统设置里开');
    }
  };

  /* ---------------- 装到桌面（当成 APP 用）---------------- */
  function uaInfo() {
    var ua = navigator.userAgent || '';
    var ios = /iPhone|iPad|iPod/i.test(ua);
    var android = /Android/i.test(ua);
    var wechat = /MicroMessenger/i.test(ua);
    var qq = /QQ\//i.test(ua) && !wechat;
    return {
      ua: ua,
      ios: ios,
      android: android,
      wechat: wechat,
      qq: qq,
      // iOS 上只有 Safari 能「添加到主屏幕」；微信/QQ 内置浏览器虽然是 WebKit 也不行
      safari: ios && !wechat && !qq && !/CriOS|FxiOS|EdgiOS|GSA/i.test(ua),
      desktop: !ios && !android
    };
  }

  /* 是否运行在打包好的安卓 APP 里（MainActivity 注入了 GuijiApp） */
  function inNativeApp() {
    try {
      return !!(window.GuijiApp && window.GuijiApp.version);
    } catch (e) { return false; }
  }

  function isStandalone() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (e) {}
    return navigator.standalone === true;
  }

  function stepHtml(list) {
    return '<div class="inst-steps">' + list.map(function (t, i) {
      return '<div class="inst-step"><span class="inst-no">' + (i + 1) + '</span>'
        + '<span class="inst-text">' + t + '</span></div>';
    }).join('') + '</div>';
  }

  /* 把链接复制到剪贴板，没有 clipboard API 就退回老办法 */
  function copyText(text) {
    return new Promise(function (resolve) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { resolve(true) })
            .catch(function () { resolve(legacyCopy(text)) });
          return;
        }
      } catch (e) {}
      resolve(legacyCopy(text));
    });
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }

  function pageUrl() {
    return location.href.split('#')[0];
  }

  /* 安卓：用 intent:// 从内置浏览器跳到 Chrome，那边才有安装入口 */
  function openInSystemBrowser() {
    var u = new URL(location.href);
    var host = u.host;
    var path = (u.pathname || '/') + (u.search || '');
    var fallback = encodeURIComponent(location.href);
    var intent = 'intent://' + host + path
      + '#Intent;scheme=https;package=com.android.chrome;'
      + 'S.browser_fallback_url=' + fallback + ';end';

    var before = Date.now();
    try { location.href = intent; } catch (e) { /* 某些内置浏览器直接拦掉 */ }

    // 如果两秒后还停在这一页，说明没跳成，退回复制链接
    setTimeout(function () {
      if (Date.now() - before < 3000 && !document.hidden) {
        copyText(pageUrl()).then(function (okCopy) {
          toast(okCopy ? '复制好了，粘到浏览器地址栏打开' : '请手动复制地址栏链接');
        });
      }
    }, 1500);
  }

  function renderInstall() {
    var box = $('#inst-body');
    if (!box) return;
    var info = uaInfo();
    var html = '';

    if (inNativeApp()) {
      $('#inst-sub').textContent = '你用的就是 APP 版';
      box.innerHTML = '<div class="inst-ok">✓ 已经装在手机里了</div>'
        + '<div class="inst-note">这个版本是独立安装的，不经过浏览器，早上会按你设的时间弹系统通知。</div>';
      return;
    }

    if (isStandalone()) {
      $('#inst-sub').textContent = '已经在 APP 模式里运行';
      box.innerHTML = '<div class="inst-ok">✓ 已经装好了，现在就是 APP 的样子</div>'
        + '<div class="inst-note">从桌面图标启动时没有地址栏，看起来跟原生应用一样。'
        + '想重新装一次，先把它从桌面删掉再回来装。</div>';
      return;
    }

    var canPrompt = !!ui.installPrompt;
    var apkUrl = withSharecode('/download/guiji-1.6.apk');

    if (info.ios) {
      $('#inst-sub').textContent = info.safari ? '三步加到桌面' : '换成 Safari 才能装';
      if (!info.safari) {
        html += '<div class="btn btn-primary inst-btn" id="inst-copy">复制链接</div>';
        html += '<div class="inst-note inst-warn">iPhone 上只有 <b>Safari</b> 能把网页加到桌面。'
          + '点上面复制链接，打开 Safari 粘贴访问，再按下面的步骤加。</div>';
      }
      html += stepHtml([
        '点屏幕<b>底部中间</b>的分享按钮 <b>⬆️</b>',
        '选 <b>添加到主屏幕</b>',
        '右上角点 <b>添加</b>'
      ]);
      html += '<div class="inst-note">iPhone 不能装 APK 文件，这是苹果的限制。加到桌面后效果一样：独立图标、全屏、能收通知。</div>';
    } else {
      $('#inst-sub').textContent = '下载安装包，一键装好';
      html += '<a class="btn btn-primary inst-btn inst-apk" id="inst-apk" href="' + apkUrl + '" download="guiji-1.6.apk">下载安卓版 APP（APK）</a>';
      html += '<div class="inst-note">下完直接点开这个文件安装。系统如果提示「禁止安装未知应用」，'
        + '点设置允许这一次就行。装完桌面上会出现「鬼邮局」，不用浏览器也能开。</div>';

      if (canPrompt) {
        html += '<div class="inst-or">或者</div>';
        html += '<div class="btn btn-ghost" id="inst-go">直接装到桌面（不下载文件）</div>';
      } else if (info.android) {
        html += '<div class="inst-or">或者</div>';
        html += '<div class="btn btn-ghost" id="inst-browser">装成网页版（跳浏览器）</div>';
      }
    }

    html += '<div class="inst-copy-row" id="inst-copy2">复制当前链接</div>';

    box.innerHTML = html;

    var go = $('#inst-go');
    if (go) {
      go.addEventListener('click', function () {
        if (!ui.installPrompt) { openInSystemBrowser(); return; }
        ui.installPrompt.prompt();
        ui.installPrompt.userChoice.then(function (r) {
          ui.installPrompt = null;
          if (r && r.outcome === 'accepted') {
            toast('装好了，去桌面看看');
            renderInstall();
          } else {
            toast('取消了');
          }
        }).catch(function () {});
      });
    }

    var br = $('#inst-browser');
    if (br) br.addEventListener('click', openInSystemBrowser);

    var cp = $('#inst-copy');
    if (cp) {
      cp.addEventListener('click', function () {
        copyText(pageUrl()).then(function (okCopy) {
          toast(okCopy ? '链接已复制，粘到 Safari 打开' : '请长按地址栏复制');
        });
      });
    }

    var cp2 = $('#inst-copy2');
    if (cp2) {
      cp2.addEventListener('click', function () {
        copyText(pageUrl()).then(function (okCopy) {
          toast(okCopy ? '链接已复制' : '请长按地址栏复制');
        });
      });
    }
  }

  /* 首页顶部的安装提示条 */
  function renderInstallBar() {
    var bar = $('#install-bar');
    if (!bar) return;
    if (isStandalone() || inNativeApp() || db.settings.installDismissed === 'yes') { bar.hidden = true; return; }
    var info = uaInfo();
    var text = info.wechat ? '在浏览器打开就能装成 APP'
      : info.ios ? '两步加到桌面，像 APP 一样用'
        : '装到桌面，打开就是全屏';
    $('#ib-text').textContent = text;
    bar.hidden = false;
  }

  /* ---------------- 应用内更新 ---------------- */
  /* 网页版本身就是最新的，只有打包安装的安卓 APP 需要这套流程：
     启动时问一次服务端版本号 → 提示或直接后台下载 → 下完拉起系统安装界面。
     下载、安装都交给原生做，网页这边只管状态和进度展示。 */

  var UPD_API = '/api/app-version';

  /* 老版本的原生只暴露 version()，这里兜一层，拿到数字版本号和展示名 */
  var NAME_TO_CODE = { '1.0': 1, '1.1': 2, '1.2': 3, '1.3': 4, '1.4': 5, '1.5': 6, '1.6': 7 };

  function appVersionCode() {
    if (!inNativeApp()) return 0;
    try {
      if (window.GuijiApp.appVersion) {
        var raw = String(window.GuijiApp.appVersion() || '');
        var m = raw.match(/(\d+)/);
        if (m) return parseInt(m[1], 10);
      }
      var v = String(window.GuijiApp.version() || '');
      return NAME_TO_CODE[v] || 0;
    } catch (e) { return 0; }
  }

  function appVersionName() {
    if (!inNativeApp()) return '';
    try {
      var raw = String(window.GuijiApp.appVersion && window.GuijiApp.appVersion() || '');
      if (raw) {
        var p = raw.split('|');
        return (p[1] || p[0] || '').replace(/^\d+\|/, '');
      }
      return String(window.GuijiApp.version() || '');
    } catch (e) { return ''; }
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n <= 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function absoluteUrl(p) {
    p = String(p || '');
    if (/^https?:/i.test(p)) return p;
    try {
      return location.origin + (p.charAt(0) === '/' ? p : '/' + p);
    } catch (e) { return p; }
  }

  /* 是不是在按流量计费的网络上：是就只提示，不自动下 */
  function metered() {
    try {
      var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (!c) return false;
      if (c.saveData === true) return true;
      if (c.type && c.type !== 'wifi' && c.type !== 'ethernet' && c.type !== 'none') return true;
      if (c.effectiveType && /^(slow-)?2g$/.test(c.effectiveType)) return true;
    } catch (e) {}
    return false;
  }

  function canAutoDownload() {
    return !!db.settings.autoUpdate && !metered();
  }

  /* 启动时查一次版本。不影响首屏渲染，晚一点再发请求 */
  function checkUpdate(opts) {
    opts = opts || {};
    var u = ui.update;
    if (u.state === 'downloading' || u.state === 'installing') return Promise.resolve();

    u.state = 'checking';
    return fetch(withSharecode(UPD_API), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        u.state = 'idle';
        u.checked = true;
        if (!j || !j.ok || !j.latest) return;
        var l = j.latest;
        u.latest = l;

        // 网页版每次打开都是最新的，只把版本信息显示出来
        if (!inNativeApp()) {
          u.state = 'latest';
          renderUpdateBar();
          renderMe();
          if (!$('#s-update').hidden) renderUpdate();
          return;
        }

        var cur = appVersionCode();
        if (l.versionCode > cur) {
          u.state = 'available';
          u.error = '';
          renderUpdateBar();
          renderMe();
          if (!$('#s-update').hidden) renderUpdate();
          // 开了自动下载且不是流量网络：后台下完再提示，尽量不打断使用
          if (canAutoDownload()) startUpdate(true);
        } else {
          u.state = 'latest';
          renderUpdateBar();
          renderMe();
          if (!$('#s-update').hidden) renderUpdate();
        }
      })
      .catch(function (e) {
        u.state = 'idle';
        u.error = '版本检查失败';
        renderMe();
        if (!$('#s-update').hidden) renderUpdate();
      });
  }

  function openUpdatePage() {
    renderUpdate();
    showScreen('update', { sub: true });
  }

  /* 首页顶部提示条 */
  function renderUpdateBar() {
    var bar = $('#update-bar');
    if (!bar) return;
    var u = ui.update;
    if (!inNativeApp() || !u.latest || (db.settings.updateSkip || 0) === (u.latest.versionCode || 0)) {
      bar.hidden = true; return;
    }
    var l = u.latest;
    var t = $('#update-text');
    if (u.state === 'downloading') {
      t.innerHTML = '正在下载更新 <b>' + Math.round(u.progress || 0) + '%</b>';
    } else if (u.state === 'downloaded') {
      t.innerHTML = '新版本已下载好，<b>点这里安装</b>';
    } else if (u.state === 'failed') {
      t.innerHTML = '更新没下成，<b>点这里重试</b>';
    } else if (u.state === 'latest') {
      bar.hidden = true; return;
    } else {
      var size = fmtBytes(l.size);
      t.innerHTML = '有新版本 <b>' + esc(l.versionName) + '</b>' + (size ? '（' + size + '）' : '');
    }
    bar.hidden = false;
  }

  function renderUpdate() {
    var u = ui.update;
    var l = u.latest || {};
    var verEl = $('#upd-ver');
    var metaEl = $('#upd-meta');
    var notesEl = $('#upd-notes');
    var prog = $('#upd-progress');
    var fill = $('#upd-fill');
    var ptext = $('#upd-ptext');
    var icon = $('#s-update .upd-icon');
    var btn = $('#upd-action');
    var later = $('#upd-later');
    var hint = $('#upd-hint');
    if (!btn) return;

    if (verEl) verEl.textContent = l.versionName ? ('v' + l.versionName) : '';
    if (metaEl) {
      var bits = [];
      if (l.size) bits.push(fmtBytes(l.size));
      bits.push(inNativeApp()
        ? ('当前 v' + (appVersionName() || '—'))
        : '当前是网页版，网页版会自动更新');
      metaEl.textContent = bits.join(' · ');
    }
    if (notesEl) {
      var list = l.notes || [];
      notesEl.innerHTML = list.length
        ? list.map(function (t) { return '<div class="un">' + esc(t) + '</div>'; }).join('')
        : '<div class="un">修复了一些问题，让应用更稳一点</div>';
    }

    var busy = u.state === 'downloading' || u.state === 'installing';
    if (prog) prog.hidden = !(busy || u.state === 'downloaded');
    if (fill) {
      var p = Math.max(0, Math.min(100, Math.round(u.progress || 0)));
      fill.style.width = p + '%';
      fill.className = p >= 100 ? 'full' : '';
    }
    if (ptext) {
      ptext.className = 'upd-ptext' + (u.state === 'failed' ? ' err' : '');
      if (u.state === 'downloading') ptext.innerHTML = '正在下载 <b>' + Math.round(u.progress || 0) + '%</b>，不耽误你现在用';
      else if (u.state === 'installing') ptext.textContent = '正在打开安装界面…';
      else if (u.state === 'downloaded') ptext.innerHTML = '下载完成，<b>点下面安装</b>';
      else if (u.state === 'failed') ptext.textContent = u.error || '更新失败';
      else ptext.textContent = '';
    }
    if (icon) icon.className = 'upd-icon' + (busy ? ' busy' : '');

    var label = '立即更新';
    var disabled = false;
    if (u.state === 'checking') { label = '正在检查…'; disabled = true; }
    else if (u.state === 'downloading') { label = '<span class="upd-spin"></span>下载中…'; disabled = true; }
    else if (u.state === 'installing') { label = '<span class="upd-spin"></span>安装中…'; disabled = true; }
    else if (u.state === 'downloaded') label = '安装';
    else if (u.state === 'failed') label = '重试';
    else if (u.state === 'latest') {
      if (inNativeApp()) { label = '已经是最新版本'; disabled = true; }
      else label = '下载安卓版 APP';
    } else if (!l.versionCode) { label = '检查一下更新'; }

    btn.innerHTML = label;
    var busy2 = u.state === 'downloading' || u.state === 'installing' || u.state === 'checking';
    btn.className = 'btn ' + (busy2 ? 'btn-ghost' : 'btn-primary');
    btn.style.opacity = busy2 ? '.65' : '';
    if (later) later.textContent = u.state === 'downloading' ? '在后台下着，先去用' : '稍后再说';

    if (hint) {
      if (u.state === 'failed') {
        hint.innerHTML = '没下成多半是网络断了，或者手机存储不够。'
          + '也可以去「装到手机」那一页手动下载安装包。';
      } else if (u.state === 'downloaded') {
        hint.textContent = '装的时候系统可能问你「允许安装未知应用」，勾一次就行。装完原来的数据都还在。';
      } else if (u.state === 'latest') {
        hint.textContent = '你现在就是最新的，有新版本时这里会自动出现。';
      } else {
        hint.textContent = '更新只换程序本身，不会动你手机里的内容。';
      }
    }
  }

  /* 开始下载。silent=true 表示后台静默下，不弹页面 */
  function startUpdate(silent) {
    var u = ui.update;
    if (!u.latest || !u.latest.url) { toast('暂时没有可用的安装包'); return; }
    if (u.state === 'downloading' || u.state === 'installing') return;
    if (u.state === 'downloaded') { installUpdate(); return; }

    var url = absoluteUrl(withSharecode(u.latest.url));
    u.error = '';
    u.progress = 0;

    if (inNativeApp() && window.GuijiApp.downloadUpdate) {
      u.state = 'downloading';
      renderUpdateBar();
      renderUpdate();
      if (silent) toast('有新版本，正在后台下载');
      try {
        window.GuijiApp.downloadUpdate(url);
      } catch (e) {
        u.state = 'failed';
        u.error = '下载没能启动';
        renderUpdateBar();
        renderUpdate();
      }
      return;
    }

    // 网页版装不了安装包，跳过去手动下
    if (!inNativeApp()) {
      try { window.open(url, '_blank'); } catch (e) {}
      toast('已打开下载页，下完点开安装');
      return;
    }

    // 老版本 APP 没有下载能力：交给浏览器下，装好这一版以后就能自己更新了
    u.state = 'failed';
    u.error = '当前版本不支持应用内下载，已帮你打开浏览器，装好这一版以后就能自动更新了';
    renderUpdateBar();
    renderUpdate();
    try { window.open(url, '_blank'); } catch (e) {}
  }

  function installUpdate() {
    var u = ui.update;
    if (!inNativeApp()) {
      if (u.latest && u.latest.url) {
        try { window.open(absoluteUrl(withSharecode(u.latest.url)), '_blank'); } catch (e) {}
      }
      return;
    }
    u.state = 'installing';
    renderUpdate();
    try {
      window.GuijiApp.installUpdate(u.path || '');
    } catch (e) {
      u.state = 'failed';
      u.error = '打不开安装界面';
      renderUpdateBar();
      renderUpdate();
      return;
    }
    // 安装界面盖上来以后人就走了；八秒后还停在这儿，说明没跳成，回到「安装」按钮
    setTimeout(function () {
      if (ui.update.state === 'installing') {
        ui.update.state = 'downloaded';
        renderUpdateBar();
        renderUpdate();
      }
    }, 8000);
  }

  function retryUpdate() {
    var u = ui.update;
    u.error = '';
    u.progress = 0;
    u.path = '';
    u.state = u.latest && u.latest.versionCode ? 'available' : 'idle';
    startUpdate(false);
  }

  function dismissUpdateBar() {
    var u = ui.update;
    if (u.latest) db.settings.updateSkip = u.latest.versionCode || 0;
    save();
    renderUpdateBar();
  }

  /* 原生的回调：下载进度 / 下载完成 / 下载失败 */
  window.__guijiUpdateProgress = function (p) {
    var u = ui.update;
    if (u.state !== 'downloading') u.state = 'downloading';
    u.progress = Number(p) || 0;
    renderUpdateBar();
    renderUpdate();
  };

  window.__guijiUpdateDone = function (path) {
    var u = ui.update;
    u.state = 'downloaded';
    u.progress = 100;
    u.path = String(path || '');
    renderUpdateBar();
    renderUpdate();
    renderMe();
    // 静默下载完就直接拉安装界面，用户不用再来点一次
    if (db.settings.autoUpdate) setTimeout(installUpdate, 400);
  };

  window.__guijiUpdateError = function (msg) {
    var u = ui.update;
    u.state = 'failed';
    u.error = String(msg || '下载失败');
    renderUpdateBar();
    renderUpdate();
    renderMe();
  };

  /* ---------------- 渲染 ---------------- */
  function renderSign() {
    var chars = ['黄', '信', '号', '天', '下', '无', '敌'];
    var sizes = [1.18, 0.92, 1.04, 0.86, 0.96, 0.9, 1.2];
    var weights = [700, 500, 600, 400, 500, 400, 700];
    var rotates = [-9, -5, -8, 5, -4, 6, -3];
    var offsets = [-2, 2, -2, 0, 2, -1, 2];
    var opacity = [0.95, 0.62, 0.82, 0.55, 0.7, 0.5, 0.93];

    $('#sign-row').innerHTML = chars.map(function (c, i) {
      var style = 'font-size:' + Math.round(13 * sizes[i]) + 'px;'
        + 'font-weight:' + weights[i] + ';'
        + 'opacity:' + opacity[i] + ';'
        + 'transform:rotate(' + rotates[i] + 'deg) translateY(' + offsets[i] + 'px);';
      return '<span class="sign-char" style="' + style + '">' + c + '</span>';
    }).join('');
  }

  function renderHome() {
    $('#today-label').textContent = todayLabel();

    var day = todayStr();
    var newToday = db.items.filter(function (i) { return todayStr(new Date(i.createdAt)) === day; });
    var openTodos = db.todos.filter(function (t) { return !t.done; });
    var dueSoon = db.reminders.filter(function (r) {
      var d = dayDiff(r.dueDate);
      return d !== null && d <= 7;
    });

    $('#st-new').textContent = newToday.length;
    $('#st-todo').textContent = openTodos.length;
    $('#st-due').textContent = dueSoon.length;
    $('#st-due').className = 'stat-num' + (dueSoon.length ? ' warn' : '');

    var notice = $('#cloud-notice');
    if (ui.aiState.indexOf('不可用') === 0) {
      notice.hidden = false;
      notice.textContent = 'AI 现在用不了（' + ui.aiState.replace('不可用（', '').replace('）', '') + '），新内容会用本地规则提取要点。';
    } else {
      notice.hidden = true;
    }

    // 今天
    var todayRows = [];
    openTodos.filter(function (t) { return !t.dueDate || t.dueDate <= day; }).slice(0, 3).forEach(function (t) {
      todayRows.push(
        '<div class="row" data-act="toggle-todo" data-id="' + t.id + '">'
        + '<div class="check"></div>'
        + '<div class="row-body"><div class="row-title">' + esc(t.title) + '</div>'
        + '<div class="row-meta">' + (t.dueDate ? shortDate(t.dueDate) + ' 到期' : '没有截止日') + '</div></div>'
        + '</div>'
      );
    });
    dueSoon.slice(0, 2).forEach(function (r) {
      var d = dayDiff(r.dueDate);
      todayRows.push(
        '<div class="row" data-act="go" data-go="todos">'
        + '<div class="dot ' + (d < 0 ? 'red' : 'amber') + '"></div>'
        + '<div class="row-body"><div class="row-title">' + esc(r.title) + '</div>'
        + '<div class="row-meta' + (d < 0 ? ' warn' : '') + '">' + shortDate(r.dueDate) + ' 到期 · ' + daysText(d) + '</div></div>'
        + '<div class="row-chev">›</div></div>'
      );
    });

    var todaySec = $('#today-sec');
    if (todayRows.length) {
      todaySec.hidden = false;
      $('#today-list').innerHTML = todayRows.join('');
    } else {
      todaySec.hidden = true;
    }

    // 最近
    var recent = db.items.slice(0, 3);
    if (recent.length) {
      $('#recent-list').innerHTML = recent.map(function (i) {
        var color = i.kind === 'image' ? 'amber' : i.kind === 'video' ? 'blue' : i.kind === 'text' ? '' : 'blue';
        return '<div class="row" data-act="open-item" data-id="' + i.id + '">'
          + '<div class="dot ' + color + '"></div>'
          + '<div class="row-body"><div class="row-title">' + esc(i.title) + '</div>'
          + '<div class="row-meta">' + relTime(i.createdAt) + ' · ' + esc((i.summary || '').slice(0, 22)) + '</div></div>'
          + '<div class="row-chev">›</div></div>';
      }).join('');
    } else {
      $('#recent-list').innerHTML =
        '<div class="empty"><div class="empty-title">还没有内容</div>'
        + '<div class="empty-desc">点右下角的「+」，把文件、照片或者一段文字发进来。</div></div>';
    }

    // 提醒卡片跟着一起刷新（勾选完待办数字要变）
    renderMorningCard();
    renderInstallBar();
  }

  function renderReports() {
    var list = $('#report-list');
    if (!db.reports.length) {
      list.innerHTML = '<div class="empty"><div class="empty-title">还没有报告</div>'
        + '<div class="empty-desc">点上面的按钮，把今天的文件和待办汇总成一份。</div></div>';
      return;
    }
    list.innerHTML = db.reports.map(function (r) {
      return '<div class="report-card" data-act="open-report" data-id="' + r.id + '">'
        + '<div class="report-top"><div class="report-title">' + esc(r.title)
        + (r.unread ? '<span class="unread-dot"></span>' : '') + '</div>'
        + '<div class="report-date">' + timeOf(r.createdAt) + '</div></div>'
        + '<div class="report-lead">' + esc((r.body && r.body.headline) || '') + '</div></div>';
    }).join('');
  }

  function renderMe() {
    $('#ai-state').textContent = ui.aiState;
    $('#me-items').textContent = db.items.length + ' 条';
    var mi = $('#me-install');
    if (mi) {
      var done = isStandalone() || inNativeApp();
      mi.textContent = inNativeApp() ? 'APP 版' : (done ? '已装好' : '点这里');
      mi.className = 'me-value ' + (done ? 'off' : 'on');
    }
    var rm = $('#me-remind');
    if (rm) {
      rm.textContent = db.settings.remindEnabled
        ? '每天 ' + db.settings.remindAt
        : '已关闭';
      rm.className = 'me-value ' + (db.settings.remindEnabled ? 'on' : 'off');
    }
  }

  /* ---------------- 闹钟 ---------------- */
  var DAYS_TEXT = { 127: '每天', 62: '工作日', 0: '只响一次' };

  function alarmRepeatText(mask) {
    return DAYS_TEXT[mask] || '每天';
  }

  function alarmBody() {
    var d = buildDigest();
    if (d.actionable) return digestHeadline(d) + '。打开看看时间表。';
    if (d.nodate.length) return '还有 ' + d.nodate.length + ' 件待办挂着。打开看看。';
    return '今天没有到期的，打开看看要做什么。';
  }

  /* 把所有闹钟同步给系统；网页版只能自己盯着时钟 */
  var syncedAlarmIds = {};

  function syncAlarms() {
    var native = inNativeApp();

    // 先取消已经不存在的
    Object.keys(syncedAlarmIds).forEach(function (id) {
      var still = db.alarms.some(function (a) { return a.id === id && a.on; });
      if (!still && native) {
        try { window.GuijiApp.cancelAlarm(id); } catch (e) {}
        delete syncedAlarmIds[id];
      }
    });

    db.alarms.forEach(function (a) {
      if (!a.on) {
        if (native && syncedAlarmIds[a.id]) {
          try { window.GuijiApp.cancelAlarm(a.id); } catch (e) {}
          delete syncedAlarmIds[a.id];
        }
        return;
      }
      if (native) {
        try {
          window.GuijiApp.setAlarm(a.id, a.hhmm, a.title || '鬼邮局 · 待办提醒', alarmBody(),
            a.days === undefined || a.days === null ? 127 : a.days);
          syncedAlarmIds[a.id] = true;
        } catch (e) {}
      }
    });
  }

  /* 网页版的兜底：每分钟看一眼有没有到点 */
  var lastFired = {};

  function tickAlarms() {
    if (inNativeApp()) return;
    var now = new Date();
    var hm = pad(now.getHours()) + ':' + pad(now.getMinutes());
    var day = todayStr(now);

    db.alarms.forEach(function (a) {
      if (!a.on || a.hhmm !== hm) return;
      if (a.days === 62 && (now.getDay() === 0 || now.getDay() === 6)) return;
      if (lastFired[a.id] === day) return;
      lastFired[a.id] = day;

      var d = buildDigest();
      if (notifyState() === 'granted') {
        try {
          new Notification(a.title || '鬼邮局 · 闹钟', { body: alarmBody(), tag: 'guiji-alarm-' + a.id });
        } catch (e) {}
      }
      toast((a.title || '闹钟') + '：' + (digestHeadline(d) || '该看待办了'));
      writeMorningReport(d);
    });
  }

  function renderMe() {
    $('#ai-state').textContent = ui.aiState;
    $('#me-items').textContent = db.items.length + ' 条';
    var mi = $('#me-install');
    if (mi) {
      var done = isStandalone() || inNativeApp();
      mi.textContent = inNativeApp() ? 'APP 版' : (done ? '已装好' : '点这里');
      mi.className = 'me-value ' + (done ? 'off' : 'on');
    }
    var rm = $('#me-remind');
    if (rm) {
      var on = db.alarms.filter(function (a) { return a.on; });
      rm.textContent = on.length
        ? on[0].hhmm + (on.length > 1 ? ' 等 ' + on.length + ' 个' : '')
        : '未设置';
      rm.className = 'me-value ' + (on.length ? 'on' : 'off');
    }
    var ver = $('#me-ver');
    if (ver) {
      var v = '';
      try {
        var el = document.querySelector('script[src*="app.js"]');
        var m = el && el.src ? el.src.match(/v=([a-z0-9]+)/i) : null;
        v = m ? m[1] : '';
      } catch (e) {}
      ver.textContent = v ? v.slice(-4) : '旧版';
      ver.className = 'me-value ' + (v ? 'off' : 'on');
    }

    // APP 版本：网页版没有这个概念，直接说清楚
    var av = $('#me-app-ver');
    if (av) {
      var u = ui.update;
      var txt, cls;
      if (!inNativeApp()) {
        txt = '网页版'; cls = 'off';
      } else if (u.state === 'downloading') {
        txt = 'v' + (appVersionName() || '—') + ' · 下载中 ' + Math.round(u.progress || 0) + '%'; cls = 'on';
      } else if (u.state === 'downloaded') {
        txt = 'v' + (appVersionName() || '—') + ' · 待安装'; cls = 'on';
      } else if (u.state === 'failed') {
        txt = 'v' + (appVersionName() || '—') + ' · 更新失败'; cls = 'off';
      } else if (u.latest && u.latest.versionCode > appVersionCode()) {
        txt = 'v' + (appVersionName() || '—') + ' · 有新版本'; cls = 'on';
      } else {
        txt = 'v' + (appVersionName() || '—') + (u.state === 'latest' ? ' · 最新' : ''); cls = 'off';
      }
      av.textContent = txt;
      av.className = 'me-value ' + cls;
    }

    var au = $('#autoupd-val');
    if (au) {
      var on = db.settings.autoUpdate !== false;
      au.textContent = on ? '已开启' : '已关闭';
      au.className = 'me-value ' + (on ? 'on' : 'off');
    }

    var sw = $('#swipe-val');
    if (sw) {
      sw.textContent = db.settings.swipeBack ? '已开启' : '已关闭';
      sw.className = 'me-value ' + (db.settings.swipeBack ? 'on' : 'off');
    }

    var stv = $('#swipe-tabs-val');
    if (stv) {
      stv.textContent = db.settings.swipeTabs ? '已开启' : '已关闭';
      stv.className = 'me-value ' + (db.settings.swipeTabs ? 'on' : 'off');
    }
  }

  /* 闹钟页 */
  function renderRemind() {
    var pv = $('#rm-perm-val');
    pv.textContent = notifyStateText();
    pv.className = 'me-value ' + (notifyState() === 'granted' || notifyState() === 'app' ? 'on' : 'off');

    // 自检区
    var nv = $('#rm-notif-val');
    if (nv) {
      var st = notifyState();
      nv.textContent = st === 'app' ? '应用内（系统通知）' :
        st === 'granted' ? '已允许' :
          st === 'denied' ? '被拦下了，点这里修' :
            st === 'unsupported' ? '网页版不支持' : '点这里开启';
      nv.className = 'me-value ' + (st === 'app' || st === 'granted' ? 'on' : 'off');
    }

    var lv = $('#rm-last-val');
    if (lv) {
      var fired = '';
      try { fired = inNativeApp() ? (window.GuijiApp.lastFired() || '') : ''; } catch (e) {}
      lv.textContent = fired || '还没响过';
    }

    var sv = $('#rm-sms-val');
    if (sv) {
      var on = false, num = '';
      try {
        if (inNativeApp()) {
          var raw = String(window.GuijiApp.smsState() || '0|');
          on = raw.charAt(0) === '1';
          num = raw.slice(2);
        }
      } catch (e) {}
      sv.textContent = !inNativeApp() ? '仅 APP 版' : (on ? '已开启' : '未开启');
      sv.className = 'me-value ' + (on ? 'on' : 'off');
      var ni = $('#rm-sms-num');
      if (ni && document.activeElement !== ni) ni.value = num;
    }

    var list = $('#alarm-list');
    if (!list) return;

    if (!db.alarms.length) {
      list.innerHTML = '<div class="alarm-empty">'
        + '<div class="alarm-empty-t">还没有闹钟</div>'
        + '<div class="alarm-empty-d">点下面的「+ 添加闹钟」，设一个每天几点提醒你看待办。'
        + '闹钟装在手机系统里，关掉 App 也会响。</div></div>';
    } else {
      list.innerHTML = db.alarms.slice().sort(function (a, b) {
        return String(a.hhmm) < String(b.hhmm) ? -1 : 1;
      }).map(function (a) {
        return '<div class="alarm-item' + (a.on ? '' : ' off') + '" data-id="' + a.id + '">'
          + '<div class="alarm-main" data-act="alarm-edit" data-id="' + a.id + '">'
          + '<div class="alarm-time">' + esc(a.hhmm) + '</div>'
          + '<div class="alarm-meta"><b>' + esc(a.title || '待办提醒') + '</b> · ' + alarmRepeatText(a.days) + '</div>'
          + '</div>'
          + '<div class="sw' + (a.on ? ' on' : '') + '" data-act="alarm-toggle" data-id="' + a.id + '"></div>'
          + '<div class="alarm-del" data-act="alarm-del" data-id="' + a.id + '">×</div>'
          + '</div>';
      }).join('');
    }
  }

  function openAlarmForm(alarm) {
    ui.editingAlarm = alarm || null;
    $('#alarm-form').hidden = false;
    $('#alarm-add').hidden = true;

    $('#af-time').value = alarm ? alarm.hhmm : '07:30';
    $('#af-title').value = alarm ? (alarm.title || '') : '';

    var days = alarm ? alarm.days : 127;
    $$('#af-repeat .chip').forEach(function (c) {
      c.classList.toggle('on', +c.getAttribute('data-days') === days);
    });
  }

  function closeAlarmForm() {
    ui.editingAlarm = null;
    $('#alarm-form').hidden = true;
    $('#alarm-add').hidden = false;
  }

  function saveAlarm() {
    var hhmm = String($('#af-time').value || '').trim();
    if (!/^\d{1,2}:\d{2}$/.test(hhmm)) { toast('先选个时间'); return; }

    var parts = hhmm.split(':');
    hhmm = pad(+parts[0]) + ':' + parts[1];

    var title = String($('#af-title').value || '').trim() || '待办提醒';
    var on = $('#af-repeat .chip.on');
    var days = on ? +on.getAttribute('data-days') : 127;

    var editing = ui.editingAlarm;
    if (editing) {
      var a = db.alarms.filter(function (x) { return x.id === editing.id; })[0];
      if (a) { a.hhmm = hhmm; a.title = title; a.days = days; a.on = true; }
    } else {
      // 同一时间只留一个
      var dup = db.alarms.filter(function (x) { return x.hhmm === hhmm; })[0];
      if (dup) { dup.title = title; dup.days = days; dup.on = true; }
      else {
        db.alarms.push({ id: uid(), hhmm: hhmm, title: title, days: days, on: true });
      }
    }

    syncSettingsFromAlarms();
    save();
    syncAlarms();
    closeAlarmForm();
    renderRemind();
    renderMe();
    toast('闹钟已设：' + hhmm + ' · ' + alarmRepeatText(days));
  }

  /* 首页卡片沿用最早的那个闹钟时间 */
  function syncSettingsFromAlarms() {
    var on = db.alarms.filter(function (a) { return a.on; })
      .sort(function (a, b) { return String(a.hhmm) < String(b.hhmm) ? -1 : 1; });
    db.settings.remindEnabled = on.length > 0;
    if (on.length) db.settings.remindAt = on[0].hhmm;
  }

  function askNotifyPermission() {
    var st = notifyState();

    // APP 版：通知由原生发，这里只负责把闹钟排进系统
    if (st === 'app') {
      syncAlarms();
      var on = db.alarms.filter(function (a) { return a.on; });
      toast(on.length ? '已交给系统闹钟，共 ' + on.length + ' 个' : '先加一个闹钟吧');
      return;
    }

    if (st === 'unsupported') {
      toast('网页版不支持系统通知，用 APP 版或加日历闹钟');
      return;
    }
    if (st === 'denied') {
      toast('已被浏览器拦下，去浏览器设置里放开');
      return;
    }
    if (st === 'granted') {
      toast('已经开启了');
      return;
    }
    try {
      Notification.requestPermission().then(function (p) {
        renderRemind();
        toast(p === 'granted' ? '通知已开启' : '没开成，提醒仍会在首页显示');
      });
    } catch (e) {
      toast('网页版不支持系统通知，用 APP 版或加日历闹钟');
    }
  }

  function renderLibrary() {
    var list = $('#lib-list');
    var items = db.items.filter(function (i) {
      if (ui.libFilter === 'all') return true;
      if (ui.libFilter === 'file') return i.kind === 'file' || i.kind === 'pdf';
      return i.kind === ui.libFilter;
    });
    if (!items.length) {
      list.innerHTML = '<div class="empty"><div class="empty-title">这里还没有内容</div></div>';
      return;
    }
    list.innerHTML = items.map(function (i) {
      var color = i.kind === 'image' ? 'amber' : i.kind === 'text' ? '' : 'blue';
      return '<div class="row" data-act="open-item" data-id="' + i.id + '">'
        + '<div class="dot ' + color + '"></div>'
        + '<div class="row-body"><div class="row-title">' + esc(i.title) + '</div>'
        + '<div class="row-meta">' + relTime(i.createdAt) + ' · ' + (i.degraded ? '本地提取' : 'AI 分析') + '</div></div>'
        + '<div class="row-chev">›</div></div>';
    }).join('');
  }

  /* ---------------- 待办汇总（时间表）---------------- */
  /* 把 todos 和 reminders 统一成一种节点，才好放在同一条时间轴上 */
  function collectNodes() {
    var nodes = [];

    db.todos.forEach(function (t) {
      if (t.pendingDelete) return;
      nodes.push({
        id: t.id,
        src: 'todo',
        title: t.title,
        dueDate: t.dueDate || null,
        done: !!t.done,
        important: !!t.important,
        repeat: t.repeat || 'none',
        createdAt: t.createdAt || ''
      });
    });
    db.reminders.forEach(function (r) {
      if (r.pendingDelete) return;
      nodes.push({
        id: r.id,
        src: 'due',
        title: r.title,
        dueDate: r.dueDate || null,
        done: !!r.confirmed,
        important: !!r.important,
        repeat: 'none',
        createdAt: r.createdAt || ''
      });
    });

    // 有截止日的按日期排，没日期的按创建时间排在最后
    nodes.sort(function (a, b) {
      var ad = a.dueDate || '9999-99-99';
      var bd = b.dueDate || '9999-99-99';
      if (ad !== bd) return ad < bd ? -1 : 1;
      return String(a.createdAt) < String(b.createdAt) ? -1 : 1;
    });
    return nodes;
  }

  /* 分组：逾期 / 今天 / 明天 / 三天内 / 本周内 / 更晚 / 没有截止日 */
  var TL_BUCKETS = [
    { key: 'overdue', title: '已逾期', cls: 'red' },
    { key: 'today', title: '今天', cls: '' },
    { key: 'tomorrow', title: '明天', cls: '' },
    { key: 'soon', title: '三天内', cls: '' },
    { key: 'week', title: '本周内', cls: '' },
    { key: 'later', title: '更晚', cls: 'mute' },
    { key: 'nodate', title: '没有截止日', cls: 'mute' }
  ];

  function bucketOf(node) {
    var d = dayDiff(node.dueDate);
    if (d === null) return 'nodate';
    if (d < 0) return 'overdue';
    if (d === 0) return 'today';
    if (d === 1) return 'tomorrow';
    if (d <= 3) return 'soon';
    if (d <= 7) return 'week';
    return 'later';
  }

  function renderTodos() {
    var all = collectNodes();
    var open = all.filter(function (n) { return !n.done; });
    var done = all.filter(function (n) { return n.done; });

    // 顶部进度
    var total = all.length;
    var pct = total ? Math.round(done.length / total * 100) : 0;
    var overdueCount = open.filter(function (n) { return bucketOf(n) === 'overdue'; }).length;
    var todayCount = open.filter(function (n) { return bucketOf(n) === 'today'; }).length;
    var impCount = open.filter(function (n) { return n.important; }).length;

    var sub = $('#todo-sub');
    if (sub) {
      sub.textContent = total
        ? '共 ' + total + ' 项，' + open.length + ' 项还没完成'
          + (impCount ? '，' + impCount + ' 件重要' : '')
        : '按时间排好，到点提醒你';
    }

    $('#todo-sum').innerHTML =
      '<div class="tl-sum">'
      + '<div class="tl-sum-top"><span class="tl-sum-lab">完成进度</span>'
      + '<span class="tl-sum-num">' + done.length + '<span class="tl-sum-total"> / ' + total + '</span></span></div>'
      + '<div class="bar"><i class="' + (pct === 100 && total ? 'full' : '') + '" style="width:' + pct + '%"></i></div>'
      + '<div class="tl-sum-meta">'
      + (total
        ? ('今天 ' + todayCount + ' 项' + (overdueCount ? ' · <span class="warn">已逾期 ' + overdueCount + ' 项</span>' : '')
          + (impCount ? ' · <span class="imp">重要 ' + impCount + ' 项</span>' : ''))
        : '还没有待办，从「+」发进来就会自动整理')
      + '</div></div>';

    // 按筛选决定显示哪些
    var f = ui.todoFilter || 'all';
    var shown = f === 'done' ? done
      : f === 'overdue' ? open.filter(function (n) { return bucketOf(n) === 'overdue'; })
        : f === 'open' ? open
          : f === 'important' ? open.filter(function (n) { return n.important; })
            : open;

    var html = '';

    if (f === 'all' || f === 'open' || f === 'overdue' || f === 'important') {
      var groups = {};
      shown.forEach(function (n) {
        var k = bucketOf(n);
        if (!groups[k]) groups[k] = [];
        groups[k].push(n);
      });

      TL_BUCKETS.forEach(function (b) {
        var list = groups[b.key];
        if (!list || !list.length) return;
        // 同一组里，重要的排前面
        list.sort(function (a, c) { return (c.important ? 1 : 0) - (a.important ? 1 : 0); });
        html += renderTlGroup(b.title, b.cls, list, b.key === 'overdue');
      });

      if (!shown.length) {
        html += '<div class="tl-empty"><div class="tl-empty-title">'
          + (f === 'overdue' ? '没有逾期的事' : (f === 'important' ? '还没有重要的事' : '没有待办'))
          + '</div><div class="tl-empty-desc">'
          + (f === 'overdue' ? '保持住。'
            : (f === 'important' ? '左滑一条待办就能把它标成重要。'
              : '点右下角的「+」，把文件和文字发进来，AI 会顺手把要做的事挑出来。'))
          + '</div></div>';
      }
    }

    // 已完成永远放最后，默认收起来
    if ((f === 'all' || f === 'done') && done.length) {
      var doneOpen = ui.doneExpanded || f === 'done';
      html += renderTlGroup('已完成', 'mute', done, false, true, doneOpen);
      if (f === 'done' && !done.length) {
        html += '<div class="tl-empty"><div class="tl-empty-title">还没有完成的</div></div>';
      }
    }

    $('#todo-timeline').innerHTML = html;
    ui.openRow = null;          // 重绘以后旧的滑动位置就没了
    renderSelBar();
  }

  function renderTlGroup(title, cls, list, isOverdue, isDoneGroup, expanded) {
    var sel = ui.select;
    var rows = list.map(function (n) {
      var d = dayDiff(n.dueDate);
      var clsName = 'tl-item' + (n.done ? ' isdone' : '')
        + (d !== null && d < 0 && !n.done ? ' past' : '')
        + (n.important ? ' imp' : '');
      var dateHtml = '';
      if (n.dueDate) {
        var p = String(n.dueDate).split('-');
        var dt = parseDate(n.dueDate);
        var wd = dt ? '周' + '日一二三四五六'.charAt(dt.getDay()) : '';
        dateHtml = '<span class="tl-date' + (d !== null && d < 0 && !n.done ? ' red' : '') + '">'
          + '<span class="d-num">' + (+p[1]) + '/' + (+p[2]) + '</span>' + wd + '</span>';
      } else {
        dateHtml = '<span class="tl-date">—</span>';
      }

      var meta = [];
      if (n.dueDate) {
        meta.push(shortDate(n.dueDate) + ' 截止');
        var dtxt = daysText(d);
        if (dtxt) meta.push('<span class="' + (d !== null && d < 0 && !n.done ? 'warn' : '') + '">' + dtxt + '</span>');
      } else {
        meta.push('没有截止日');
      }
      meta.push(n.src === 'due' ? '<span class="tag tag-amber">到期事项</span>' : '<span class="tag tag-gray">待办</span>');
      if (n.important) meta.push('<span class="tag tag-imp">重要</span>');
      if (n.repeat && n.repeat !== 'none') meta.push('<span class="tag tag-blue">' + repeatText(n.repeat) + '</span>');

      var act = n.src === 'due' ? 'data-act="toggle-due" data-id="' + n.id + '"'
        : 'data-act="toggle-todo" data-id="' + n.id + '"';

      var picked = sel.on && sel.ids[n.src + ':' + n.id];

      // 左边三个操作按钮，左滑才露出来
      var actions = ''
        + '<div class="tl-actions">'
        + '<div class="tl-act tl-act-done" data-act="tl-done" data-id="' + n.id + '" data-src="' + n.src + '">'
        + '<span class="ta-ic">✓</span><span>完成</span></div>'
        + '<div class="tl-act tl-act-star' + (n.important ? ' on' : '') + '" data-act="tl-star" data-id="' + n.id + '" data-src="' + n.src + '">'
        + '<span class="ta-ic">★</span><span>' + (n.important ? '取消' : '重要') + '</span></div>'
        + '<div class="tl-act tl-act-del" data-act="tl-del" data-id="' + n.id + '" data-src="' + n.src + '">'
        + '<span class="ta-ic">×</span><span>删除</span></div>'
        + '</div>';

      var tail = sel.on
        ? '<div class="tl-check"><div class="tl-pick' + (picked ? ' on' : '') + '"></div></div>'
        : '<div class="tl-check" data-act="check-' + (n.src === 'due' ? 'due' : 'todo') + '"'
        + ' data-id="' + n.id + '" data-src="' + n.src + '">'
        + '<div class="check' + (n.done ? ' on' : '') + (n.important && !n.done ? ' imp' : '') + '"></div></div>';

      var calBtn = n.dueDate
        ? '<span class="tl-cal" data-act="tl-cal" data-id="' + n.id + '" data-src="' + n.src + '">加日历</span>'
        : '';

      return '<div class="tl-wrap" data-id="' + n.id + '" data-src="' + n.src + '">'
        + actions
        + '<div class="' + clsName + '" ' + act + '>'
        + '<div class="tl-rail">' + dateHtml + '</div>'
        + '<div class="tl-body">'
        + '<div class="tl-title' + (n.done ? ' done' : '') + '">' + (n.important ? '<span class="tl-star">★</span>' : '') + esc(n.title) + '</div>'
        + '<div class="tl-meta">' + meta.join(' · ') + (calBtn ? ' · ' + calBtn : '') + '</div>'
        + '</div>'
        + tail
        + '</div>'
        + '</div>';
    }).join('');

    var head = '<div class="tl-head"'
      + (isDoneGroup ? ' data-act="toggle-done-group"' : '') + '>'
      + '<span class="tl-day ' + (cls || '') + '">' + title + '</span>'
      + '<span class="tl-count">' + list.length + ' 项</span>'
      + (isDoneGroup ? '<span class="tl-chev">' + (expanded ? '▾' : '▸') + '</span>' : '')
      + '</div>';

    return '<div class="tl-group' + (isDoneGroup ? ' tl-done-group' : '') + '">'
      + head
      + '<div class="tl-items"' + (isDoneGroup && !expanded ? ' hidden' : '') + '>' + rows + '</div></div>';
  }

  function repeatText(r) {
    if (r === 'daily') return '每天';
    if (r === 'weekly') return '每周';
    if (r === 'monthly') return '每月';
    if (r === 'workday') return '工作日';
    return '';
  }

  /* ---------------- 多选 ---------------- */
  function selKey(src, id) { return src + ':' + id; }

  function renderSelBar() {
    var bar = $('#selbar');
    if (!bar) return;
    var n = Object.keys(ui.select.ids).length;
    bar.hidden = !ui.select.on;
    if (ui.select.on) {
      var c = $('#sel-count');
      if (c) c.textContent = '已选 ' + n + ' 项';
    }
  }

  function enterSelectMode() {
    ui.select.on = true;
    renderSelBar();
    renderTodos();
  }

  function exitSelectMode() {
    ui.select.on = false;
    ui.select.ids = {};
    renderSelBar();
    renderTodos();
  }

  function toggleSelect(src, id) {
    var k = selKey(src, id);
    if (ui.select.ids[k]) delete ui.select.ids[k];
    else ui.select.ids[k] = true;
    renderSelBar();
    renderTodos();
  }

  function selectedNodes() {
    var out = [];
    collectNodes().forEach(function (n) {
      if (ui.select.ids[selKey(n.src, n.id)]) out.push(n);
    });
    return out;
  }

  /* ---------------- 撤销期删除 ---------------- */
  var deleteTimers = {};

  function nodeRecord(src, id) {
    var list = src === 'todo' ? db.todos : db.reminders;
    return list.filter(function (x) { return x.id === id; })[0];
  }

  function deleteNodeWithUndo(src, id) {
    var rec = nodeRecord(src, id);
    if (!rec) return;
    rec.pendingDelete = true;                       // 行立刻消失
    save();
    renderTodos();
    renderHome();
    syncImportantAlarms();

    var key = selKey(src, id);
    clearTimeout(deleteTimers[key]);
    deleteTimers[key] = setTimeout(function () {    // 5 秒后才真删
      deleteTimers[key] = null;
      if (!rec.pendingDelete) return;
      if (src === 'todo') db.todos = db.todos.filter(function (x) { return x.id !== id; });
      else db.reminders = db.reminders.filter(function (x) { return x.id !== id; });
      save();
      syncImportantAlarms();
    }, 5000);

    toast('已删除', {
      action: '撤销', ms: 5000,
      onAction: function () { undoDelete(src, id); }
    });
  }

  function undoDelete(src, id) {
    var key = selKey(src, id);
    clearTimeout(deleteTimers[key]);
    deleteTimers[key] = null;
    var rec = nodeRecord(src, id);
    if (!rec) return;
    rec.pendingDelete = false;
    save();
    renderTodos();
    renderHome();
    syncImportantAlarms();
    toast('已撤销');
  }

  /* ---------------- 标重要 ---------------- */
  function markImportant(src, id, on) {
    var rec = nodeRecord(src, id);
    if (!rec) return;
    rec.important = !!on;
    save();
    syncImportantAlarms();
    renderTodos();
    renderHome();
    if (ui.tab === 'me') renderMe();
    toast(rec.important ? '标成重要了，到期当天 09:30 提醒你' : '取消重要');
  }

  /* ---------------- 重要任务的一次性闹钟 ---------------- */
  /* 单独放 db.once，不进 db.alarms —— 免得把早报时间顶掉，也免得跟别的闹钟撞 */
  function syncImportantAlarms() {
    if (!db.once) db.once = {};
    var hhmm = db.settings.importantAt || '09:30';
    var now = Date.now();
    var today = todayStr();
    var want = {};

    db.todos.forEach(function (t) {
      if (!t.important || t.done || t.pendingDelete || !t.dueDate) return;
      var k = t.id + '@' + t.dueDate;
      if (db.once[k]) { want[k] = db.once[k]; return; }
      var when = atOnDay(t.dueDate, hhmm);
      if (when.getTime() <= now) {
        if (t.dueDate < today) return;              // 已经逾期，不补闹钟
        when = new Date(now + 60000);                // 今天 9:30 已过，60 秒后补一次
      }
      var rec = {
        key: k, todoId: t.id, dueDate: t.dueDate,
        whenMs: when.getTime(), nativeId: 'imp-' + t.id,
        title: '重要：' + t.title, body: '今天到期，别忘了。', fired: false
      };
      db.once[k] = rec;
      want[k] = rec;
    });

    // 不再需要的（完成了 / 取消重要了 / 删了 / 改期了）统统撤掉
    Object.keys(db.once).forEach(function (k) {
      if (want[k]) return;
      var old = db.once[k];
      if (inNativeApp() && window.GuijiApp.cancelAlarmAt) {
        try { window.GuijiApp.cancelAlarmAt(old.nativeId); } catch (e) {}
      }
      delete db.once[k];
    });

    // 重新登记一遍（原生那边同 id 覆盖，幂等）
    Object.keys(want).forEach(function (k) {
      var rec = want[k];
      if (inNativeApp() && window.GuijiApp.setAlarmAt) {
        try { window.GuijiApp.setAlarmAt(rec.nativeId, rec.whenMs, rec.title, rec.body); } catch (e) {}
      }
    });

    // 过期记录别攒太多
    var cut = now - 30 * 24 * 3600 * 1000;
    Object.keys(db.once).forEach(function (k) {
      if (db.once[k].whenMs < cut) delete db.once[k];
    });

    save();
  }

  /* 网页版没有原生闹钟，就在页面开着的时候到点弹一下 */
  function tickImportantWeb() {
    if (inNativeApp()) return;
    if (!db.once) return;
    var now = Date.now();
    Object.keys(db.once).forEach(function (k) {
      var rec = db.once[k];
      if (rec.fired || !rec.whenMs) return;
      if (now < rec.whenMs) return;
      if (now - rec.whenMs > 3600000) { rec.fired = true; save(); return; }  // 太久以前的就不补了
      rec.fired = true;
      save();
      toast(rec.title);
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(rec.title, { body: rec.body, icon: '/assets/icon-192.png' });
        }
      } catch (e) {}
    });
  }

  function renderItem(id) {
    var item = db.items.filter(function (i) { return i.id === id; })[0];
    if (!item) { toast('内容不见了'); return; }
    ui.currentItem = item;

    var h = '';
    h += '<div class="item-title">' + esc(item.title) + '</div>';
    h += '<div class="item-meta">' + relTime(item.createdAt) + ' · ' + esc(item.source || '')
      + (item.sizeLabel ? ' · ' + esc(item.sizeLabel) : '')
      + (item.degraded ? ' · 本地提取' : '') + '</div>';

    if (item.url) {
      h += '<a class="src-link" href="' + esc(item.url) + '" target="_blank" rel="noopener noreferrer">'
        + '打开原文 <span class="src-host">' + esc(item.url.replace(/^https?:\/\//, '').split('/')[0]) + '</span> ›</a>';
    }

    if (item.summary) {
      h += '<div class="block"><div class="block-title">摘要</div>'
        + '<div class="summary-text">' + esc(item.summary) + '</div></div>';
    }

    if (item.seen && item.seen.length) {
      h += '<div class="block"><div class="block-title">看到了什么</div><div class="card card-pad">';
      item.seen.forEach(function (s, i) {
        h += '<div class="seen-row"><div class="seen-idx">' + (i + 1) + '</div>'
          + '<div class="seen-text">' + esc(s) + '</div></div>';
      });
      h += '</div></div>';
    }

    if (item.numbers && item.numbers.length) {
      h += '<div class="block"><div class="block-title">关键数字</div><div class="card card-pad">';
      item.numbers.forEach(function (n) {
        h += '<div class="num-row"><div class="num-label">' + esc(n.label) + '</div>'
          + '<div class="num-value">' + esc(n.value) + '</div></div>';
      });
      h += '</div></div>';
    }

    if (item.risks && item.risks.length) {
      h += '<div class="block"><div class="block-title">风险与注意</div><div class="card card-pad">';
      item.risks.forEach(function (r) {
        var cls = r.level === 'high' ? 'risk-high' : r.level === 'low' ? 'risk-low' : 'risk-medium';
        h += '<div class="risk-row"><div class="risk-level ' + cls + '"></div>'
          + '<div class="risk-text">' + esc(r.text) + '</div></div>';
      });
      h += '</div></div>';
    }

    if (item.todos && item.todos.length) {
      h += '<div class="block"><div class="block-title">提取出的待办</div><div class="card card-pad">';
      item.todos.forEach(function (t) {
        h += '<div class="row"><div class="check"></div>'
          + '<div class="row-body"><div class="row-title">' + esc(t.title) + '</div>'
          + '<div class="row-meta">' + (t.dueDate ? shortDate(t.dueDate) + ' 到期' : '没有截止日') + '</div></div></div>';
      });
      h += '<div class="mini-btn" data-act="item-ics" data-id="' + esc(item.id) + '">写进手机日历</div>';
      h += '</div></div>';
    }

    if (item.pdfText) {
      var cut = item.pdfChars && item.pdfChars > item.pdfText.length;
      h += '<div class="block"><div class="block-title">原文节选</div>'
        + '<div class="pdf-text">' + esc(item.pdfText)
        + (cut ? '\n\n…… 共 ' + item.pdfChars + ' 字，这里只放了开头 ' + item.pdfText.length + ' 字' : '')
        + '</div></div>';
    }

    if (item.dues && item.dues.length) {
      h += '<div class="block"><div class="block-title">识别到的到期日（待确认）</div><div class="card card-pad">';
      item.dues.forEach(function (d) {
        h += '<div class="row"><div class="dot amber"></div>'
          + '<div class="row-body"><div class="row-title">' + esc(d.title) + '</div>'
          + '<div class="row-meta">' + shortDate(d.date) + ' · ' + daysText(dayDiff(d.date)) + '</div></div></div>';
      });
      h += '</div></div>';
    }

    $('#item-body').innerHTML = h;
    showScreen('item', { sub: true });
  }

  function renderReport(id) {
    var r = db.reports.filter(function (x) { return x.id === id; })[0];
    if (!r) return;
    ui.currentReport = r;
    if (r.unread) { r.unread = false; save(); }

    var body = r.body || {};
    var h = '<div class="item-title">' + esc(r.title) + '</div>';
    h += '<div class="item-meta">' + esc(body.headline || '') + '</div>';

    (body.sections || []).forEach(function (sec) {
      h += '<div class="report-sec"><div class="report-sec-title">' + esc(sec.title) + '</div>';
      (sec.lines || []).forEach(function (line) {
        h += '<div class="report-li">' + esc(line) + '</div>';
      });
      h += '</div>';
    });

    if (!(body.sections || []).length) {
      h += '<div class="empty"><div class="empty-title">这一天没有要汇总的内容</div></div>';
    }

    $('#report-body').innerHTML = h;
    showScreen('report', { sub: true });
  }

  /* ---------------- 路由 ---------------- */
  var SUB_SCREENS = ['item', 'library', 'report', 'remind', 'install'];
  var TAB_ORDER = ['home', 'todos', 'reports', 'me'];
  var animating = false;

  function renderTab(name) {
    if (name === 'home') renderHome();
    else if (name === 'todos') renderTodos();
    else if (name === 'reports') renderReports();
    else if (name === 'me') renderMe();
  }

  function showScreen(name, opts) {
    var isSub = opts && opts.sub;
    var from = opts && opts.from;
    var target = $('#s-' + name);
    if (!target) return;

    $$('.screen').forEach(function (s) { s.hidden = true; });
    target.hidden = false;
    ui.screen = name;

    var tabbar = $('#tabbar');
    var fab = $('#fab');

    if (isSub) {
      tabbar.hidden = true;
      fab.hidden = true;
    } else {
      tabbar.hidden = false;
      fab.hidden = name === 'me';
      $$('.tab').forEach(function (t) {
        t.classList.toggle('on', t.getAttribute('data-tab') === name);
      });
      ui.tab = name;
    }

    window.scrollTo(0, 0);
    if (from) playEnter(target, from);
  }

  /* 新页面从侧边滑入。from='right' 表示从右边进来（用户向左滑） */
  function playEnter(el, from) {
    animating = true;
    var off = from === 'right' ? 100 : -100;
    el.style.transition = 'none';
    el.style.transform = 'translateX(' + off + '%)';
    el.style.opacity = '0.4';

    void el.offsetWidth;   // 先让起始状态落地，否则不会有过渡

    el.style.transition = 'transform .26s cubic-bezier(.32,.72,0,1), opacity .2s ease';
    el.style.transform = '';
    el.style.opacity = '';

    setTimeout(function () {
      el.style.transition = '';
      el.style.transform = '';
      el.style.opacity = '';
      animating = false;
    }, 280);
  }

  function goBack() {
    showScreen(ui.tab || 'home');
    if (ui.tab === 'home') renderHome();
    if (ui.tab === 'todos') renderTodos();
    if (ui.tab === 'reports') renderReports();
    if (ui.tab === 'me') renderMe();
  }

  function openItem(id) { renderItem(id); }
  function openReport(id) { renderReport(id); }

  function openTodos() {
    renderTodos();
    showScreen('todos');
  }

  function switchTab(name, from) {
    if (TAB_ORDER.indexOf(name) < 0) return;
    if (name === ui.screen) {
      renderTab(name);
      window.scrollTo(0, 0);
      return;
    }
    renderTab(name);
    showScreen(name, from ? { from: from } : null);
  }

  /* ---------------- 手势：右滑返回（任何位置） + 板块左右切换 ---------------- */
  var SUB_SWIPE = ['item', 'library', 'report', 'remind', 'install', 'update'];
  var vp = { w: 375, h: 667 };
  var gesture = null;
  var swallowClick = false;

  /* 待办行的左滑操作 */
  var SWIPE = {
    LOCK_X: 6, DEAD_Y: 10, LOCK_RATIO: 1.15,
    ROW_OPEN_RATIO: 0.42,     // 滑过按钮区 42% 就吸附打开
    ROW_ACTIONS_W: 186,       // 三个按钮的总宽
    ROW_RIGHT_X: 24,          // 往右滑过这个距离就交还给翻页
    LONG_PRESS_MS: 520,       // 长按多久进多选
    PRESS_MOVE: 12            // 长按期间允许晃多少
  };
  var rowSwallowUntil = 0;    // 手势刚结束的一小段时间，吞掉误触的点击
  var rowSwallowKey = '';     // 只吞这一行上的点击，别误伤别的按钮
  var pressTimer = null, pressInfo = null;

  /* 点到这一行上时，把这次点击吞掉 */
  function swallowRowClick(key, ms) {
    rowSwallowUntil = Date.now() + (ms || 200);
    rowSwallowKey = key || '';
  }

  function inSwallowedRow(target) {
    if (!rowSwallowKey || !target || !target.closest) return false;
    var wrap = target.closest('.tl-wrap');
    if (!wrap) return false;
    return selKey(wrap.getAttribute('data-src'), wrap.getAttribute('data-id')) === rowSwallowKey;
  }

  /* 当前打开着的那一行 */
  function openRow(wrap) {
    if (!wrap) return;
    if (ui.openRow && ui.openRow !== wrap) closeRow();
    var el = wrap.querySelector('.tl-item');
    if (!el) return;
    ui.openRow = wrap;
    el.style.transition = 'transform .22s cubic-bezier(.22,.61,.36,1)';
    el.style.transform = 'translateX(-' + SWIPE.ROW_ACTIONS_W + 'px)';
    setTimeout(function () { el.style.transition = ''; }, 240);
  }

  function closeRow() {
    if (!ui.openRow) return;
    var el = ui.openRow.querySelector('.tl-item');
    ui.openRow = null;
    if (!el) return;
    resetRowItem(el);
  }

  /* 把一行弹回原位 */
  function resetRowItem(el) {
    el.style.transition = 'transform .2s cubic-bezier(.22,.61,.36,1)';
    el.style.transform = '';
    setTimeout(function () { el.style.transition = ''; }, 220);
  }

  /* 长按：进多选 */
  function pressBegin(x, y, target) {
    pressCancel();
    if (!target || !target.closest) return;
    if (!target.closest('.tl-item')) return;
    pressInfo = { x: x, y: y, target: target };
    pressTimer = setTimeout(function () {
      pressTimer = null;
      var t = pressInfo && pressInfo.target;
      if (!t || !t.closest) return;
      var item = t.closest('.tl-item');
      if (!item) return;
      var wrap = item.closest('.tl-wrap');
      if (!wrap) return;
      swallowRowClick(selKey(wrap.getAttribute('data-src'), wrap.getAttribute('data-id')), 600);
      if (!ui.select.on) enterSelectMode();
      toggleSelect(wrap.getAttribute('data-src'), wrap.getAttribute('data-id'));
    }, SWIPE.LONG_PRESS_MS);
  }

  function pressCancel() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    pressInfo = null;
  }

  function pressMoved(x, y) {
    if (!pressInfo) return;
    if (Math.abs(x - pressInfo.x) > SWIPE.PRESS_MOVE ||
        Math.abs(y - pressInfo.y) > SWIPE.PRESS_MOVE) pressCancel();
  }

  function measureVp() {
    vp.w = window.innerWidth || document.documentElement.clientWidth || 375;
    vp.h = window.innerHeight || document.documentElement.clientHeight || 667;
  }

  /* 返回手势：在子页面的任何位置往右滑就返回，不限起手位置。
     只要是这四级子页（item / library / report / remind / install / update），
     往右滑就是「回上一级」；往左滑只有橡皮筋，不做任何事。
     竖向滚动不受影响——方向锁里 |dy| >= |dx| 会优先判给页面滚动。 */

  function noSwipeTarget(node) {
    if (!node || !node.closest) return false;
    return !!node.closest('input, textarea, select, video, iframe, #sheet, #mask, #loading');
  }

  function gestureStart(x, y, node, pointerType) {
    gesture = null;
    if (animating) return;
    if (noSwipeTarget(node)) return;

    /* 待办行的左滑：先于板块切换判定。命中就直接接管，板块手势不参与，
       这样在待办上往左拖不会把页面切到「报告」。 */
    if (node && node.closest && !ui.select.on && ui.screen === 'todos') {
      if (!node.closest('.tl-actions')) {
        var wrap = node.closest('.tl-wrap');
        var item = wrap && wrap.querySelector('.tl-item');
        if (wrap && item) {
          gesture = {
            mode: 'row', rowEl: wrap, el: item, screenEl: $('#s-' + ui.screen),
            x0: x, y0: y, t0: Date.now(),
            lastX: x, lastT: Date.now(), vx: 0, dx: 0,
            dead: false, lock: false, dir: 0
          };
          item.style.transition = 'none';
          return;
        }
      }
    }

    var sub = SUB_SWIPE.indexOf(ui.screen) >= 0;
    var mode = '';

    if (sub) {
      /* 桌面上用返回按钮，鼠标拖拽容易和选文字打架 */
      if (pointerType === 'mouse') return;
      if (!db.settings.swipeBack) return;
      mode = 'back';
    } else {
      if (!db.settings.swipeTabs || TAB_ORDER.indexOf(ui.screen) < 0) return;
      mode = 'tab';
    }

    var el = $('#s-' + ui.screen);
    if (!el) return;

    gesture = {
      mode: mode, x0: x, y0: y, t0: Date.now(),
      lastX: x, lastT: Date.now(), vx: 0,
      dx: 0, el: el, dead: false, lock: false,
      to: null, toName: '', base: 0, dir: 0, edge: false, hinted: ''
    };
    el.style.transition = 'none';
  }

  /* 把目标页挂到当前页下面，两页一起动 —— 这是「跟手」的关键 */
  function mountPane(g, dir) {
    var idx = TAB_ORDER.indexOf(ui.screen);
    var next = idx + (dir < 0 ? 1 : -1);
    if (next < 0 || next >= TAB_ORDER.length) { g.edge = true; return; }

    var name = TAB_ORDER[next];
    renderTab(name);

    var to = $('#s-' + name);
    if (!to) { g.edge = true; return; }

    var base = dir < 0 ? vp.w : -vp.w;

    to.hidden = false;
    to.classList.add('pane-behind');
    to.style.transition = 'none';
    to.style.transform = 'translateX(' + base + 'px)';

    g.to = to;
    g.toName = name;
    g.base = base;
    g.dir = dir;

    g.el.style.position = 'relative';
    g.el.style.zIndex = '2';
    g.el.style.background = '#F5F6F8';
    g.el.style.boxShadow = '0 0 26px rgba(15, 23, 42, .12)';
    g.el.style.willChange = 'transform';
    document.body.classList.add('pager-drag');
  }

  /* 跟着手指预切 tab 高亮，让人在滑到一半时就知道要去哪 */
  function hintTab(name) {
    $$('.tab').forEach(function (t) {
      t.classList.toggle('on', t.getAttribute('data-tab') === name);
    });
  }

  function gestureMove(x, y) {
    var g = gesture;
    if (!g || g.dead) return;

    var dx = x - g.x0;
    var dy = y - g.y0;
    var now = Date.now();

    /* 瞬时速度做平滑，松手时用来判定惯性 */
    var dt = Math.max(1, now - g.lastT);
    g.vx = g.vx * 0.55 + ((x - g.lastX) / dt) * 0.45;
    g.lastX = x;
    g.lastT = now;

    /* 行内左滑：自己一套方向锁和跟手，不走板块逻辑 */
    if (g.mode === 'row') {
      if (!g.lock) {
        if (Math.abs(dy) > SWIPE.DEAD_Y && Math.abs(dy) >= Math.abs(dx)) {
          g.dead = true;              // 竖着划 → 交还给页面滚动
          g.el.style.transition = '';
          return;
        }
        if (Math.abs(dx) > SWIPE.LOCK_X && Math.abs(dx) > Math.abs(dy) * SWIPE.LOCK_RATIO) {
          g.lock = true;
          g.dir = dx < 0 ? -1 : 1;
        } else return;
      }
      g.dx = dx;

      /* 往右滑 = 翻到上一块，跟行操作一点关系没有
         （以前这里是「右滑完成任务」，跟翻页撞车才误触的） */
      if (g.dir > 0) {
        if (dx > SWIPE.ROW_RIGHT_X) {
          handoffToPager(g, 1);
        } else {
          g.el.style.transform = 'translateX(' + Math.min(dx * 0.12, 18).toFixed(1) + 'px)';
          return;
        }
      } else {
        /* 往左滑：一律是这一行的操作，开出完成 / 重要 / 删除 */
        var base = (ui.openRow === g.rowEl) ? -SWIPE.ROW_ACTIONS_W : 0;
        var pos = base + dx;
        var ax = pos;
        if (base !== 0 && pos < base) ax = base + (pos - base) * 0.35;  // 已经打开还往左拉：橡皮筋
        g.el.style.transform = 'translateX(' + ax.toFixed(1) + 'px)';
        return;
      }
      /* 到这里说明手势已经交给板块翻页，接着走下面的逻辑 */
    }

    /* 先分清横竖：竖着划是滚页面，立刻退出，别抢 */
    if (!g.lock) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {
        g.dead = true;
        g.el.style.transition = '';
        return;
      }
      if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy) * 1.15) {
        g.lock = true;
        if (g.mode === 'tab') mountPane(g, dx < 0 ? -1 : 1);
      } else {
        return;
      }
    }

    g.dx = dx;
    var ax = dx;

    if (g.mode === 'back') {
      /* 这个手势只认向右；向左给一点橡皮筋，不跟手 */
      ax = dx > 0 ? dx * 0.55 : Math.max(dx * 0.12, -18);
    } else if (g.edge) {
      ax = dx * 0.22;                       /* 第一页/最后一页，拉不动 */
    } else if (g.dir && dx * g.dir < 0) {
      ax = Math.max(-10, Math.min(10, dx * 0.1));   /* 反向拖：几乎不动 */
    }

    g.el.style.transform = 'translateX(' + ax.toFixed(1) + 'px)';
    if (g.to) g.to.style.transform = 'translateX(' + (g.base + ax).toFixed(1) + 'px)';

    if (g.mode === 'tab' && g.to && Math.abs(ax) > vp.w * 0.5 && g.hinted !== g.toName) {
      g.hinted = g.toName;
      hintTab(g.toName);
    } else if (g.mode === 'tab' && g.hinted && Math.abs(ax) <= vp.w * 0.5) {
      g.hinted = '';
      hintTab(ui.screen);
    }
  }

  function gestureEnd() {
    var g = gesture;
    gesture = null;
    if (!g) return;

    /* 只是点了一下，或者竖着划：什么都不用做。
       注意这里【不能】吞点击——普通点按要让勾选圈、加日历、整行完成都正常工作。
       只有真的滑动了（下面 lock 的分支）才需要吞。 */
    if (g.dead || !g.lock) {
      g.el.style.transition = '';
      g.el.style.transform = '';
      return;
    }

    if (g.mode === 'row') { settleRow(g); return; }

    var dt = Math.max(24, Date.now() - g.t0);
    var idle = Date.now() - (g.lastT || g.t0);
    /* 拖到位后停住再松手，不算惯性 —— 跟 iOS 一致 */
    var vx = idle > 120 ? 0 : (isFinite(g.vx) ? g.vx : 0);
    if (idle <= 120 && Math.abs(vx) < 0.02) vx = g.dx / dt;

    if (g.mode === 'back') {
      var dist = Math.abs(g.dx);
      var speed = dist / dt;
      var need = Math.max(52, vp.w * 0.16);
      var pass = dist >= need || (dist > 34 && speed > 0.6);
      if (pass && g.dx > 0) { flyBack(g.el); return; }
      settleBack(g.el);
      return;
    }

    settlePager(g, vx);
  }

  /* 行手势中途交给板块翻页：行的位移收回去，页面接着跟手，不跳变 */
  function handoffToPager(g, dir) {
    var item = g.el;
    if (item) {
      item.style.transition = 'transform .16s ease';
      item.style.transform = '';
      setTimeout(function () { item.style.transition = ''; }, 180);
    }
    // 别让松手时产生的点击把这一行误标成完成
    swallowRowClick(selKey(g.rowEl.getAttribute('data-src'), g.rowEl.getAttribute('data-id')), 400);

    g.el = g.screenEl || $('#s-' + ui.screen);
    g.mode = 'tab';
    g.lock = true;
    g.dir = dir;
    g.el.style.transition = 'none';
    g.edge = false;
    mountPane(g, dir);
  }

  /* 行内左滑松手：决定是弹回还是吸附打开 */
  function settleRow(g) {
    var W = SWIPE.ROW_ACTIONS_W;
    var item = g.el;
    var wrap = g.rowEl;
    var wasOpen = (ui.openRow === wrap);
    var base = wasOpen ? -W : 0;
    var pos = base + g.dx;

    var idle = Date.now() - (g.lastT || g.t0);
    var vx = idle > 120 ? 0 : (isFinite(g.vx) ? g.vx : 0);
    if (vx < -4) vx = -4;                       // 速度做个上限，别被异常值带跑
    if (vx > 4) vx = 4;
    swallowRowClick(selKey(wrap.getAttribute('data-src'), wrap.getAttribute('data-id')), 200);

    var wantOpen = pos <= -W * SWIPE.ROW_OPEN_RATIO;
    // 快速一甩也要够长才算，小幅慢拖不当作甩
    if (!wasOpen && vx < -0.5 && pos < -60) wantOpen = true;

    if (wantOpen) {
      openRow(wrap);
    } else {
      if (ui.openRow === wrap) closeRow();
      else resetRowItem(item);
    }
  }

  /* 松手：按位移 + 速度决定吸附到哪儿，时长跟着剩余距离和速度算 */
  function settlePager(g, vx) {    var to = g.to;
    var ratio = Math.abs(g.dx) / vp.w;
    var sameDir = g.dx * g.dir > 0;
    var fling = sameDir && Math.abs(vx) > 0.35 && Math.abs(g.dx) > 16;
    var pass = !!to && !g.edge && sameDir && (ratio > 0.24 || fling);

    var speed = Math.max(Math.abs(vx), 0.5);
    var dur, targetFrom, targetTo;

    if (pass) {
      targetFrom = g.dir * vp.w;
      targetTo = 0;
      dur = Math.min(380, Math.max(170, (vp.w - Math.abs(g.dx)) / speed));
    } else {
      targetFrom = 0;
      targetTo = g.base || 0;
      dur = Math.min(300, Math.max(150, Math.abs(g.dx) / speed));
    }

    animating = true;
    swallowClick = true;

    g.el.style.transition = 'transform ' + dur + 'ms cubic-bezier(.2,.9,.25,1), box-shadow ' + dur + 'ms ease';
    g.el.style.transform = 'translateX(' + targetFrom.toFixed(1) + 'px)';

    if (to) {
      to.style.transition = 'transform ' + dur + 'ms cubic-bezier(.2,.9,.25,1)';
      to.style.transform = 'translateX(' + targetTo.toFixed(1) + 'px)';
    }

    setTimeout(function () { finishPager(g, pass); }, dur + 20);
  }

  function finishPager(g, pass) {
    var from = g.el;
    var to = g.to;

    if (to) {
      to.classList.remove('pane-behind');
      to.style.transition = '';
      to.style.transform = '';
      to.style.willChange = '';
    }

    from.style.transition = '';
    from.style.transform = '';
    from.style.position = '';
    from.style.zIndex = '';
    from.style.background = '';
    from.style.boxShadow = '';
    from.style.willChange = '';
    document.body.classList.remove('pager-drag');

    if (pass) {
      showScreen(g.toName);
    } else {
      if (to) to.hidden = true;
      hintTab(ui.screen);
    }

    animating = false;
    swallowClick = false;
  }

  function settleBack(el) {
    animating = true;
    el.style.transition = 'transform .22s cubic-bezier(.22,.9,.3,1)';
    el.style.transform = '';
    setTimeout(function () {
      el.style.transition = '';
      el.style.transform = '';
      animating = false;
    }, 240);
  }

  /* 返回：把当前页整块拎起来向右飞出，底下那一级露出来。
     阴影留在左侧，看起来像页被从左往右掀开。 */
  function flyBack(el) {
    animating = true;
    swallowClick = true;

    var sy = window.scrollY || 0;
    el.style.position = 'fixed';
    el.style.top = (-sy) + 'px';
    el.style.left = '0';
    el.style.width = '100%';
    el.style.zIndex = '60';
    el.style.background = '#F5F6F8';
    el.style.boxShadow = '-12px 0 28px rgba(15, 23, 42, .14)';
    el.style.transition = 'transform .24s cubic-bezier(.4,0,.75,.2), opacity .24s ease';

    goBack();
    el.hidden = false;   /* goBack 把它收起来了，这里放回来做飞出 */

    void el.offsetWidth;
    el.style.transform = 'translateX(100%)';
    el.style.opacity = '0.5';

    setTimeout(function () {
      el.hidden = true;
      el.style.position = '';
      el.style.top = '';
      el.style.left = '';
      el.style.width = '';
      el.style.zIndex = '';
      el.style.background = '';
      el.style.boxShadow = '';
      el.style.transition = '';
      el.style.transform = '';
      el.style.opacity = '';
      animating = false;
      swallowClick = false;
    }, 250);
  }

  /* 键盘 ← → 与触控板横扫走这里，同一套转场 */
  function jumpTab(step) {
    if (animating) return;
    var idx = TAB_ORDER.indexOf(ui.screen);
    if (idx < 0) return;
    var next = idx + step;
    if (next < 0 || next >= TAB_ORDER.length) return;
    switchTab(TAB_ORDER[next], step > 0 ? 'right' : 'left');
  }

  function bindGestures() {
    measureVp();
    window.addEventListener('resize', measureVp);
    window.addEventListener('orientationchange', measureVp);

    function onDown(x, y, target, type) {
      gestureStart(x, y, target, type);
    }

    if (window.PointerEvent) {
      document.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        pressBegin(e.clientX, e.clientY, e.target);
        onDown(e.clientX, e.clientY, e.target, e.pointerType);
        if (gesture && e.pointerType === 'mouse' && e.cancelable) e.preventDefault();
      }, { passive: false });

      document.addEventListener('pointermove', function (e) {
        pressMoved(e.clientX, e.clientY);
        if (!gesture) return;
        gestureMove(e.clientX, e.clientY);
        if (gesture && gesture.lock && e.cancelable) e.preventDefault();
      }, { passive: false });

      document.addEventListener('pointerup', function () { pressCancel(); gestureEnd(); });
      document.addEventListener('pointercancel', function () { pressCancel(); gestureEnd(); });
      document.addEventListener('pointerleave', function () {
        if (gesture && !gesture.lock) gesture = null;
      });
    } else {
      document.addEventListener('touchstart', function (e) {
        var ts = e.touches;
        if (!ts || ts.length !== 1) { gesture = null; pressCancel(); return; }
        pressBegin(ts[0].clientX, ts[0].clientY, e.target);
        gestureStart(ts[0].clientX, ts[0].clientY, e.target, 'touch');
      }, { passive: true });

      document.addEventListener('touchmove', function (e) {
        var ts = e.touches;
        if (ts && ts.length === 1) pressMoved(ts[0].clientX, ts[0].clientY);
        if (!gesture) return;
        if (!ts || ts.length !== 1) { gesture.dead = true; return; }
        gestureMove(ts[0].clientX, ts[0].clientY);
        if (gesture && gesture.lock && e.cancelable) e.preventDefault();
      }, { passive: false });

      document.addEventListener('touchend', function () { pressCancel(); gestureEnd(); }, { passive: true });
      document.addEventListener('touchcancel', function () { pressCancel(); gestureEnd(); }, { passive: true });
    }

    /* 桌面键盘：← → 切板块 */
    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') jumpTab(-1);
      else if (e.key === 'ArrowRight') jumpTab(1);
    });

    /* 触控板双指横扫：只在横向意图明显时接管，别抢走纵向滚动 */
    var wheelLock = 0;
    document.addEventListener('wheel', function (e) {
      if (!db.settings.swipeTabs) return;
      if (SUB_SWIPE.indexOf(ui.screen) >= 0) return;
      if (Date.now() < wheelLock) return;
      if (Math.abs(e.deltaX) < 36) return;
      if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.4) return;
      wheelLock = Date.now() + 520;
      jumpTab(e.deltaX > 0 ? 1 : -1);
    }, { passive: true });

    /* 手势刚结束时压掉一次误触的点击 */
    document.addEventListener('click', function (e) {
      if (rowSwallowUntil) {
        var within = Date.now() < rowSwallowUntil && inSwallowedRow(e.target);
        rowSwallowUntil = 0;
        rowSwallowKey = '';
        if (within) {
          e.stopPropagation();
          e.preventDefault();
          return;
        }
      }
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }

  /* ---------------- 事件 ---------------- */
  function bindEvents() {
    // tab
    $$('.tab').forEach(function (t) {
      t.addEventListener('click', function () {
        var tab = t.getAttribute('data-tab');
        var cur = TAB_ORDER.indexOf(ui.screen);
        var next = TAB_ORDER.indexOf(tab);
        var from = next > cur ? 'right' : 'left';
        switchTab(tab, from);
      });
    });

    // 通用点击委托
    document.addEventListener('click', function (e) {
      // 左滑打开着的行：点外面就收起来；点行本身也只收起，不当成「切换完成」
      if (ui.openRow) {
        var ow = ui.openRow;
        if (!ow.contains(e.target)) {
          closeRow();
        } else if (e.target.closest && e.target.closest('.tl-actions')) {
          // 点的是操作按钮，交给下面的逻辑去执行
        } else {
          closeRow();
          return;
        }
      }

      var el = e.target.closest('[data-act], [data-go], .nav-back, .chip');
      if (!el) return;

      if (el.classList.contains('nav-back')) { goBack(); return; }

      // 两组 chip 分开处理：文件库筛选 / 待办筛选 / 提醒时间
      if (el.classList.contains('chip')) {
        if (el.parentNode && el.parentNode.id === 'lib-filter') {
          $$('#lib-filter .chip').forEach(function (c) { c.classList.remove('on'); });
          el.classList.add('on');
          ui.libFilter = el.getAttribute('data-kind');
          renderLibrary();
          return;
        }
        if (el.parentNode && el.parentNode.id === 'todo-filter') {
          $$('#todo-filter .chip').forEach(function (c) { c.classList.remove('on'); });
          el.classList.add('on');
          ui.todoFilter = el.getAttribute('data-filter');
          renderTodos();
          return;
        }
        return;
      }

      var go = el.getAttribute('data-go');
      if (go) {
        if (go === 'todos') { openTodos(); return; }
        if (go === 'library') { renderLibrary(); showScreen('library', { sub: true }); return; }
        if (go === 'remind') { renderRemind(); showScreen('remind', { sub: true }); return; }
        if (go === 'install') { renderInstall(); showScreen('install', { sub: true }); return; }
        if (go === 'update') { openUpdatePage(); return; }
        return;
      }

      var act = el.getAttribute('data-act');
      var id = el.getAttribute('data-id');

      if (act === 'open-item') { openItem(id); return; }
      if (act === 'open-report') { openReport(id); return; }

      if (act === 'morning-dismiss') {
        db.settings.morningDismissedOn = todayStr();
        save();
        renderMorningCard();
        toast('收起，明天见');
        return;
      }

      if (act === 'clip-dismiss') {
        db.settings.clipDismissed = ui.clipUrl || '';
        save();
        hideClipBar();
        return;
      }

      if (act === 'alarm-toggle') {
        var al = db.alarms.filter(function (x) { return x.id === id; })[0];
        if (!al) return;
        al.on = !al.on;
        syncSettingsFromAlarms();
        save();
        syncAlarms();
        renderRemind();
        renderMe();
        toast(al.on ? '闹钟已开' : '闹钟已关');
        return;
      }

      if (act === 'alarm-del') {
        db.alarms = db.alarms.filter(function (x) { return x.id !== id; });
        syncSettingsFromAlarms();
        save();
        syncAlarms();
        renderRemind();
        renderMe();
        toast('已删除');
        return;
      }

      if (act === 'alarm-edit') {
        var ae = db.alarms.filter(function (x) { return x.id === id; })[0];
        if (ae) openAlarmForm(ae);
        return;
      }

      if (act === 'install-dismiss') {
        db.settings.installDismissed = 'yes';
        save();
        renderInstallBar();
        return;
      }

      if (act === 'update-open') { openUpdatePage(); return; }
      if (act === 'update-dismiss') { dismissUpdateBar(); return; }

      if (act === 'toggle-todo') {
        // 多选态下点行是选中，不是完成
        if (ui.select.on) { toggleSelect('todo', id); return; }
        var t = db.todos.filter(function (x) { return x.id === id; })[0];
        if (!t) return;
        setNodeDone('todo', id, !t.done);
        renderHome();
        if (ui.tab === 'todos') renderTodos();
        toast(t.done ? '已完成' : '已取消');
        return;
      }

      if (act === 'toggle-due') {
        if (ui.select.on) { toggleSelect('due', id); return; }
        var r = db.reminders.filter(function (x) { return x.id === id; })[0];
        if (!r) return;
        setNodeDone('due', id, !r.confirmed);
        renderHome();
        if (ui.tab === 'todos') renderTodos();
        toast(r.confirmed ? '已确认处理' : '已取消');
        return;
      }

      if (act === 'check-todo' || act === 'check-due') {
        if (ui.select.on) { toggleSelect(el.getAttribute('data-src'), id); return; }
        var cn = nodeRecord(el.getAttribute('data-src'), id);
        if (!cn) return;
        var isTodo = act === 'check-todo';
        var wasDone = isTodo ? cn.done : cn.confirmed;
        setNodeDone(el.getAttribute('data-src'), id, !wasDone);
        buzz(isTodo ? 14 : 10);
        toast(!wasDone ? '已完成' : '已取消');
        return;
      }

      /* 左滑露出来的三个按钮 */
      if (act === 'tl-done') {
        closeRow();
        var dn = nodeRecord(el.getAttribute('data-src'), id);
        if (!dn) return;
        setNodeDone(dn.src || el.getAttribute('data-src'), id, !dn.done);
        toast(dn.done ? '已完成' : '已取消');
        return;
      }

      if (act === 'tl-star') {
        closeRow();
        var sn = nodeRecord(el.getAttribute('data-src'), id);
        if (!sn) return;
        markImportant(sn.src || el.getAttribute('data-src'), id, !sn.important);
        return;
      }

      if (act === 'tl-del') {
        closeRow();
        deleteNodeWithUndo(el.getAttribute('data-src'), id);
        return;
      }

      if (act === 'item-ics') {
        var it2 = db.items.filter(function (x) { return x.id === id; })[0];
        if (!it2) return;
        var nodes = [];
        (it2.todos || []).forEach(function (t, i) {
          if (!t.dueDate) return;
          nodes.push({
            id: 'it' + i, src: 'todo', title: t.title, dueDate: t.dueDate,
            done: false, important: false,
            icalUid: 'guiji-item-' + it2.id + '-t' + i + '@ghost-post'
          });
        });
        (it2.dues || []).forEach(function (d, i) {
          if (!d.date) return;
          nodes.push({
            id: 'id' + i, src: 'due', title: d.title, dueDate: d.date,
            done: false, important: false,
            icalUid: 'guiji-item-' + it2.id + '-d' + i + '@ghost-post'
          });
        });
        if (!nodes.length) { toast('这些都没定日期，进不了日历'); return; }
        addEventsToPhoneCalendar(nodes, '鬼邮局待办');
        return;
      }

      if (act === 'tl-cal') {
        var node = collectNodes().filter(function (n) { return n.id === id && n.src === el.getAttribute('data-src'); })[0];
        if (!node) return;
        if (!node.dueDate) { toast('这条没有截止日，进不了日历'); return; }
        addEventsToPhoneCalendar([node], '鬼邮局待办');
        return;
      }

      if (act === 'toggle-done-group') {
        ui.doneExpanded = !ui.doneExpanded;
        renderTodos();
        return;
      }

      /* 批量条 */
      if (act === 'sel-cancel') { exitSelectMode(); return; }

      if (act === 'sel-done') {
        var sd = selectedNodes();
        if (!sd.length) { toast('先长按选几条'); return; }
        sd.forEach(function (n) { setNodeDone(n.src, n.id, true); });
        toast('已完成 ' + sd.length + ' 项');
        exitSelectMode();
        return;
      }

      if (act === 'sel-star') {
        var ss = selectedNodes();
        if (!ss.length) { toast('先长按选几条'); return; }
        ss.forEach(function (n) {
          var rec = nodeRecord(n.src, n.id);
          if (rec) rec.important = true;
        });
        save(); syncImportantAlarms(); renderTodos(); renderHome();
        toast('已标重要 ' + ss.length + ' 项');
        exitSelectMode();
        return;
      }

      if (act === 'sel-del') {
        var sl = selectedNodes();
        if (!sl.length) { toast('先长按选几条'); return; }
        sl.forEach(function (n) {
          var rec = nodeRecord(n.src, n.id);
          if (rec) rec.pendingDelete = true;
        });
        save(); renderTodos(); renderHome(); syncImportantAlarms();
        var picked = sl.slice();
        toast('已删除 ' + picked.length + ' 项', {
          action: '撤销', ms: 5000,
          onAction: function () {
            picked.forEach(function (n) { undoDelete(n.src, n.id); });
            toast('已撤销');
          }
        });
        exitSelectMode();
        return;
      }
    });

    // 悬浮按钮
    $('#fab').addEventListener('click', function () {
      $('#mask').hidden = false;
      $('#sheet').hidden = false;
      $('#sheet-main').hidden = false;
      $('#sheet-text').hidden = true;
      $('#sheet-link').hidden = true;
      $('#sheet-todo').hidden = true;
    });

    function closeSheet() {
      $('#mask').hidden = true;
      $('#sheet').hidden = true;
    }
    $('#mask').addEventListener('click', closeSheet);
    $('#sheet-cancel').addEventListener('click', closeSheet);

    /* 新建待办 */
    $('#pick-todo').addEventListener('click', function () {
      $('#sheet-main').hidden = true;
      $('#sheet-todo').hidden = false;
      var ti = $('#todo-title');
      if (ti) { ti.value = ''; setTimeout(function () { try { ti.focus(); } catch (e) {} }, 80); }
    });

    // 重复规则 / 重要 的小开关
    function bindChipGroup(sel, attr) {
      var box = $(sel);
      if (!box) return;
      box.addEventListener('click', function (e) {
        var c = e.target.closest && e.target.closest('.chip');
        if (!c) return;
        $$('.chip', box).forEach(function (x) { x.classList.remove('on'); });
        c.classList.add('on');
        try { c.setAttribute('data-picked', c.getAttribute(attr) || ''); } catch (e2) {}
      });
    }
    bindChipGroup('#todo-repeat', 'data-repeat');
    bindChipGroup('#todo-imp', 'data-imp');

    $('#todo-save').addEventListener('click', function () {
      var titleEl = $('#todo-title');
      var dueEl = $('#todo-due');
      var title = titleEl ? String(titleEl.value || '').trim() : '';
      if (!title) { toast('先写一句要做的事'); return; }

      var rep = 'none', imp = false;
      var rc = $('#todo-repeat .chip.on');
      if (rc) rep = rc.getAttribute('data-repeat') || 'none';
      var ic = $('#todo-imp .chip.on');
      if (ic) imp = ic.getAttribute('data-imp') === '1';

      var due = dueEl && dueEl.value ? String(dueEl.value) : null;
      createTodo({
        title: title,
        dueDate: due,
        important: imp,
        repeat: rep,
        repeatDay: rep === 'monthly' && due ? Number(String(due).split('-')[2]) : null
      });
      save();
      syncImportantAlarms();
      closeSheet();
      $('#sheet-todo').hidden = true;
      ui.todoFilter = 'all';
      $$('#todo-filter .chip').forEach(function (c) {
        c.classList.toggle('on', c.getAttribute('data-filter') === 'all');
      });
      openTodos();
      toast('加好了，在时间表最上面');
    });

    $('#pick-file').addEventListener('click', function () {
      closeSheet();
      $('#file-input').click();
    });
    $('#pick-image').addEventListener('click', function () {
      closeSheet();
      $('#image-input').click();
    });
    $('#pick-video').addEventListener('click', function () {
      closeSheet();
      var inp = $('#video-input');
      if (inp) inp.click();
    });
    $('#pick-text').addEventListener('click', function () {
      $('#sheet-main').hidden = true;
      $('#sheet-text').hidden = false;
    });
    $('#pick-link').addEventListener('click', function () {
      $('#sheet-main').hidden = true;
      $('#sheet-link').hidden = false;
      setTimeout(function () {
        var el = $('#link-input');
        if (el && el.focus) el.focus();
      }, 80);
      // 打开就试着把剪贴板里的链接填进去，省一次长按粘贴
      readClipboardText().then(function (t) {
        var url = extractUrl(t);
        if (!url) return;
        var input = $('#link-input');
        if (input && !input.value.trim()) {
          input.value = url;
          toast('已从剪贴板填入');
        }
      });
    });

    $('#link-paste').addEventListener('click', function () {
      checkClipboard(false).then(function (url) {
        if (!url) return;
        var input = $('#link-input');
        if (input) input.value = url;
        hideClipBar();
      });
    });

    $('#clip-go').addEventListener('click', function () {
      var url = ui.clipUrl || $('#clip-bar').getAttribute('data-url');
      if (!url) return;
      hideClipBar();
      handleLink(url);
    });
    $('#submit-link').addEventListener('click', function () {
      var v = $('#link-input').value;
      closeSheet();
      $('#link-input').value = '';
      handleLink(v);
    });
    $('#submit-text').addEventListener('click', function () {
      var v = $('#text-input').value;
      closeSheet();
      $('#text-input').value = '';
      handleText(v);
    });

    $('#file-input').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) handleFile(f);
    });
    $('#image-input').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) handleImage(f);
    });
    $('#video-input').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) handleVideo(f);
    });

    $('#gen-report').addEventListener('click', generateReport);

    // 闹钟
    $('#rm-perm').addEventListener('click', askNotifyPermission);
    $('#rm-ics').addEventListener('click', function () {
      // 把所有还没完成的、定了日期的待办写进日历
      var open = collectNodes().filter(function (n) { return !n.done && !!n.dueDate; });
      if (!open.length) { toast('没有带日期的待办可写'); return; }
      addEventsToPhoneCalendar(open, '鬼邮局待办');
    });

    $('#alarm-add').addEventListener('click', function () { openAlarmForm(null); });
    $('#af-cancel').addEventListener('click', closeAlarmForm);
    $('#af-save').addEventListener('click', saveAlarm);

    $$('#af-repeat .chip').forEach(function (c) {
      c.addEventListener('click', function () {
        $$('#af-repeat .chip').forEach(function (x) { x.classList.remove('on'); });
        c.classList.add('on');
      });
    });

    // 边缘滑动返回开关
    $('#swipe-row').addEventListener('click', function () {
      db.settings.swipeBack = !db.settings.swipeBack;
      save();
      renderMe();
      toast(db.settings.swipeBack ? '右滑返回已开启' : '右滑返回已关闭');
    });

    var str = $('#swipe-tabs-row');
    if (str) {
      str.addEventListener('click', function () {
        db.settings.swipeTabs = !db.settings.swipeTabs;
        save();
        renderMe();
        toast(db.settings.swipeTabs ? '左右滑动切换已开启' : '左右滑动切换已关闭');
      });
    }
    // 10 秒后真响一次，用来验证整条链路
    $('#rm-test10').addEventListener('click', function () {
      if (!inNativeApp()) {
        toast('网页版没有系统闹钟，用安卓 APP 版测');
        return;
      }
      var okSet = false;
      try { okSet = window.GuijiApp.testAlarm(10); } catch (e) {}
      toast(okSet ? '好，10 秒后响。可以锁屏等着' : '排不上闹钟，检查通知权限');
    });

    // 通知权限：直接跳系统设置
    $('#rm-notif').addEventListener('click', function () {
      if (notifyState() === 'app') {
        try { window.GuijiApp.openNotifSettings(); return; } catch (e) {}
      }
      if (notifyState() === 'unsupported') {
        toast('网页版不支持系统通知');
        return;
      }
      askNotifyPermission();
    });

    // 电池优化：国产系统杀后台最常见的原因
    $('#rm-battery').addEventListener('click', function () {
      if (!inNativeApp()) { toast('这一步只在 APP 版需要'); return; }
      try { window.GuijiApp.openBatterySettings(); } catch (e) {}
    });

    // 短信兜底
    $('#rm-sms').addEventListener('click', function () {
      if (!inNativeApp()) { toast('短信提醒只在 APP 版有效'); return; }
      var raw = '0|';
      try { raw = String(window.GuijiApp.smsState() || '0|'); } catch (e) {}
      var nowOn = raw.charAt(0) === '1';
      var num = String($('#rm-sms-num').value || '').trim();

      if (!nowOn) {
        if (!num) {
          toast('先填手机号');
          $('#rm-sms-num').focus();
          return;
        }
        try { window.GuijiApp.requestSmsPermission(); } catch (e) {}
        try { window.GuijiApp.setSms(true, num); } catch (e) {}
        toast('已开启，闹钟响的同时会发短信');
      } else {
        try { window.GuijiApp.setSms(false, num); } catch (e) {}
        toast('短信提醒已关');
      }
      renderRemind();
    });

    $('#rm-sms-num').addEventListener('change', function () {
      if (!inNativeApp()) return;
      var num = String(this.value || '').trim();
      var raw = '0|';
      try { raw = String(window.GuijiApp.smsState() || '0|'); } catch (e) {}
      try { window.GuijiApp.setSms(raw.charAt(0) === '1', num); } catch (e) {}
    });

    $('#clear-row').addEventListener('click', function () {
      if (!confirm('清空这台手机上的所有内容？这个操作不能撤销。')) return;
      db = {
        items: [], todos: [], reminders: [], reports: [],
        settings: {
          remindEnabled: true, remindAt: '07:30',
          lastRemindedOn: '', morningDismissedOn: '', clipDismissed: '',
          installDismissed: '', swipeBack: true, swipeTabs: true,
          autoUpdate: true, updateSkip: 0
        },
        alarms: []
      };
      ui.morning = null;
      save();
      renderHome();
      renderReports();
      renderMe();
      toast('已清空');
    });

    // 版本更新页：点按钮 / 稍后再说
    var updAct = $('#upd-action');
    if (updAct) {
      updAct.addEventListener('click', function () {
        var st = ui.update.state;
        if (st === 'downloading' || st === 'installing' || st === 'checking') return;
        if (st === 'failed') { retryUpdate(); return; }
        if (st === 'downloaded') { installUpdate(); return; }
        if (st === 'latest') {
          if (!inNativeApp()) { renderInstall(); showScreen('install', { sub: true }); return; }
          checkUpdate();
          return;
        }
        startUpdate(false);
      });
    }
    var updLater = $('#upd-later');
    if (updLater) {
      updLater.addEventListener('click', function () {
        if (ui.update.state === 'downloading') { goBack(); toast('在后台下着，下完会提示你'); return; }
        dismissUpdateBar();
        goBack();
      });
    }

    // 我的 → APP 版本：点进去看更新
    var updRow = $('#upd-row');
    if (updRow) updRow.addEventListener('click', openUpdatePage);

    // 我的 → 自动下载开关
    var auRow = $('#autoupd-row');
    if (auRow) {
      auRow.addEventListener('click', function () {
        db.settings.autoUpdate = !db.settings.autoUpdate;
        save();
        renderMe();
        toast(db.settings.autoUpdate ? '已开启：非流量网络下会自动下载' : '已关闭：只提示，不自动下');
      });
    }

    // 安装到桌面
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      ui.installPrompt = e;
      renderInstallBar();
      if (!$('#s-install').hidden) renderInstall();
    });
    window.addEventListener('appinstalled', function () {
      ui.installPrompt = null;
      db.settings.installDismissed = 'yes';
      save();
      renderInstallBar();
      toast('装好了，去桌面看看');
    });
    // 微信里给一条「用浏览器打开」的出路
    window.addEventListener('visibilitychange', function () {
      if (!document.hidden) renderInstallBar();
    });
  }

  /* ---------------- 启动 ---------------- */
  // URL 带 ?selftest=1 时自动试一次 AI，把结果显示在首页提示条。
  // 用来远程确认「模型到底能不能调通」，不用人工点。
  function selfTest() {
    if (!/[?&]selftest=1/.test(location.search)) return;
    var notice = $('#cloud-notice');
    notice.hidden = false;
    notice.textContent = '正在自检 AI…';

    askAI({
      kindLabel: '一段文字',
      title: '自检',
      text: '明天下午三点开会讨论合同续签，合同金额 128000 元，2026-12-31 到期。'
    }).then(function (r) {
      notice.textContent = 'AI 可用｜摘要：' + r.summary;
    }).catch(function (e) {
      notice.textContent = 'AI 不可用｜' + ((e && e.message) || '未知') + '｜将使用本地提取';
    });
  }

  /* 注册 Service Worker：安卓要靠它才能弹系统通知 */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    try {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
        // 每次启动都问一次有没有新版，别等浏览器自己想起来
        try { reg.update(); } catch (e) {}
        if (typeof Notification !== 'undefined') renderRemind();
      }).catch(function () { /* 注册失败不影响主流程 */ });

      // 新版本接管后刷新一次，避免「新页面配旧脚本」
      var reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
    } catch (e) { /* 忽略 */ }
  }

  /* 清单文件也要带访问码，否则网关卡掉，装不到桌面 */
  /* 页面里已经写死了带访问码的清单地址；只有当地址栏里是另一个码时才改写。
     不能在没有码的情况下改写，否则会把正确的地址覆盖成 403。 */
  function fixManifestLink() {
    var m = String(location.search || '').match(/[?&]sharecode=([^&]+)/);
    if (!m) return;
    var el = document.querySelector('link[rel="manifest"]');
    if (el) el.href = '/api/manifest?sharecode=' + m[1];

    var touch = document.querySelector('link[rel="apple-touch-icon"]');
    if (touch) touch.href = '/assets/icon-180.png?sharecode=' + m[1];
  }

  /* 首页点通知进来时，直接落到时间表 */
  function handleEntryParams() {
    // 从别的 App 分享过来、或者快捷指令拼好地址打开的：直接读这条链接
    var incoming = urlFromLocation();
    if (incoming) {
      handleLink(incoming);
      return true;
    }

    var search = String(location.search || '');
    if (/[?&]tab=todos/.test(search)) {
      openTodos();
      return true;
    }
    if (/[?&]tab=remind/.test(search)) {
      renderRemind();
      showScreen('remind', { sub: true });
      return true;
    }
    if (/[?&]tab=install/.test(search)) {
      renderInstall();
      showScreen('install', { sub: true });
      return true;
    }
    if (/[?&]tab=update/.test(search)) {
      openUpdatePage();
      return true;
    }
    return false;
  }

  function boot() {
    load();
    initCloud();
    renderSign();
    renderHome();
    renderReports();
    renderMe();
    bindEvents();
    var wentElsewhere = handleEntryParams();
    if (!wentElsewhere) showScreen('home');
    selfTest();

    // 回到页面时看一眼剪贴板：从微信复制了链接切回来，这里会冒出来
    if (!wentElsewhere) {
      setTimeout(function () { checkClipboard(true, true); }, 600);
    }

    // 打包版由原生在 onResume 里喊一声，比 visibilitychange 更准
    window.__guijiOnResume = function () {
      checkClipboard(true, true);
      checkMorning(false);
      renderInstallBar();
      syncImportantAlarms();
      tickImportantWeb();
      // 从安装界面回来时，可能已经装好了，重新问一次
      if (ui.update.state === 'installing' || ui.update.state === 'downloaded') {
        setTimeout(function () { checkUpdate(); }, 1500);
      }
    };

    function onBackToPage() {
      if (document.hidden) return;
      checkClipboard(true, true);
    }
    document.addEventListener('visibilitychange', onBackToPage);
    window.addEventListener('focus', onBackToPage);
    window.addEventListener('pageshow', onBackToPage);

    // 早晨提醒：进来先算一次（补发），之后每分钟看一次有没有到点
    checkMorning(false);
    setInterval(function () { checkMorning(false); }, 60 * 1000);
    registerSW();
    fixManifestLink();
    renderInstallBar();
    bindGestures();
    syncAlarms();
    setInterval(tickAlarms, 30 * 1000);
    tickAlarms();

    // 重要任务的一次性闹钟：启动时排一次，之后每分钟看看要不要补
    syncImportantAlarms();
    setInterval(function () { syncImportantAlarms(); tickImportantWeb(); }, 60 * 1000);
    tickImportantWeb();

    // 应用内更新：晚一点查，别跟首屏抢网络；之后每 6 小时再看一次
    renderUpdateBar();
    setTimeout(function () { checkUpdate(); }, 2500);
    setInterval(function () { checkUpdate(); }, 6 * 60 * 60 * 1000);

    // 从通知点回来时，Service Worker 会发消息
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'open-todos') openTodos();
        if (e.data && e.data.type === 'check-morning') checkMorning(false);
      });
    }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkMorning(false);
    });

    // 暴露少量调试接口，方便在控制台看状态
    window.__guiji = {
      db: db, ui: ui, askAI: askAI, generateReport: generateReport,
      checkMorning: checkMorning, renderTodos: renderTodos, renderRemind: renderRemind,
      buildDigest: buildDigest, buildICS: buildICS, buildICSForNodes: buildICSForNodes,
      addEventsToPhoneCalendar: addEventsToPhoneCalendar,
      renderItem: renderItem,
      handleFile: handleFile, handlePDF: handlePDF,
      todo: {
        create: createTodo, setDone: setNodeDone, mark: markImportant,
        del: deleteNodeWithUndo, undo: undoDelete,
        spawn: spawnNextInstance, nextDate: nextRepeatDate,
        select: toggleSelect, selectMode: enterSelectMode, exitSelect: exitSelectMode,
        selNodes: selectedNodes,
        openRow: openRow, closeRow: closeRow,
        syncAlarms: syncImportantAlarms, tickWeb: tickImportantWeb,
        repeatText: repeatText
      },
      update: {
        check: checkUpdate, start: startUpdate, install: installUpdate,
        retry: retryUpdate, render: renderUpdate, bar: renderUpdateBar,
        dismiss: dismissUpdateBar, open: openUpdatePage,
        code: appVersionCode, name: appVersionName,
        progress: window.__guijiUpdateProgress,
        done: window.__guijiUpdateDone,
        error: window.__guijiUpdateError,
        metered: metered, fmt: fmtBytes
      },
      gesture: {
        start: gestureStart, move: gestureMove, end: gestureEnd,
        measure: measureVp, vp: vp,
        state: function () { return gesture; },
        tabOrder: TAB_ORDER, subScreens: SUB_SWIPE
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
