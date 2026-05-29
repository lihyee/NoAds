/******************************
脚本功能：通用签到（适配所有 NewAPI 源码搭建的中转站）- Loon版
更新时间：2026-05-29
使用说明：
1. 抓包插件启用时：访问 /api/user/self 或手动签到触发 /api/user/checkin，自动保存 Cookie 和 new-api-user
2. 签到插件启用时：定时执行新版 NewAPI 的 /api/user/checkin
3. 按域名、账号分别保存
4. 自动记录抓取状态与签到结果
5. Cloudflare/Turnstile 保护站点：脚本不会绕过验证；请先在站点正常完成验证，再重新抓包保存已通过验证的会话 Cookie
*******************************/

const HEADER_KEY_PREFIX = "UniversalCheckin_Headers";
const HOSTS_LIST_KEY = "UniversalCheckin_HostsList";
const STATUS_KEY_PREFIX = "UniversalCheckin_Status";
const DEFAULT_MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;
const isGetHeader = typeof $request !== "undefined";

const NEED_KEYS = [
  "Host",
  "User-Agent",
  "Accept",
  "Accept-Language",
  "Accept-Encoding",
  "Origin",
  "Referer",
  "Cookie",
  "new-api-user",
  "New-Api-User",
  "Authorization",
  "X-Requested-With",
  "Sec-Fetch-Site",
  "Sec-Fetch-Mode",
  "Sec-Fetch-Dest",
  "Sec-Fetch-Storage-Access",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "Priority",
  "Connection",
];

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return null;
  }
}

function readStore(key) {
  try {
    return $persistentStore.read(key);
  } catch (_) {
    return null;
  }
}

function writeStore(value, key) {
  try {
    return $persistentStore.write(value, key);
  } catch (_) {
    return false;
  }
}

