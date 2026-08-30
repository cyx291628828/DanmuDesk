#!/usr/bin/env node
/**
 * license-gen.cjs — 授权码生成工具（卖家专用，绝不打包进软件）
 *
 * 用法：
 *   1. 生成密钥对（首次，或 node scripts/license-gen.cjs genkey）
 *      → 生成 license-private-key.pem / license-public-key.pem（项目根，勿外泄/勿提交）
 *
 *   2. 生成授权码：
 *      node scripts/license-gen.cjs gen --machine XXXX-XXXX-XXXX-XXXX --days 365
 *      node scripts/license-gen.cjs gen --machine XXXX-XXXX-XXXX-XXXX --until 2027-12-31 --maxver 0.9 --name "客户微信昵称"
 *
 *      --machine  买家机器码（软件授权弹窗里复制，必填）
 *      --days     有效天数（与 --until 二选一）
 *      --until    到期日期 YYYY-MM-DD（与 --days 二选一）
 *      --maxver   可用版本上限（可选；软件版本超过它需重新授权，
 *                 抖音改版后旧破解版自然失效。如 --maxver 0.9）
 *      --name     买家备注（可选，方便自己记账）
 *
 *   3. 重新生成密钥对会作废所有已发授权码（公钥变化），慎用。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PRIV = path.join(ROOT, 'license-private-key.pem');
const PUB = path.join(ROOT, 'license-public-key.pem');

function ensureKeys() {
  if (fs.existsSync(PRIV) && fs.existsSync(PUB)) return;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(PRIV, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(PUB, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log('[gen] 已生成新密钥对：license-private-key.pem / license-public-key.pem');
  console.log('[gen] 注意：重新生成会使旧授权码全部作废。');
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'genkey') {
    ensureKeys();
    const pub = crypto.createPublicKey(fs.readFileSync(PUB));
    console.log('[gen] 公钥(SPKI DER base64，与 license.ts 内置值一致时授权才有效):');
    console.log(pub.export({ type: 'spki', format: 'der' }).toString('base64'));
    return;
  }

  if (cmd === 'gen') {
    if (!fs.existsSync(PRIV)) {
      console.error('[gen] 未找到私钥 ' + PRIV + '，先执行: node scripts/license-gen.cjs genkey');
      process.exit(1);
    }
    const a = parseArgs(rest);
    const machine = String(a.machine || '').replace(/-/g, '').toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(machine)) {
      console.error('[gen] --machine 需为软件授权弹窗显示的机器码（16 位，可带连字符）');
      process.exit(1);
    }
    let exp;
    if (a.until) {
      exp = String(a.until);
    } else if (a.days) {
      exp = new Date(Date.now() + Number(a.days) * 86400000).toISOString().slice(0, 10);
    } else {
      console.error('[gen] 需要 --days <天数> 或 --until <YYYY-MM-DD>');
      process.exit(1);
    }
    if (isNaN(new Date(exp + 'T00:00:00').getTime())) {
      console.error('[gen] 到期日期格式应为 YYYY-MM-DD');
      process.exit(1);
    }
    const payload = {
      v: 1,
      m: machine,
      e: exp,
      iat: Date.now(),
    };
    if (a.maxver) payload.mv = String(a.maxver);
    if (a.name) payload.n = String(a.name);

    const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
    const sig = crypto.sign(null, payloadBuf, fs.readFileSync(PRIV));
    const key = `DML1.${b64url(payloadBuf)}.${b64url(sig)}`;

    console.log('──────────────────────────────────────────────');
    console.log(`买家:      ${payload.n || '-'}`);
    console.log(`机器码:    ${(machine.match(/.{4}/g) || []).join('-').toUpperCase()}`);
    console.log(`到期日:    ${exp}`);
    console.log(`版本上限:  ${payload.mv || '不限'}`);
    console.log('──────────────────────────────────────────────');
    console.log('授权码（整行发给买家）:');
    console.log(key);
    return;
  }

  console.log('用法:');
  console.log('  node scripts/license-gen.cjs genkey                                  # 首次生成密钥对');
  console.log('  node scripts/license-gen.cjs gen --machine <机器码> --days 365        # 按天数授权');
  console.log('  node scripts/license-gen.cjs gen --machine <机器码> --until 2027-12-31 [--maxver 0.9] [--name 备注]');
  process.exit(cmd ? 1 : 0);
}

main();
