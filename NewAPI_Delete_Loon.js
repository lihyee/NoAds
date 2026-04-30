/******************************
脚本功能：删除 NewAPI 已保存站点/账号 - Loon版
用法：
1. 删除整个站点：
   argument=host=example.com

2. 删除某个站点下的某个账号：
   argument=host=example.com&account=user1
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

function writeStore(value, key) {
  try {
    return $persistentStore.write(value, key);
  } catch (_) {
    return false;
  }
}

function removeStore(key) {
  try {
    return $persistentStore.write("", key);
  } catch (_) {
    return false;
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

function getSavedHosts() {
  const raw = readStore(HOSTS_LIST_KEY);
  if (!raw) return [];
  const hosts = safeJsonParse(raw) || [];
  return Array.isArray(hosts) ? hosts.filter(Boolean) : [];
}

function setSavedHosts(hosts) {
  return writeStore(JSON.stringify(hosts), HOSTS_LIST_KEY);
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

const args = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const host = (args.host || args.hostname || "").trim();
const account = (args.account || "").trim();

if (!host) {
  $notification.post(
    "NewAPI 删除",
    "缺少参数",
    "请传入 argument=host=example.com\n或 argument=host=example.com&account=user1"
  );
  $done();
}

if (account) {
  const accountsKey = `${HEADER_KEY_PREFIX}:Accounts:${host}`;
  const oldAccounts = getAccountsForHost(host);
  const newAccounts = oldAccounts.filter(a => a !== account);

  writeStore(JSON.stringify(newAccounts), accountsKey);
  removeStore(headerKeyForHost(host, account));
  removeStore(statusKeyForHost(host, account));

  const remain = newAccounts.filter(Boolean);
  if (remain.length === 0) {
    removeStore(accountsKey);
    const hosts = getSavedHosts().filter(h => h !== host);
    setSavedHosts(hosts);
  }

  $notification.post("NewAPI 删除成功", host, `已删除账号：${account}`);
  $done();
} else {
  const accounts = getAccountsForHost(host);

  for (const acc of accounts) {
    removeStore(headerKeyForHost(host, acc));
    removeStore(statusKeyForHost(host, acc));
  }

  removeStore(`${HEADER_KEY_PREFIX}:Accounts:${host}`);
  removeStore(`${HEADER_KEY_PREFIX}:${host}`);
  removeStore(`${STATUS_KEY_PREFIX}:${host}:`);

  const hosts = getSavedHosts().filter(h => h !== host);
  setSavedHosts(hosts);

  $notification.post("NewAPI 删除成功", host, "已删除整个站点及其所有账号数据");
  $done();
}