function normalizeHeaderValue(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function normalizeSavedHeaders(headers = {}, host = "") {
  const lowerMap = {};
  for (const k of Object.keys(headers || {})) {
    lowerMap[String(k).toLowerCase()] = headers[k];
  }
  const get = name => headers[name] ?? lowerMap[String(name).toLowerCase()];
  const next = Object.assign({}, headers);
  next.Host = normalizeHeaderValue(get("Host") || host);
  next.Cookie = normalizeHeaderValue(get("Cookie"));
  next["new-api-user"] = normalizeHeaderValue(get("new-api-user") || get("New-Api-User"));
  next["User-Agent"] = normalizeHeaderValue(get("User-Agent") || "Loon");
  return next;
}

function containsCloudflareCookie(cookie) {
  const c = String(cookie || "");
  return /(?:^|;\s*)(cf_clearance|__cf_bm|cf_chl_|__cflb)=/i.test(c);
}

function isCloudflareLike(status, headers = {}, body = "") {
  const lowerHeaders = {};
  for (const k of Object.keys(headers || {})) lowerHeaders[String(k).toLowerCase()] = String(headers[k] || "");
  const server = lowerHeaders.server || "";
  const text = String(body || "").slice(0, 2000);
  return /cloudflare/i.test(server) ||
    /cf-ray|cf-cache-status|cf-mitigated/i.test(JSON.stringify(lowerHeaders)) ||
    /Just a moment|cf-browser-verification|cf_chl|challenge-platform|Attention Required/i.test(text) ||
    (status === 403 && /cloudflare/i.test(text));
}

function isTurnstileMessage(text) {
  return /Turnstile|turnstile|人机|验证|校验|token 为空|刷新重试/i.test(String(text || ""));
}

function isAlreadyCheckedInMessage(text) {
  return /已签到|已经签到|今日已签到|already\s*checked|already\s*check/i.test(String(text || ""));
}

function shouldRetryCheckin(status, body) {
  if (status === 0 || status === 408 || status === 425 || status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  const text = String(body || "");
  return /timeout|timed out|ECONNRESET|ETIMEDOUT|暂时|稍后|繁忙|rate limit/i.test(text);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function todayDateString() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function nowTime() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function statusKeyForHost(host, account) {
  return `${STATUS_KEY_PREFIX}:${host}:${account || ""}`;
}

function saveStatus(host, account, patch) {
  try {
    const key = statusKeyForHost(host, account);
    const old = safeJsonParse(readStore(key)) || {};
    const next = Object.assign({}, old, patch);
    writeStore(JSON.stringify(next), key);
  } catch (e) {
    console.log("[NewAPI] Error saving status:", e);
  }
}

function getSavedHosts() {
  try {
    const raw = readStore(HOSTS_LIST_KEY);
    if (!raw) return [];
    const hosts = safeJsonParse(raw) || [];
    return Array.isArray(hosts) ? hosts.filter(h => h && typeof h === "string") : [];
  } catch (e) {
    console.log("[NewAPI] Error reading saved hosts:", e);
    return [];
  }
}

function addHostToList(host) {
  try {
    const hosts = getSavedHosts();
    if (!hosts.includes(host)) {
      hosts.push(host);
      writeStore(JSON.stringify(hosts), HOSTS_LIST_KEY);
      console.log("[NewAPI] Updated hosts list:", hosts.join(", "));
    }
  } catch (e) {
    console.log("[NewAPI] Error adding host to list:", e);
  }
}

function addAccountToHost(host, account) {
  try {
    if (!account || !account.trim()) return;
    const accountsKey = `${HEADER_KEY_PREFIX}:Accounts:${host}`;
    const raw = readStore(accountsKey);
    const accounts = safeJsonParse(raw) || [];
    if (!accounts.includes(account)) {
      accounts.push(account);
      writeStore(JSON.stringify(accounts), accountsKey);
      console.log(`[NewAPI] Account added to ${host}:`, account);
    }
  } catch (e) {
    console.log("[NewAPI] Error adding account to host:", e);
  }
}

function getAccountsForHost(host) {
  try {
    const accountsKey = `${HEADER_KEY_PREFIX}:Accounts:${host}`;
    const raw = readStore(accountsKey);
    const accounts = safeJsonParse(raw) || [];
    return accounts.length > 0 ? accounts : [""];
  } catch (e) {
    console.log("[NewAPI] Error reading accounts:", e);
    return [""];
  }
}

function pickNeedHeaders(src = {}) {
  const dst = {};
  const lowerMap = {};
  for (const k of Object.keys(src || {})) {
    lowerMap[String(k).toLowerCase()] = src[k];
  }
  const get = (name) => src[name] ?? lowerMap[String(name).toLowerCase()];
  for (const k of NEED_KEYS) {
    const v = get(k);
    if (v !== undefined && v !== null && String(v).length > 0) {
      const canonical = String(k).toLowerCase() === "new-api-user" ? "new-api-user" : k;
      dst[canonical] = v;
    }
  }
  if (!dst["new-api-user"]) {
    const user = get("New-Api-User") || get("new-api-user");
    if (user !== undefined && user !== null) dst["new-api-user"] = user;
  }
  return dst;
}

function headerKeyForHost(host, account) {
  if (account && account.trim()) {
    return `${HEADER_KEY_PREFIX}:${host}:${account}`;
  }
  return `${HEADER_KEY_PREFIX}:${host}`;
}

function getHostFromRequest() {
  const h = ($request && $request.headers) || {};
  const host = h.Host || h.host;
  if (host) return String(host).trim();
  try {
    const u = new URL($request.url);
    return u.host || u.hostname;
  } catch (_) {
    return "";
  }
}

function parseArgs(str) {
  const out = {};
  if (!str) return out;
  const s = String(str).trim();
  if (!s) return out;
  for (const part of s.split("&")) {
    const seg = part.trim();
    if (!seg) continue;
    const idx = seg.indexOf("=");
    if (idx === -1) {
      out[decodeURIComponent(seg)] = "";
    } else {
      const k = decodeURIComponent(seg.slice(0, idx));
      const v = decodeURIComponent(seg.slice(idx + 1));
      out[k] = v;
    }
  }
  return out;
}

function originFromHost(host) {
  return `https://${host}`;
}

function refererFromHost(host) {
  return `https://${host}/console/personal`;
}

function notifyTitleForHost(host, account) {
  let siteName = host;
  try {
    let name = host.replace(/^www\./, "");
    const parts = name.split(".");
    name = parts[0].trim();
    if (!name) name = parts[1] || host;
    name = name
      .replace(/[-_]api$/i, "")
      .replace(/[-_]service$/i, "")
      .replace(/[-_]app$/i, "")
      .replace(/^api[-_]/i, "");
    siteName = name.toUpperCase() || host.toUpperCase();
  } catch (_) {}
  return account && account.trim() ? `${siteName}(${account})` : siteName;
}

function httpPost(request) {
  return new Promise((resolve, reject) => {
    $httpClient.post(request, (error, response, data) => {
      if (error) {
        reject(error);
      } else {
        resolve({
          statusCode: response ? response.status : 0,
          body: data || "",
          headers: response ? response.headers : {},
        });
      }
    });
  });
}

if (isGetHeader) {
  const allHeaders = $request.headers || {};
  const host = getHostFromRequest();
  const picked = normalizeSavedHeaders(pickNeedHeaders(allHeaders), host);
  const captureUrl = ($request && $request.url) || "";

  if (!host || !picked || !picked.Cookie || !picked["new-api-user"]) {
    console.log("[NewAPI] header capture failed:", JSON.stringify(allHeaders));
    $notification.post(
      "通用签到",
      "未抓到关键信息",
      "请在触发 /api/user/self 或 /api/user/checkin 请求时抓包（需要包含 Cookie 和 new-api-user）。"
    );
    $done({});
  }

  const account = (picked["new-api-user"] || "").trim();
  const key = headerKeyForHost(host, account);
  const ok = writeStore(JSON.stringify(picked), key);

  if (ok) {
    addHostToList(host);
    if (account) addAccountToHost(host, account);
    saveStatus(host, account, {
      host,
      account,
      headerCaptured: true,
      hasCookie: Boolean(picked.Cookie),
      hasNewApiUser: Boolean(picked["new-api-user"]),
      hasCloudflareCookie: containsCloudflareCookie(picked.Cookie),
      lastCaptureUrl: captureUrl,
      lastCaptureTime: nowTime(),
      lastCaptureOk: true
    });
  } else {
    saveStatus(host, account, {
      host,
      account,
      headerCaptured: false,
      hasCookie: Boolean(picked.Cookie),
      hasNewApiUser: Boolean(picked["new-api-user"]),
      hasCloudflareCookie: containsCloudflareCookie(picked.Cookie),
      lastCaptureUrl: captureUrl,
      lastCaptureTime: nowTime(),
      lastCaptureOk: false
    });
  }

  const title = notifyTitleForHost(host, account);
  console.log(`[NewAPI] ${title} | 参数保存 | 已保存 ${Object.keys(picked).length} 个字段`);

  $notification.post(
    ok ? `${title} 参数获取成功` : `${title} 参数保存失败`,
    "",
    ok ? (containsCloudflareCookie(picked.Cookie) ? "已保存含 Cloudflare 会话 Cookie 的请求头。" : "后续将用于自动签到。") : "写入本地存储失败，请检查 Loon 配置。"
  );
  $done({});
} else {
  const args = parseArgs(typeof $argument !== "undefined" ? $argument : "");
  const onlyHost = (args.host || args.hostname || "").trim();
  const forceRun = String(args.force || args.forceRun || "").trim() === "1";
  const maxRetries = Math.max(0, Number(args.retries !== undefined ? args.retries : DEFAULT_MAX_RETRIES) || 0);
  const hostsToRun = onlyHost ? [onlyHost] : getSavedHosts();

  if (!onlyHost && hostsToRun.length === 0) {
    console.log("[NewAPI] No saved hosts found. Please capture /api/user/self first.");
    $notification.post(
      "通用签到",
      "无可用站点",
      "请先抓包保存至少一个站点的 /api/user/self 请求头。"
    );
    $done();
  }

  const doCheckin = async (host, account = "") => {
    const key = headerKeyForHost(host, account);
    const statusKey = statusKeyForHost(host, account);
    const oldStatus = safeJsonParse(readStore(statusKey)) || {};
    const raw = readStore(key);

    if (!forceRun && oldStatus.lastCheckinSuccess === true && oldStatus.lastCheckinDate === todayDateString()) {
      const title = notifyTitleForHost(host, account);
      const msg = `今天已成功签到过，跳过重复执行。如需强制执行可在脚本参数加 force=1。最近结果：${oldStatus.lastCheckinMessage || "签到成功"}`;
      console.log(`[NewAPI] ${title} | 跳过 | ${msg}`);
      saveStatus(host, account, {
        host,
        account,
        lastSkipTime: nowTime(),
        lastSkipReason: "today-success"
      });
      return;
    }

    if (!raw) {
      saveStatus(host, account, {
        host,
        account,
        headerCaptured: false,
        lastCheckinTime: nowTime(),
        lastCheckinSuccess: false,
        lastCheckinMessage: "缺少参数，请先抓包保存 /api/user/self 请求头",
        lastCheckinStatusCode: 0
      });

      $notification.post(
        notifyTitleForHost(host, account),
        "缺少参数",
        "请先抓包保存一次 /api/user/self 的请求头。"
      );
      return;
    }

    const parsedHeaders = safeJsonParse(raw);
    if (!parsedHeaders) {
      saveStatus(host, account, {
        host,
        account,
        lastCheckinTime: nowTime(),
        lastCheckinSuccess: false,
        lastCheckinMessage: "已保存的请求头解析失败，请重新抓包保存",
        lastCheckinStatusCode: 0
      });

      $notification.post(
        notifyTitleForHost(host, account),
        "参数异常",
        "已保存的请求头解析失败，请重新抓包保存。"
      );
      return;
    }

    const savedHeaders = normalizeSavedHeaders(parsedHeaders, host);

    const url = `https://${host}/api/user/checkin`;

    const headers = {
      Host: savedHeaders.Host || host,
      Accept: savedHeaders.Accept || "application/json, text/plain, */*",
      "Accept-Language": savedHeaders["Accept-Language"] || "zh-CN,zh-Hans;q=0.9",
      "Accept-Encoding": savedHeaders["Accept-Encoding"] || "gzip, deflate, br",
      Origin: savedHeaders.Origin || originFromHost(host),
      Referer: savedHeaders.Referer || refererFromHost(host),
      "User-Agent": savedHeaders["User-Agent"] || "Loon",
      Cookie: savedHeaders.Cookie || "",
      "New-Api-User": savedHeaders["new-api-user"] || "",
      "new-api-user": savedHeaders["new-api-user"] || "",
      "Content-Type": "application/json",
    };

    for (const k of ["Authorization", "X-Requested-With", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Sec-Fetch-Storage-Access", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "Priority"]) {
      if (savedHeaders[k]) headers[k] = savedHeaders[k];
    }

    const myRequest = {
      url,
      headers,
      body: "{}",
    };

    try {
      let resp = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        resp = await httpPost(myRequest);
        if (!shouldRetryCheckin(resp.statusCode, resp.body) || attempt === maxRetries) {
          if (attempt > 0) {
            console.log(`[NewAPI] ${notifyTitleForHost(host, account)} | 重试完成 | attempt=${attempt + 1}/${maxRetries + 1} status=${resp.statusCode}`);
          }
          break;
        }
        console.log(`[NewAPI] ${notifyTitleForHost(host, account)} | 临时失败准备重试 | attempt=${attempt + 1}/${maxRetries + 1} status=${resp.statusCode}`);
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      }
      const status = resp.statusCode;
      const body = resp.body || "";

      const obj = safeJsonParse(body) || {};
      const apiSuccess = Boolean(obj.success);
      const message = obj.message ? String(obj.message) : "";
      const alreadyChecked = !apiSuccess && isAlreadyCheckedInMessage(message || body);
      const success = apiSuccess || alreadyChecked;
      const checkinDate = obj && obj.data && obj.data.checkin_date ? String(obj.data.checkin_date) : "";
      const quotaAwarded =
        obj && obj.data && obj.data.quota_awarded !== undefined ? String(obj.data.quota_awarded) : "";

      const title = notifyTitleForHost(host, account);
      const statusText = success ? (alreadyChecked ? "✓已签到" : "✓成功") : status >= 200 && status < 300 ? "✗失败" : `✗异常(${status})`;
      const logMsg = `[NewAPI] ${title} | ${statusText} | ${checkinDate ? `${checkinDate}` : ""}${quotaAwarded ? ` | 获得:${quotaAwarded}` : ""}${message ? ` | ${message}` : ""}`.trim();
      console.log(logMsg);

      saveStatus(host, account, {
        host,
        account,
        headerCaptured: true,
        hasCookie: Boolean(savedHeaders.Cookie),
        hasNewApiUser: Boolean(savedHeaders["new-api-user"]),
        hasCloudflareCookie: containsCloudflareCookie(savedHeaders.Cookie),
        lastCheckinTime: nowTime(),
        lastCheckinSuccess: Boolean(success),
        lastCheckinMessage: alreadyChecked ? (message || "今日已签到") : (message || body || (success ? "签到成功" : "签到失败")),
        lastCheckinStatusCode: status,
        lastCheckinDate: checkinDate || (success ? todayDateString() : ""),
        lastQuotaAwarded: quotaAwarded || ""
      });

      if (isCloudflareLike(status, resp.headers, body)) {
        const tip = "检测到 Cloudflare 防护页。脚本不会绕过验证；请在站点正常完成验证后，重新打开 /api/user/self 抓包保存新的 Cookie。";
        saveStatus(host, account, {
          host,
          account,
          lastCheckinSuccess: false,
          lastCheckinMessage: tip,
          lastCheckinStatusCode: status,
          cloudflareBlocked: true
        });
        $notification.post(title, `Cloudflare 防护 ${status || ""}`, tip);
      } else if (isTurnstileMessage(message || body)) {
        const tip = `${message || "需要 Turnstile 校验"}
请先手动进入站点完成验证/签到，再重新抓包 /api/user/self 保存已验证会话。`;
        saveStatus(host, account, {
          host,
          account,
          lastCheckinSuccess: false,
          lastCheckinMessage: tip,
          lastCheckinStatusCode: status,
          turnstileRequired: true
        });
        $notification.post(title, "需要 Turnstile 验证", tip);
      } else if (status === 401 || status === 403) {
        $notification.post(title, "登录失效", `HTTP ${status}，请重新抓包保存 Cookie。
${message || body}`);
      } else if (status >= 200 && status < 300) {
        if (success) {
          let content = checkinDate ? `日期：${checkinDate}` : (alreadyChecked ? "今日已签到" : "签到成功");
          if (quotaAwarded) content += `
获得：${quotaAwarded}`;
          $notification.post(title, alreadyChecked ? "今日已签到" : "签到成功", content);
        } else {
          $notification.post(title, "签到失败", message || body || `HTTP ${status}`);
        }
      } else {
        $notification.post(title, `接口异常 ${status}`, message || body);
      }
    } catch (reason) {
      const err = typeof reason === "string" ? reason : JSON.stringify(reason);
      const title = notifyTitleForHost(host, account);
      console.log(`[NewAPI] ${title} | 网络错误 | ${err}`);

      saveStatus(host, account, {
        host,
        account,
        lastCheckinTime: nowTime(),
        lastCheckinSuccess: false,
        lastCheckinMessage: err,
        lastCheckinStatusCode: 0
      });

      $notification.post(title, "网络错误", err);
    }
  };

  (async () => {
    for (const h of hostsToRun) {
      const accounts = getAccountsForHost(h);
      for (const acc of accounts) {
        await doCheckin(h, acc);
      }
    }
    $done();
  })();
}
