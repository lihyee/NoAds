/******************************
脚本功能：查看 NewAPI 已保存账号及状态 - Loon版
更新时间：2026-04-20
*******************************/

const HEADER_KEY_PREFIX = "UniversalCheckin_Headers";
const HOSTS_LIST_KEY = "UniversalCheckin_HostsList";
const STATUS_KEY_PREFIX = "UniversalCheckin_Status";

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

function getSavedHosts() {
  const raw = readStore(HOSTS_LIST_KEY);
  if (!raw) return [];
  const hosts = safeJsonParse(raw) || [];
  return Array.isArray(hosts) ? hosts.filter(Boolean) : [];
}

function getAccountsForHost(host) {
  const accountsKey = `${HEADER_KEY_PREFIX}:Accounts:${host}`;
  const raw = readStore(accountsKey);
  const accounts = safeJsonParse(raw) || [];
  return accounts.length > 0 ? accounts : [""];
}

function headerKeyForHost(host, account) {
  if (account && account.trim()) {
    return `${HEADER_KEY_PREFIX}:${host}:${account}`;
  }
  return `${HEADER_KEY_PREFIX}:${host}`;
}

function statusKeyForHost(host, account) {
  return `${STATUS_KEY_PREFIX}:${host}:${account || ""}`;
}

function shortResult(status) {
  if (!status) return "无状态";
  if (!status.headerCaptured) return "未抓取";
  if (status.lastCheckinSuccess === true) return "签到成功";
  if (status.lastCheckinSuccess === false) return "签到失败";
  return "已抓取";
}

function yesNo(v) {
  return v ? "是" : "否";
}

const hosts = getSavedHosts();

if (hosts.length === 0) {
  const msg = "暂无站点，请先抓包保存 /api/user/self";
  console.log(msg);
  $notification.post("NewAPI 状态查看", "暂无站点", msg);
  $done();
}

let lines = [];
let totalAccounts = 0;

for (const host of hosts) {
  lines.push(`【${host}】`);
  const accounts = getAccountsForHost(host);

  for (const acc of accounts) {
    totalAccounts++;
    const accountName = acc && acc.trim() ? acc : "(默认账号)";
    const hasHeader = Boolean(readStore(headerKeyForHost(host, acc)));
    const status = safeJsonParse(readStore(statusKeyForHost(host, acc))) || {};

    lines.push(`账号：${accountName}`);
    lines.push(`请求头：${hasHeader ? "已保存" : "未保存"}`);
    lines.push(`抓取成功：${yesNo(status.lastCaptureOk)}`);
    lines.push(`有 Cookie：${yesNo(status.hasCookie)}`);
    lines.push(`有 new-api-user：${yesNo(status.hasNewApiUser)}`);
    lines.push(`最近抓取：${status.lastCaptureTime || "-"}`);
    lines.push(`签到状态：${shortResult(status)}`);
    lines.push(`最近签到：${status.lastCheckinTime || "-"}`);
    lines.push(`状态码：${status.lastCheckinStatusCode !== undefined ? status.lastCheckinStatusCode : "-"}`);
    lines.push(`签到日期：${status.lastCheckinDate || "-"}`);
    lines.push(`获取配额：${status.lastQuotaAwarded || "-"}`);
    lines.push(`结果信息：${status.lastCheckinMessage ? String(status.lastCheckinMessage).slice(0, 80) : "-"}`);
    lines.push("");
  }
}

const title = "NewAPI 账号状态";
const subtitle = `站点 ${hosts.length} 个 / 账号 ${totalAccounts} 个`;
const content = lines.join("\n").slice(0, 3800);

console.log(content);
$notification.post(title, subtitle, content);
$done();
